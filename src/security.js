// Shared helpers: password hashing, rate limits, client IP, Sydney-day maths,
// and the security event log shown on the admin page.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, createHmac } from "node:crypto";

// ---------- passwords (scrypt, salted) ----------
const N = 16384, R = 8, P = 1, KEYLEN = 32;
const scrypt = (pw, salt, n = N, r = R, p = P) =>
	new Promise((resolve, reject) =>
		scryptCb(pw, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key)))
	);

export async function hashPassword(pw) {
	const salt = randomBytes(16);
	const key = await scrypt(pw, salt);
	return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw, stored) {
	const parts = String(stored).split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [, n, r, p, salt, key] = parts;
	const want = Buffer.from(key, "base64");
	const got = await scrypt(pw, Buffer.from(salt, "base64"), +n, +r, +p);
	return got.length === want.length && timingSafeEqual(got, want);
}

// Used so an unknown username takes as long as a known one.
export const DUMMY_HASH = await hashPassword("moox-dummy-password");

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const hmac = (key, s) => createHmac("sha256", key).update(s).digest("base64url");
export function safeEqual(a, b) {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- Sydney day (usage resets at midnight Sydney time) ----------
const fmtDay = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Australia/Sydney",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});
const fmtParts = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Australia/Sydney",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
});

export const sydneyDay = (ms = Date.now()) => fmtDay.format(new Date(ms)); // "2026-10-22"

export function secondsUntilReset(ms = Date.now()) {
	const parts = Object.fromEntries(fmtParts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
	const into = +parts.hour * 3600 + +parts.minute * 60 + +parts.second;
	return 86400 - into; // (a daylight-saving change day is off by at most an hour)
}

// ---------- client IP ----------
// Render (and Cloudflare, if used) put the real visitor address in a header.
// Only trust these headers because the app is always behind such a proxy.
export function clientIp(req) {
	const h = req.headers;
	const cf = h["cf-connecting-ip"];
	if (typeof cf === "string" && cf) return cf.trim();
	const tci = h["true-client-ip"];
	if (typeof tci === "string" && tci) return tci.trim();
	const xff = h["x-forwarded-for"];
	if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
	return req.socket.remoteAddress || "unknown";
}

// ---------- rate limiting ----------
export function createLimiter() {
	const hits = new Map(); // key -> number[] timestamps
	return {
		// Record an event; returns true if it is still allowed (count <= max).
		hit(key, max, windowMs) {
			const now = Date.now();
			const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
			list.push(now);
			hits.set(key, list);
			return list.length <= max;
		},
		// How many events are currently inside the window (no recording).
		count(key, windowMs) {
			const now = Date.now();
			return (hits.get(key) || []).filter((t) => now - t < windowMs).length;
		},
		reset(key) {
			hits.delete(key);
		},
		sweep(maxAgeMs = 3600_000) {
			const now = Date.now();
			for (const [k, list] of hits) {
				if (!list.length || now - list[list.length - 1] > maxAgeMs) hits.delete(k);
			}
		},
	};
}

// ---------- security event log ----------
// Kept in memory (fast, shown live) and saved to the database (survives restarts).
export function createEvents(getDb) {
	const ring = [];
	const MAX = 500;
	return {
		log(type, severity, info = {}) {
			const ev = {
				ts: Date.now(),
				type,
				severity, // "info" | "warn" | "alert"
				ip: info.ip || null,
				user_id: info.userId ?? null,
				username: info.username || null,
				detail: info.detail ? String(info.detail).slice(0, 300) : null,
			};
			ring.push(ev);
			if (ring.length > MAX) ring.shift();
			const db = getDb();
			if (db) {
				db.exec(
					"INSERT INTO events (ts,type,severity,ip,user_id,username,detail) VALUES (?,?,?,?,?,?,?)",
					[ev.ts, ev.type, ev.severity, ev.ip, ev.user_id, ev.username, ev.detail]
				).catch(() => {});
			}
			return ev;
		},
		recent: (n = 200) => ring.slice(-n).reverse(),
		countSince(ms, pred) {
			const cut = Date.now() - ms;
			return ring.filter((e) => e.ts >= cut && pred(e)).length;
		},
	};
}
