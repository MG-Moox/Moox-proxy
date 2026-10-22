// Accounts for Moox Proxy: sign-up / log-in, sessions, the free daily time
// limit (resets at midnight Sydney time), one-time unlock codes, per-account
// data sync, live connection tracking, and the operations the admin page uses.
import { randomInt } from "node:crypto";
import {
	hashPassword,
	verifyPassword,
	DUMMY_HASH,
	sha256,
	newToken,
	createLimiter,
	sydneyDay,
	secondsUntilReset,
	clientIp,
} from "./security.js";
import { loginPage } from "./loginpage.js";

export const FOREVER = 253402300799000; // year 9999: "unlimited, no expiry"
const SESSION_MS = 30 * 24 * 3600 * 1000;
const CACHE_MS = 30_000;
const TICK_MS = 5000;
const FLUSH_MS = 30_000;
const ACTIVE_BYTES = 512; // data moved in a tick for it to count as "in use"
const MAX_CONN_PER_USER = 8;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const json = (res, status, body, headers = {}) => {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(body));
};

function readJson(req, limit = 400_000) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				reject(Object.assign(new Error("too large"), { status: 413 }));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve(text ? JSON.parse(text) : {});
			} catch {
				reject(Object.assign(new Error("bad json"), { status: 400 }));
			}
		});
		req.on("error", reject);
	});
}

function parseCookies(req) {
	const out = {};
	for (const part of String(req.headers.cookie || "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

export function safeNext(next) {
	if (typeof next !== "string") return "/";
	if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
	if (/^\/(login|logout|api|admin)(\/|\?|$)/.test(next)) return "/";
	return next;
}

export function normalizeCode(raw) {
	const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (s.length !== 16) return null;
	return s.match(/.{4}/g).join("-");
}

// Keep only plain data (no functions, no huge strings) when saving synced data.
function clean(v, depth = 0) {
	if (depth > 4) return null;
	if (typeof v === "string") return v.slice(0, 2000);
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	if (typeof v === "boolean" || v === null) return v;
	if (Array.isArray(v)) return v.slice(0, 600).map((x) => clean(x, depth + 1));
	if (v && typeof v === "object") {
		const out = {};
		for (const k of Object.keys(v).slice(0, 80)) {
			if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
			out[k] = clean(v[k], depth + 1);
		}
		return out;
	}
	return null;
}

export function createAccounts({ db, events, freeMinutes = 60, defaultSignupMode = "open" }) {
	const limiter = createLimiter();
	const FREE_SECONDS = Math.max(60, Math.round(freeMinutes * 60));

	const state = {
		signupMode: ["open", "code", "closed"].includes(defaultSignupMode) ? defaultSignupMode : "open",
		lockdown: false,
	};
	const bannedIps = new Map(); // ip -> reason
	const sessionCache = new Map(); // hash -> { user|null, exp }
	const usageMem = new Map(); // `${uid}:${day}` -> { seconds, dirty }
	const recentIps = new Map(); // uid -> [{ip, ts}]
	const warned = new Map(); // dedupe key -> ts
	const startedAt = Date.now();

	const once = (key, ms) => {
		const now = Date.now();
		if (now - (warned.get(key) || 0) < ms) return false;
		warned.set(key, now);
		return true;
	};
	const clearCache = () => sessionCache.clear();
	const isPremium = (u) => u && u.premium_until > Date.now();

	// ---------- settings & bans ----------
	async function init() {
		await db.migrate();
		const rows = (await db.exec("SELECT key,value FROM settings")).rows;
		for (const r of rows) {
			if (r.key === "signup_mode" && ["open", "code", "closed"].includes(r.value)) state.signupMode = r.value;
			if (r.key === "lockdown") state.lockdown = r.value === "1";
		}
		for (const r of (await db.exec("SELECT ip,reason FROM banned_ips")).rows) bannedIps.set(r.ip, r.reason || "");
		await maintenance();
		setInterval(() => maintenance().catch(() => {}), 6 * 3600 * 1000).unref();
		setInterval(() => limiter.sweep(), 10 * 60 * 1000).unref();
		tracker.start();
	}

	async function maintenance() {
		await db.exec("DELETE FROM sessions WHERE expires < ?", [Date.now()]);
		await db.exec("DELETE FROM events WHERE ts < ?", [Date.now() - 30 * 24 * 3600 * 1000]);
		await db.exec("DELETE FROM usage WHERE day < ?", [sydneyDay(Date.now() - 45 * 24 * 3600 * 1000)]);
	}

	async function setSetting(key, value) {
		await db.exec(
			"INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			[key, String(value)]
		);
	}

	// ---------- usage (seconds used today, Sydney time) ----------
	async function usedToday(uid) {
		const day = sydneyDay();
		const key = `${uid}:${day}`;
		let m = usageMem.get(key);
		if (!m) {
			const r = await db.exec("SELECT seconds FROM usage WHERE user_id=? AND day=?", [uid, day]);
			m = usageMem.get(key) || { seconds: r.rows[0] ? r.rows[0].seconds : 0, dirty: false };
			usageMem.set(key, m);
		}
		return m.seconds;
	}
	function addUsage(uid, secs) {
		const key = `${uid}:${sydneyDay()}`;
		const m = usageMem.get(key);
		if (m) {
			m.seconds += secs;
			m.dirty = true;
		}
	}
	async function flushUsage() {
		const today = sydneyDay();
		const dirty = [];
		for (const [key, m] of usageMem) {
			const [uid, day] = key.split(":");
			if (day !== today && !m.dirty) usageMem.delete(key); // forget old days once saved
			if (m.dirty) dirty.push([key, +uid, day, m]);
		}
		if (!dirty.length) return;
		const stmts = dirty.map(([, uid, day, m]) => [
			"INSERT INTO usage (user_id,day,seconds) VALUES (?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET seconds=excluded.seconds",
			[uid, day, m.seconds],
		]);
		await db.batch(stmts);
		for (const [, , , m] of dirty) m.dirty = false;
	}
	async function setUsage(uid, seconds) {
		const key = `${uid}:${sydneyDay()}`;
		usageMem.set(key, { seconds, dirty: false });
		await db.exec(
			"INSERT INTO usage (user_id,day,seconds) VALUES (?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET seconds=excluded.seconds",
			[uid, sydneyDay(), seconds]
		);
	}

	// ---------- live connection tracker ----------
	const tracker = (() => {
		const conns = new Map(); // id -> conn
		let nextId = 1;
		let timer = null;
		let flushTimer = null;
		let lastTick = Date.now();

		function register(user, ip, socket) {
			// Too many sockets for one account: drop the oldest (reconnect-friendly).
			const mine = [...conns.values()].filter((c) => c.user.id === user.id);
			if (mine.length >= MAX_CONN_PER_USER) {
				mine.sort((a, b) => a.since - b.since)[0].socket.destroy();
				if (once(`many:${user.id}`, 600_000))
					events.log("many_connections", "warn", { ip, userId: user.id, username: user.username, detail: `more than ${MAX_CONN_PER_USER} connections` });
			}
			const c = {
				id: nextId++,
				user: { id: user.id, username: user.username },
				ip,
				socket,
				since: Date.now(),
				lastBytes: 0,
				bytes: 0,
				activeAt: 0,
			};
			conns.set(c.id, c);
			const done = () => conns.delete(c.id);
			socket.on("close", done);
			socket.on("error", () => {});
		}

		async function tick() {
			const now = Date.now();
			const elapsed = Math.min(30, Math.round((now - lastTick) / 1000));
			lastTick = now;
			const active = new Set();
			const users = new Map();
			for (const c of conns.values()) {
				const b = (c.socket.bytesRead || 0) + (c.socket.bytesWritten || 0);
				const d = b - c.lastBytes;
				c.lastBytes = b;
				c.bytes = b;
				if (d >= ACTIVE_BYTES) {
					c.activeAt = now;
					active.add(c.user.id);
				}
				users.set(c.user.id, c.user);
			}
			for (const uid of active) addUsage(uid, elapsed);
			// Enforce the daily limit for free accounts.
			for (const [uid] of users) {
				const u = await getUserById(uid).catch(() => null);
				if (!u) continue;
				if (u.banned) kickUser(uid);
				else if (!isPremium(u) && (await usedToday(uid)) >= FREE_SECONDS) {
					kickUser(uid);
					if (once(`limit:${uid}:${sydneyDay()}`, 24 * 3600 * 1000))
						events.log("limit_reached", "info", { userId: uid, username: u.username, detail: "free daily time used up" });
				}
			}
		}

		function start() {
			timer = setInterval(() => tick().catch(() => {}), TICK_MS);
			flushTimer = setInterval(() => flushUsage().catch(() => {}), FLUSH_MS);
			timer.unref();
			flushTimer.unref();
		}
		function kickUser(uid) {
			let n = 0;
			for (const c of conns.values()) if (c.user.id === uid) (c.socket.destroy(), n++);
			return n;
		}
		function kickAll() {
			let n = 0;
			for (const c of conns.values()) (c.socket.destroy(), n++);
			return n;
		}
		function kickIp(ip) {
			let n = 0;
			for (const c of conns.values()) if (c.ip === ip) (c.socket.destroy(), n++);
			return n;
		}
		const list = () =>
			[...conns.values()].map((c) => ({
				id: c.id,
				userId: c.user.id,
				username: c.user.username,
				ip: c.ip,
				since: c.since,
				bytes: c.bytes || (c.socket.bytesRead || 0) + (c.socket.bytesWritten || 0),
				activeAt: c.activeAt,
			}));
		return { register, start, kickUser, kickAll, kickIp, list, tick, count: () => conns.size };
	})();

	// ---------- users & sessions ----------
	async function getUserById(id) {
		const r = await db.exec("SELECT * FROM users WHERE id=?", [id]);
		return r.rows[0] || null;
	}

	async function createSession(user, req, ip) {
		const token = newToken();
		await db.exec("INSERT INTO sessions (hash,user_id,created,expires,ip,ua) VALUES (?,?,?,?,?,?)", [
			sha256(token),
			user.id,
			Date.now(),
			Date.now() + SESSION_MS,
			ip,
			String(req.headers["user-agent"] || "").slice(0, 200),
		]);
		return token;
	}

	function cookieHeader(req, token, maxAge) {
		const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
		return `moox_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
	}

	// Returns the user for this request's session cookie, or null.
	async function sessionUser(req) {
		const token = parseCookies(req).moox_session;
		if (!token || token.length < 20 || token.length > 100) return null;
		const hash = sha256(token);
		const hit = sessionCache.get(hash);
		if (hit && hit.exp > Date.now()) return hit.user;
		const r = await db.exec(
			"SELECT u.*, s.expires AS s_expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=?",
			[hash]
		);
		const row = r.rows[0];
		const user = row && row.s_expires > Date.now() && !row.banned ? row : null;
		sessionCache.set(hash, { user, exp: Date.now() + (user ? CACHE_MS : 10_000) });
		return user;
	}

	function noteLoginIp(user, ip) {
		const list = (recentIps.get(user.id) || []).filter((x) => Date.now() - x.ts < 3600_000);
		list.push({ ip, ts: Date.now() });
		recentIps.set(user.id, list);
		const distinct = new Set(list.map((x) => x.ip));
		if (distinct.size >= 4 && once(`share:${user.id}`, 3600_000))
			events.log("account_sharing", "warn", { ip, userId: user.id, username: user.username, detail: `${distinct.size} different IPs in the last hour` });
	}

	// ---------- codes ----------
	function makeCode() {
		let s = "";
		for (let i = 0; i < 16; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
		return s.match(/.{4}/g).join("-");
	}
	async function createCodes(count, days, note) {
		const made = [];
		for (let i = 0; i < count; i++) {
			const code = makeCode();
			await db.exec("INSERT INTO codes (code,created,premium_days,note) VALUES (?,?,?,?)", [
				code,
				Date.now(),
				days,
				note ? String(note).slice(0, 80) : null,
			]);
			made.push(code);
		}
		return made;
	}
	// Atomically claim a code so two people can never use it at once.
	async function claimCode(raw) {
		const code = normalizeCode(raw);
		if (!code) return null;
		const r = await db.exec(
			"UPDATE codes SET redeemed_by=-1, redeemed_at=? WHERE code=? AND redeemed_by IS NULL AND revoked=0",
			[Date.now(), code]
		);
		if (r.affected !== 1) return null;
		const row = (await db.exec("SELECT premium_days FROM codes WHERE code=?", [code])).rows[0];
		return { code, days: row ? row.premium_days : 0 };
	}
	const finishCode = (code, uid) => db.exec("UPDATE codes SET redeemed_by=? WHERE code=?", [uid, code]);
	const releaseCode = (code) =>
		db.exec("UPDATE codes SET redeemed_by=NULL, redeemed_at=NULL WHERE code=? AND redeemed_by=-1", [code]);

	async function grantPremium(uid, days) {
		const u = await getUserById(uid);
		if (!u) return null;
		let until;
		if (days === 0 || u.premium_until >= FOREVER) until = FOREVER;
		else until = Math.max(u.premium_until, Date.now()) + days * 86400_000;
		await db.exec("UPDATE users SET premium_until=? WHERE id=?", [until, uid]);
		clearCache();
		return until;
	}

	// ---------- the "me" payload ----------
	async function mePayload(user) {
		const premium = isPremium(user);
		const used = await usedToday(user.id);
		return {
			username: user.username,
			premium,
			premiumUntil: premium ? (user.premium_until >= FOREVER ? "never" : user.premium_until) : null,
			limitSeconds: premium ? null : FREE_SECONDS,
			usedSeconds: Math.min(used, premium ? used : FREE_SECONDS),
			remainingSeconds: premium ? null : Math.max(0, FREE_SECONDS - used),
			resetInSeconds: secondsUntilReset(),
			limited: !premium && used >= FREE_SECONDS,
			day: sydneyDay(),
		};
	}

	// ---------- HTTP: the account API and the gate ----------
	const isPublic = (p) => p === "/manifest.webmanifest" || p.startsWith("/icons/");

	function blockedPage(res, status, title, text) {
		res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:480px;margin:20vh auto;padding:0 1rem;text-align:center"><h1>${title}</h1><p>${text}</p>`);
	}

	async function apiLogin(req, res, ip) {
		const body = await readJson(req);
		const username = String(body.username || "").trim();
		const password = String(body.password || "");
		const ipKey = `lf:ip:${ip}`;
		const userKey = `lf:u:${username.toLowerCase()}`;
		if (limiter.count(ipKey, 15 * 60_000) >= 10 || limiter.count(userKey, 15 * 60_000) >= 30) {
			if (once(`lockout:${ip}`, 600_000)) events.log("login_locked", "warn", { ip, username, detail: "too many wrong passwords" });
			return json(res, 429, { error: "Too many attempts. Please wait 15 minutes." });
		}
		const row = username ? (await db.exec("SELECT * FROM users WHERE username=?", [username])).rows[0] : null;
		const ok = await verifyPassword(password, row ? row.pass : DUMMY_HASH);
		if (!row || !ok) {
			limiter.hit(ipKey, 99, 15 * 60_000);
			limiter.hit(userKey, 99, 15 * 60_000);
			events.log("login_fail", "info", { ip, username, userId: row ? row.id : null, detail: row ? "wrong password" : "unknown user" });
			const burst = limiter.count(`lfall`, 600_000);
			limiter.hit("lfall", 99999, 600_000);
			if (burst >= 40 && once("loginstorm", 900_000))
				events.log("login_storm", "alert", { ip, detail: "40+ failed logins in 10 minutes (someone may be guessing passwords)" });
			return json(res, 401, { error: "Wrong username or password." });
		}
		if (row.banned) {
			events.log("login_banned", "info", { ip, userId: row.id, username: row.username });
			return json(res, 403, { error: "This account has been suspended." + (row.ban_reason ? " Reason: " + row.ban_reason : "") });
		}
		limiter.reset(ipKey);
		const token = await createSession(row, req, ip);
		await db.exec("UPDATE users SET last_login=?, last_ip=? WHERE id=?", [Date.now(), ip, row.id]);
		noteLoginIp(row, ip);
		events.log("login_ok", "info", { ip, userId: row.id, username: row.username });
		json(res, 200, { ok: true, next: safeNext(body.next) }, { "set-cookie": cookieHeader(req, token, SESSION_MS / 1000) });
	}

	async function apiSignup(req, res, ip) {
		const body = await readJson(req);
		if (body.website) {
			events.log("honeypot", "warn", { ip, detail: "signup form hidden field was filled (bot)" });
			return json(res, 200, { ok: true, next: "/" }); // pretend success to the bot
		}
		if (state.signupMode === "closed") return json(res, 403, { error: "Sign-ups are closed right now." });
		if (!limiter.hit(`su:ip:${ip}`, 5, 3600_000)) {
			events.log("signup_blocked", "warn", { ip, detail: "more than 5 sign-ups from one IP in an hour" });
			return json(res, 429, { error: "Too many sign-ups from your network. Try again later." });
		}
		if (!limiter.hit("su:all", 100, 3600_000)) {
			if (once("signup_flood", 900_000)) events.log("signup_flood", "alert", { ip, detail: "100+ sign-ups in an hour; consider switching sign-ups to code-only" });
			return json(res, 429, { error: "Lots of people are signing up right now. Try again soon." });
		}
		const username = String(body.username || "").trim();
		const password = String(body.password || "");
		if (!USERNAME_RE.test(username)) return json(res, 400, { error: "Username must be 3-20 letters, numbers or underscores." });
		if (password.length < 8 || password.length > 200) return json(res, 400, { error: "Password must be at least 8 characters." });
		if (/^(.)\1+$/.test(password) || password.toLowerCase() === username.toLowerCase())
			return json(res, 400, { error: "Please choose a stronger password." });

		const rawCode = String(body.code || "").trim();
		let claimed = null;
		if (rawCode || state.signupMode === "code") {
			if (!rawCode) return json(res, 400, { error: "Sign-up needs an access code." });
			claimed = await claimCode(rawCode);
			if (!claimed) {
				events.log("code_fail", "info", { ip, username, detail: "bad or used code at sign-up" });
				return json(res, 400, { error: "That code isn't valid or has already been used." });
			}
		}
		try {
			const pass = await hashPassword(password);
			let r;
			try {
				r = await db.exec(
					"INSERT INTO users (username,pass,created,last_login,last_ip,signup_ip) VALUES (?,?,?,?,?,?)",
					[username, pass, Date.now(), Date.now(), ip, ip]
				);
			} catch (e) {
				if (claimed) await releaseCode(claimed.code).catch(() => {});
				if (/UNIQUE/i.test(e.message)) return json(res, 409, { error: "That username is taken." });
				throw e;
			}
			const user = { id: r.lastId, username };
			if (claimed) {
				await finishCode(claimed.code, user.id);
				await grantPremium(user.id, claimed.days);
				events.log("code_redeemed", "info", { ip, userId: user.id, username, detail: claimed.code + " (at sign-up)" });
			}
			const token = await createSession(user, req, ip);
			events.log("signup", "info", { ip, userId: user.id, username });
			json(res, 200, { ok: true, next: safeNext(body.next) }, { "set-cookie": cookieHeader(req, token, SESSION_MS / 1000) });
		} catch (e) {
			if (claimed) await releaseCode(claimed.code).catch(() => {});
			throw e;
		}
	}

	async function apiRedeem(req, res, ip, user) {
		const body = await readJson(req, 2000);
		if (limiter.count(`rd:${user.id}`, 15 * 60_000) >= 8 || limiter.count(`rd:ip:${ip}`, 15 * 60_000) >= 15)
			return json(res, 429, { error: "Too many wrong codes. Wait 15 minutes." });
		const claimed = await claimCode(body.code);
		if (!claimed) {
			limiter.hit(`rd:${user.id}`, 99, 15 * 60_000);
			limiter.hit(`rd:ip:${ip}`, 99, 15 * 60_000);
			events.log("code_fail", "info", { ip, userId: user.id, username: user.username, detail: "bad or used code" });
			return json(res, 400, { error: "That code isn't valid or has already been used." });
		}
		await finishCode(claimed.code, user.id);
		await grantPremium(user.id, claimed.days);
		events.log("code_redeemed", "info", { ip, userId: user.id, username: user.username, detail: claimed.code });
		const fresh = await getUserById(user.id);
		json(res, 200, { ok: true, me: await mePayload(fresh) });
	}

	async function apiPassword(req, res, ip, user) {
		const body = await readJson(req, 2000);
		const row = await getUserById(user.id);
		if (limiter.count(`pw:${user.id}`, 15 * 60_000) >= 8) return json(res, 429, { error: "Too many attempts. Wait 15 minutes." });
		if (!(await verifyPassword(String(body.old || ""), row.pass))) {
			limiter.hit(`pw:${user.id}`, 99, 15 * 60_000);
			return json(res, 400, { error: "Your current password is wrong." });
		}
		const next = String(body.next || "");
		if (next.length < 8 || next.length > 200) return json(res, 400, { error: "New password must be at least 8 characters." });
		await db.exec("UPDATE users SET pass=? WHERE id=?", [await hashPassword(next), user.id]);
		// Log out everywhere except this device.
		const keep = sha256(parseCookies(req).moox_session || "");
		await db.exec("DELETE FROM sessions WHERE user_id=? AND hash<>?", [user.id, keep]);
		clearCache();
		events.log("password_changed", "info", { ip, userId: user.id, username: user.username });
		json(res, 200, { ok: true });
	}

	async function apiData(req, res, user) {
		if (req.method === "GET") {
			const r = (await db.exec("SELECT json,updated FROM user_data WHERE user_id=?", [user.id])).rows[0];
			return json(res, 200, r ? { data: JSON.parse(r.json), updated: r.updated } : { data: null, updated: 0 });
		}
		const body = await readJson(req);
		const d = body && typeof body.data === "object" && body.data ? body.data : null;
		if (!d) return json(res, 400, { error: "bad data" });
		const out = {
			favorites: Array.isArray(d.favorites) ? clean(d.favorites) : [],
			history: Array.isArray(d.history) ? clean(d.history) : [],
			settings: d.settings && typeof d.settings === "object" ? clean(d.settings) : {},
		};
		const text = JSON.stringify(out);
		if (text.length > 300_000) return json(res, 413, { error: "too large" });
		const updated = Date.now();
		await db.exec(
			"INSERT INTO user_data (user_id,json,updated) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated=excluded.updated",
			[user.id, text, updated]
		);
		json(res, 200, { ok: true, updated });
	}

	// Handles account pages/APIs and decides who may see the proxy site itself.
	// Resolves to the signed-in user when the request should carry on to the
	// normal site, or null when a response has already been sent.
	async function gate(req, res) {
		const ip = clientIp(req);
		const url = new URL(req.url, "http://x");
		const path = url.pathname;
		try {
			if (bannedIps.has(ip)) {
				blockedPage(res, 403, "Access blocked", "This network address has been blocked.");
				return null;
			}
			const isApiWrite = req.method === "POST" || req.method === "PUT";
			if (isApiWrite && path.startsWith("/api/") && !/application\/json/i.test(req.headers["content-type"] || "")) {
				json(res, 415, { error: "JSON only" });
				return null;
			}

			// ---- pages that need no login ----
			if (path === "/api/public" && req.method === "GET") {
				json(res, 200, { signupMode: state.signupMode, freeMinutes: Math.round(FREE_SECONDS / 60) });
				return null;
			}
			if (path === "/api/login" && req.method === "POST") return (await apiLogin(req, res, ip), null);
			if (path === "/api/signup" && req.method === "POST") return (await apiSignup(req, res, ip), null);
			if (path === "/logout") {
				const token = parseCookies(req).moox_session;
				if (token) await db.exec("DELETE FROM sessions WHERE hash=?", [sha256(token)]).catch(() => {});
				clearCache();
				res.writeHead(302, { location: "/login", "set-cookie": cookieHeader(req, "", 0) });
				res.end();
				return null;
			}
			if (isPublic(path)) return { id: 0, username: "", public: true };

			const user = await sessionUser(req);

			if (path === "/login") {
				if (user) {
					res.writeHead(302, { location: safeNext(url.searchParams.get("next")) });
					return res.end(), null;
				}
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(loginPage(safeNext(url.searchParams.get("next")), state.signupMode, Math.round(FREE_SECONDS / 60)));
				return null;
			}

			if (!user) {
				const wantsHtml = req.method === "GET" && String(req.headers.accept || "").includes("text/html");
				if (wantsHtml) {
					res.writeHead(302, { location: "/login?next=" + encodeURIComponent(req.url) });
					res.end();
				} else if (path.startsWith("/api/")) json(res, 401, { error: "Not signed in" });
				else {
					res.writeHead(401, { "content-type": "text/plain" });
					res.end("Not signed in");
				}
				return null;
			}

			// ---- signed-in APIs ----
			if (path === "/api/me" && req.method === "GET") return (json(res, 200, await mePayload(user)), null);
			if (path === "/api/redeem" && req.method === "POST") return (await apiRedeem(req, res, ip, user), null);
			if (path === "/api/password" && req.method === "POST") return (await apiPassword(req, res, ip, user), null);
			if (path === "/api/data" && (req.method === "GET" || req.method === "PUT")) return (await apiData(req, res, user), null);
			if (path.startsWith("/api/")) return (json(res, 404, { error: "not found" }), null);

			if (state.lockdown) {
				blockedPage(res, 503, "Down for maintenance", "The proxy is paused for a moment. Please try again soon.");
				return null;
			}
			return user;
		} catch (e) {
			if (e && e.status) json(res, e.status, { error: e.message });
			else {
				console.error("accounts error:", e && e.message);
				if (!res.headersSent) json(res, 503, { error: "The account service is busy. Try again in a moment." });
				else res.end();
			}
			return null;
		}
	}

	// Decides whether a websocket may open the Wisp tunnel.
	// Resolves { ok:true, user, ip } or { ok:false, status, reason }.
	async function authorizeUpgrade(req) {
		const ip = clientIp(req);
		try {
			if (bannedIps.has(ip)) return { ok: false, status: 403 };
			const user = await sessionUser(req);
			if (!user) {
				if (once(`noauth:${ip}`, 300_000))
					events.log("wisp_noauth", "warn", { ip, detail: "tried to open the proxy tunnel without being logged in" });
				return { ok: false, status: 401 };
			}
			if (state.lockdown) return { ok: false, status: 503 };
			if (!isPremium(user) && (await usedToday(user.id)) >= FREE_SECONDS) return { ok: false, status: 429 };
			return { ok: true, user, ip };
		} catch {
			return { ok: false, status: 503 };
		}
	}

	// ---------- admin operations ----------
	const admin = {
		state,
		bannedIps,
		tracker,
		startedAt,
		freeSeconds: FREE_SECONDS,

		async stats() {
			const now = Date.now();
			const rs = await db.batch([
				["SELECT COUNT(*) AS n FROM users", []],
				["SELECT COUNT(*) AS n FROM users WHERE premium_until > ?", [now]],
				["SELECT COUNT(*) AS n FROM users WHERE banned=1", []],
				["SELECT COUNT(*) AS n FROM users WHERE created > ?", [now - 86400_000]],
				["SELECT COUNT(*) AS n FROM codes WHERE redeemed_by IS NULL AND revoked=0", []],
				["SELECT COUNT(*) AS n FROM codes WHERE redeemed_by IS NOT NULL AND redeemed_by <> -1", []],
			]);
			const conns = tracker.list();
			const hour = 3600_000;
			return {
				users: rs[0].rows[0].n,
				premium: rs[1].rows[0].n,
				banned: rs[2].rows[0].n,
				signups24h: rs[3].rows[0].n,
				codesUnused: rs[4].rows[0].n,
				codesUsed: rs[5].rows[0].n,
				connections: conns.length,
				onlineUsers: new Set(conns.map((c) => c.userId)).size,
				failedLogins1h: events.countSince(hour, (e) => e.type === "login_fail"),
				warnings1h: events.countSince(hour, (e) => e.severity === "warn"),
				alerts24h: events.countSince(24 * hour, (e) => e.severity === "alert"),
				blockedIps: bannedIps.size,
				signupMode: state.signupMode,
				lockdown: state.lockdown,
				freeMinutes: Math.round(FREE_SECONDS / 60),
				uptimeSeconds: Math.round((now - startedAt) / 1000),
				memoryMb: Math.round(process.memoryUsage().rss / 1048576),
				day: sydneyDay(),
				resetInSeconds: secondsUntilReset(),
			};
		},

		async listUsers(q) {
			const like = "%" + String(q || "").replace(/[^A-Za-z0-9_]/g, "") + "%";
			const rows = (
				await db.exec(
					`SELECT u.id,u.username,u.created,u.banned,u.ban_reason,u.premium_until,u.last_login,u.last_ip,u.signup_ip,
					 (SELECT seconds FROM usage WHERE user_id=u.id AND day=?) AS today,
					 (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires>?) AS sessions
					 FROM users u WHERE u.username LIKE ? ORDER BY u.id DESC LIMIT 200`,
					[sydneyDay(), Date.now(), like]
				)
			).rows;
			const day = sydneyDay();
			const live = tracker.list();
			return rows.map((u) => {
				const mem = usageMem.get(`${u.id}:${day}`);
				return {
					...u,
					today: mem ? mem.seconds : u.today || 0,
					premium: u.premium_until > Date.now(),
					forever: u.premium_until >= FOREVER,
					online: live.some((c) => c.userId === u.id),
				};
			});
		},

		async userAction(id, action, arg, actor) {
			const u = await getUserById(id);
			if (!u) throw Object.assign(new Error("no such user"), { status: 404 });
			const who = { userId: u.id, username: u.username, detail: `by admin` };
			switch (action) {
				case "ban": {
					const reason = String(arg || "").slice(0, 120);
					await db.exec("UPDATE users SET banned=1, ban_reason=? WHERE id=?", [reason || null, id]);
					await db.exec("DELETE FROM sessions WHERE user_id=?", [id]);
					clearCache();
					tracker.kickUser(id);
					events.log("user_banned", "alert", { ...who, detail: `banned by admin${reason ? ": " + reason : ""}` });
					break;
				}
				case "unban":
					await db.exec("UPDATE users SET banned=0, ban_reason=NULL WHERE id=?", [id]);
					clearCache();
					events.log("user_unbanned", "info", who);
					break;
				case "kick":
					await db.exec("DELETE FROM sessions WHERE user_id=?", [id]);
					clearCache();
					tracker.kickUser(id);
					events.log("user_kicked", "info", { ...who, detail: "logged out everywhere by admin" });
					break;
				case "delete":
					tracker.kickUser(id);
					await db.batch([
						["DELETE FROM sessions WHERE user_id=?", [id]],
						["DELETE FROM user_data WHERE user_id=?", [id]],
						["DELETE FROM usage WHERE user_id=?", [id]],
						["DELETE FROM users WHERE id=?", [id]],
					]);
					clearCache();
					events.log("user_deleted", "alert", { ...who, detail: "account deleted by admin" });
					break;
				case "grant": {
					const days = Math.max(0, Math.min(3650, parseInt(arg, 10) || 0));
					await grantPremium(id, days);
					events.log("premium_granted", "info", { ...who, detail: days ? `${days} days` : "unlimited" });
					break;
				}
				case "revoke":
					await db.exec("UPDATE users SET premium_until=0 WHERE id=?", [id]);
					clearCache();
					events.log("premium_revoked", "info", who);
					break;
				case "reset_usage":
					await setUsage(id, 0);
					events.log("usage_reset", "info", who);
					break;
				case "set_password": {
					const pw = String(arg || "");
					if (pw.length < 8 || pw.length > 200) throw Object.assign(new Error("password must be 8+ characters"), { status: 400 });
					await db.exec("UPDATE users SET pass=? WHERE id=?", [await hashPassword(pw), id]);
					await db.exec("DELETE FROM sessions WHERE user_id=?", [id]);
					clearCache();
					tracker.kickUser(id);
					events.log("password_reset", "info", { ...who, detail: "password set by admin" });
					break;
				}
				default:
					throw Object.assign(new Error("unknown action"), { status: 400 });
			}
		},

		async listCodes() {
			return (
				await db.exec(
					`SELECT c.code,c.created,c.premium_days,c.note,c.redeemed_by,c.redeemed_at,c.revoked,u.username AS redeemed_name
					 FROM codes c LEFT JOIN users u ON u.id=c.redeemed_by ORDER BY c.created DESC LIMIT 300`
				)
			).rows;
		},
		async createCodes(count, days, note) {
			const n = Math.max(1, Math.min(50, parseInt(count, 10) || 1));
			const d = Math.max(0, Math.min(3650, parseInt(days, 10) || 0));
			const codes = await createCodes(n, d, note);
			events.log("codes_created", "info", { detail: `${n} code(s), ${d ? d + " days" : "unlimited"}` });
			return codes;
		},
		async revokeCode(code) {
			const c = normalizeCode(code);
			if (!c) throw Object.assign(new Error("bad code"), { status: 400 });
			const r = await db.exec("UPDATE codes SET revoked=1 WHERE code=? AND redeemed_by IS NULL", [c]);
			if (r.affected !== 1) throw Object.assign(new Error("code already used or missing"), { status: 400 });
			events.log("code_revoked", "info", { detail: c });
		},

		async listEvents({ severity, type, limit = 200 } = {}) {
			const where = [];
			const args = [];
			if (severity && severity !== "all") (where.push("severity=?"), args.push(severity));
			if (type) (where.push("type=?"), args.push(String(type).slice(0, 40)));
			args.push(Math.max(1, Math.min(500, limit | 0)));
			return (await db.exec(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, args)).rows;
		},

		listIps: () => [...bannedIps].map(([ip, reason]) => ({ ip, reason })),
		async banIp(ip, reason) {
			ip = String(ip || "").trim();
			if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw Object.assign(new Error("that doesn't look like an IP address"), { status: 400 });
			await db.exec("INSERT INTO banned_ips (ip,reason,created) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason", [ip, reason ? String(reason).slice(0, 120) : null, Date.now()]);
			bannedIps.set(ip, reason || "");
			tracker.kickIp(ip);
			events.log("ip_blocked", "alert", { ip, detail: reason ? "blocked by admin: " + reason : "blocked by admin" });
		},
		async unbanIp(ip) {
			await db.exec("DELETE FROM banned_ips WHERE ip=?", [String(ip)]);
			bannedIps.delete(String(ip));
			events.log("ip_unblocked", "info", { ip: String(ip) });
		},

		async setSignupMode(mode) {
			if (!["open", "code", "closed"].includes(mode)) throw Object.assign(new Error("bad mode"), { status: 400 });
			state.signupMode = mode;
			await setSetting("signup_mode", mode);
			events.log("signup_mode", "info", { detail: "sign-ups set to " + mode });
		},
		async setLockdown(on) {
			state.lockdown = Boolean(on);
			await setSetting("lockdown", on ? "1" : "0");
			if (on) tracker.kickAll();
			events.log("lockdown", on ? "alert" : "info", { detail: on ? "lockdown ON: all proxy connections closed" : "lockdown off" });
		},
		kickAll: () => tracker.kickAll(),
	};

	return { init, gate, authorizeUpgrade, tracker, admin, state, flushUsage, clearCache };
}
