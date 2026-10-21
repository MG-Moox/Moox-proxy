// Cookie-based login for Moox Proxy.
//
// Why not HTTP Basic auth? Browsers are inconsistent about sending Basic
// credentials to service workers, shared workers and websockets, which this
// proxy depends on. A cookie is sent on every same-origin request, so it works
// everywhere. Basic auth is still accepted as a fallback for scripts.
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "moox_auth";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const MAX_FAILS = 10; // wrong passwords allowed per IP...
const WINDOW_MS = 15 * 60 * 1000; // ...per 15 minutes

const esc = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function safeEqual(a, b) {
	const x = Buffer.from(String(a));
	const y = Buffer.from(String(b));
	return x.length === y.length && timingSafeEqual(x, y);
}

// Only allow redirecting to a path on this site (no open redirects).
function safeNext(next) {
	if (typeof next !== "string") return "/";
	if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
	if (next === "/login" || next.startsWith("/login?") || next.startsWith("/logout")) return "/";
	return next;
}

function loginPage(error, next) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log in | Moox Proxy</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#fff;color:#111;max-width:420px;margin:18vh auto;padding:0 1rem;text-align:center}
form{display:flex;gap:.5rem}
input{flex:1;padding:.7rem;font-size:1rem;border:1px solid #888;border-radius:6px}
button{padding:.7rem 1.2rem;font-size:1rem;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
.err{color:#b91c1c;margin-top:1rem}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}input{background:#1b1b1b;color:#eee;border-color:#555}}
</style></head><body>
<h1>Moox Proxy</h1>
<form method="post" action="/login">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Log in</button>
</form>
${error ? `<p class="err">${esc(error)}</p>` : ""}
</body></html>`;
}

export function createAuth(password) {
	const enabled = Boolean(password);
	// Stateless session token: only someone who knows the password can make it,
	// it survives server restarts, and changing the password logs everyone out.
	const token = enabled
		? createHmac("sha256", password).update("moox-proxy-session-v1").digest("hex")
		: "";
	const fails = new Map(); // ip -> { count, first }

	const ipOf = (req) =>
		String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
			.split(",")[0]
			.trim();

	function limited(ip) {
		const e = fails.get(ip);
		if (!e) return false;
		if (Date.now() - e.first > WINDOW_MS) {
			fails.delete(ip);
			return false;
		}
		return e.count >= MAX_FAILS;
	}
	function recordFail(ip) {
		if (fails.size > 1000) fails.clear();
		const e = fails.get(ip);
		if (!e || Date.now() - e.first > WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
		else e.count++;
	}

	function cookiesOf(req) {
		const out = {};
		for (const part of String(req.headers.cookie || "").split(";")) {
			const i = part.indexOf("=");
			if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
		}
		return out;
	}

	function basicOk(req) {
		const h = req.headers.authorization || "";
		if (!h.startsWith("Basic ")) return false;
		const given = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
		return safeEqual(given, password);
	}

	function isAuthorized(req) {
		if (!enabled) return true;
		const c = cookiesOf(req)[COOKIE];
		if (c && safeEqual(c, token)) return true;
		return basicOk(req);
	}

	const isSecure = (req) => req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket.encrypted);
	const cookieHeader = (value, maxAge, secure) =>
		`${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

	function sendPage(res, status, error, next) {
		res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(loginPage(error, next));
	}

	function readBody(req, cb) {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > 4096) return req.destroy();
			chunks.push(c);
		});
		req.on("end", () => cb(Buffer.concat(chunks).toString()));
	}

	// Returns true if it already answered the request (login page, redirect,
	// 401), false if the request is allowed to carry on to the app.
	function handle(req, res) {
		if (!enabled) return false;
		const url = new URL(req.url, "http://localhost");

		if (url.pathname === "/login") {
			if (req.method === "POST") {
				const ip = ipOf(req);
				readBody(req, (raw) => {
					const form = new URLSearchParams(raw);
					const next = safeNext(form.get("next"));
					if (limited(ip)) return sendPage(res, 429, "Too many attempts. Try again in a few minutes.", next);
					if (safeEqual(form.get("password") || "", password)) {
						fails.delete(ip);
						res.writeHead(302, {
							Location: next,
							"Set-Cookie": cookieHeader(token, MAX_AGE, isSecure(req)),
							"cache-control": "no-store",
						});
						return res.end();
					}
					recordFail(ip);
					sendPage(res, 401, "Wrong password.", next);
				});
				return true;
			}
			const next = safeNext(url.searchParams.get("next"));
			if (isAuthorized(req)) {
				res.writeHead(302, { Location: next });
				res.end();
			} else {
				sendPage(res, 200, "", next);
			}
			return true;
		}

		if (url.pathname === "/logout") {
			res.writeHead(302, { Location: "/login", "Set-Cookie": cookieHeader("", 0, isSecure(req)) });
			res.end();
			return true;
		}

		if (isAuthorized(req)) return false;

		const wantsHtml = req.method === "GET" && String(req.headers.accept || "").includes("text/html");
		if (wantsHtml) {
			res.writeHead(302, { Location: "/login?next=" + encodeURIComponent(req.url), "cache-control": "no-store" });
			res.end();
		} else {
			res.writeHead(401, { "content-type": "text/plain" });
			res.end("Authentication required");
		}
		return true;
	}

	return { enabled, isAuthorized, handle };
}
