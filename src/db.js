// Tiny Turso (libSQL) client that talks to the database over HTTPS using the
// built-in fetch, so no extra npm package is needed.
//
//   TURSO_DATABASE_URL   e.g. libsql://moox-yourname.turso.io
//   TURSO_AUTH_TOKEN     a token created for that database
//
// Protocol: POST <url>/v2/pipeline with {requests:[{type:"execute",stmt:{sql,args}}, {type:"close"}]}.

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE COLLATE NOCASE,
		pass TEXT NOT NULL,
		created INTEGER NOT NULL,
		banned INTEGER NOT NULL DEFAULT 0,
		ban_reason TEXT,
		premium_until INTEGER NOT NULL DEFAULT 0,
		last_login INTEGER,
		last_ip TEXT,
		signup_ip TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		hash TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL,
		created INTEGER NOT NULL,
		expires INTEGER NOT NULL,
		ip TEXT,
		ua TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
	`CREATE TABLE IF NOT EXISTS usage (
		user_id INTEGER NOT NULL,
		day TEXT NOT NULL,
		seconds INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, day)
	)`,
	`CREATE TABLE IF NOT EXISTS codes (
		code TEXT PRIMARY KEY,
		created INTEGER NOT NULL,
		premium_days INTEGER NOT NULL DEFAULT 0,
		note TEXT,
		redeemed_by INTEGER,
		redeemed_at INTEGER,
		revoked INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS user_data (
		user_id INTEGER PRIMARY KEY,
		json TEXT NOT NULL,
		updated INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts INTEGER NOT NULL,
		type TEXT NOT NULL,
		severity TEXT NOT NULL,
		ip TEXT,
		user_id INTEGER,
		username TEXT,
		detail TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS events_ts ON events(ts)`,
	`CREATE TABLE IF NOT EXISTS banned_ips (
		ip TEXT PRIMARY KEY,
		reason TEXT,
		created INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT
	)`,
];

function encode(v) {
	if (v === null || v === undefined) return { type: "null" };
	if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
	if (typeof v === "bigint") return { type: "integer", value: v.toString() };
	if (typeof v === "number") {
		return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
	}
	return { type: "text", value: String(v) };
}

function decode(cell) {
	if (!cell || cell.type === "null") return null;
	if (cell.type === "integer") return Number(cell.value);
	if (cell.type === "float") return Number(cell.value);
	return cell.value; // text, or base64 for blobs (unused here)
}

function shape(result) {
	const cols = (result.cols || []).map((c) => c.name);
	const rows = (result.rows || []).map((r) => Object.fromEntries(cols.map((c, i) => [c, decode(r[i])])));
	return {
		rows,
		affected: Number(result.affected_row_count || 0),
		lastId: result.last_insert_rowid == null ? null : Number(result.last_insert_rowid),
	};
}

export function createDb({ url, token, timeoutMs = 8000 }) {
	const base = String(url).trim().replace(/^libsql:\/\//, "https://").replace(/\/+$/, "");
	const endpoint = base + "/v2/pipeline";

	async function pipeline(stmts) {
		const requests = stmts.map(([sql, args]) => ({
			type: "execute",
			stmt: { sql, args: (args || []).map(encode), want_rows: true },
		}));
		requests.push({ type: "close" });
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ requests }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`database HTTP ${res.status} ${text.slice(0, 200)}`);
		}
		const body = await res.json();
		const out = [];
		for (let i = 0; i < stmts.length; i++) {
			const r = body.results && body.results[i];
			if (!r) throw new Error("database returned too few results");
			if (r.type === "error") throw new Error("database: " + (r.error && r.error.message ? r.error.message : "error"));
			out.push(shape(r.response.result));
		}
		return out;
	}

	return {
		// One statement. Returns {rows, affected, lastId}.
		async exec(sql, args = []) {
			return (await pipeline([[sql, args]]))[0];
		},
		// Several independent statements in one round trip (not atomic).
		batch: (stmts) => pipeline(stmts),
		async migrate() {
			await pipeline(SCHEMA.map((s) => [s, []]));
			// Added later: marks guest accounts. Ignore "duplicate column" on existing databases.
			try {
				await pipeline([["ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0", []]]);
			} catch (e) {
				if (!/duplicate column/i.test(e.message)) throw e;
			}
		},
	};
}
