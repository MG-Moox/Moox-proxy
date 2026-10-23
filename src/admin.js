// Admin page: /admin (protected by ADMIN_PASSWORD, which only you know).
import { hmac, safeEqual, createLimiter, clientIp } from "./security.js";

const COOKIE = "moox_admin";
const SESSION_MS = 12 * 3600 * 1000;

function parseCookies(req) {
	const out = {};
	for (const part of String(req.headers.cookie || "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}
const json = (res, status, body, headers = {}) => {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(body));
};
function readJson(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > 20000) (reject(Object.assign(new Error("too large"), { status: 413 })), req.destroy());
			else chunks.push(c);
		});
		req.on("end", () => {
			try {
				const t = Buffer.concat(chunks).toString("utf8");
				resolve(t ? JSON.parse(t) : {});
			} catch {
				reject(Object.assign(new Error("bad json"), { status: 400 }));
			}
		});
	});
}

export function createAdmin({ password, accounts, events }) {
	const enabled = typeof password === "string" && password.length >= 10;
	const limiter = createLimiter();
	const key = enabled ? hmac(password, "moox-admin-key-v1") : "";
	let epoch = 0; // bumped on "log out everywhere"

	const makeToken = () => {
		const exp = Date.now() + SESSION_MS;
		const body = `${exp}.${epoch}`;
		return `${body}.${hmac(key, body)}`;
	};
	const validToken = (t) => {
		if (!enabled || !t) return false;
		const [exp, ep, sig] = String(t).split(".");
		if (!sig || !safeEqual(sig, hmac(key, `${exp}.${ep}`))) return false;
		return +exp > Date.now() && +ep === epoch;
	};
	const isAdmin = (req) => validToken(parseCookies(req)[COOKIE]);
	const cookie = (req, value, maxAge) => {
		const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
		return `${COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
	};

	async function api(req, res, path, ip) {
		if (path === "/admin/api/login" && req.method === "POST") {
			if (limiter.count(`ip:${ip}`, 15 * 60_000) >= 5 || limiter.count("all", 15 * 60_000) >= 30) {
				return json(res, 429, { error: "Too many attempts. Wait 15 minutes." });
			}
			const body = await readJson(req);
			if (!safeEqual(hmac(key, String(body.password || "")), hmac(key, password))) {
				limiter.hit(`ip:${ip}`, 99, 15 * 60_000);
				limiter.hit("all", 99, 15 * 60_000);
				events.log("admin_login_fail", "alert", { ip, detail: "wrong admin password" });
				return json(res, 401, { error: "Wrong password." });
			}
			events.log("admin_login_ok", "info", { ip });
			return json(res, 200, { ok: true }, { "set-cookie": cookie(req, makeToken(), SESSION_MS / 1000) });
		}
		if (!isAdmin(req)) return json(res, 401, { error: "Not logged in" });
		const write = req.method === "POST";
		if (write && req.headers["x-moox-admin"] !== "1") return json(res, 403, { error: "bad request" });
		const url = new URL(req.url, "http://x");
		const A = accounts.admin;
		const audit = (what) => events.log("admin_action", "info", { ip, detail: what });

		switch (path) {
			case "/admin/api/logout":
				epoch++;
				return json(res, 200, { ok: true }, { "set-cookie": cookie(req, "", 0) });
			case "/admin/api/overview":
				return json(res, 200, await A.stats());
			case "/admin/api/live":
				return json(res, 200, { connections: A.tracker.list().sort((a, b) => b.since - a.since) });
			case "/admin/api/users":
				return json(res, 200, { users: await A.listUsers(url.searchParams.get("q"), url.searchParams.get("guests") === "1") });
			case "/admin/api/user": {
				const b = await readJson(req);
				await A.userAction(parseInt(b.id, 10), String(b.action), b.arg);
				audit(`${b.action} user #${b.id}`);
				return json(res, 200, { ok: true });
			}
			case "/admin/api/codes":
				return json(res, 200, { codes: await A.listCodes() });
			case "/admin/api/codes/create": {
				const b = await readJson(req);
				const codes = await A.createCodes(b.count, b.days, b.note);
				audit(`generated ${codes.length} code(s)`);
				return json(res, 200, { codes });
			}
			case "/admin/api/codes/revoke": {
				const b = await readJson(req);
				await A.revokeCode(b.code);
				return json(res, 200, { ok: true });
			}
			case "/admin/api/events":
				return json(res, 200, {
					events: await A.listEvents({
						severity: url.searchParams.get("severity") || "all",
						type: url.searchParams.get("type") || "",
						limit: parseInt(url.searchParams.get("limit") || "200", 10),
					}),
				});
			case "/admin/api/ips":
				return json(res, 200, { ips: A.listIps() });
			case "/admin/api/ip": {
				const b = await readJson(req);
				if (b.action === "ban") await A.banIp(b.ip, b.reason);
				else if (b.action === "unban") await A.unbanIp(b.ip);
				else return json(res, 400, { error: "unknown action" });
				return json(res, 200, { ok: true });
			}
			case "/admin/api/signup-mode": {
				const b = await readJson(req);
				await A.setSignupMode(String(b.mode));
				return json(res, 200, { ok: true });
			}
			case "/admin/api/lockdown": {
				const b = await readJson(req);
				await A.setLockdown(Boolean(b.on));
				return json(res, 200, { ok: true });
			}
			case "/admin/api/guests": {
				const b = await readJson(req);
				await A.setGuests(Boolean(b.on));
				return json(res, 200, { ok: true });
			}
			case "/admin/api/announcement": {
				const b = await readJson(req);
				await A.setAnnouncement(b.text);
				return json(res, 200, { ok: true });
			}
			case "/admin/api/export": {
				const data = await A.exportAll();
				audit("downloaded a backup");
				return json(res, 200, data);
			}
			case "/admin/api/kick-all": {
				const n = A.kickAll();
				audit(`closed all ${n} proxy connections`);
				return json(res, 200, { ok: true, closed: n });
			}
			default:
				return json(res, 404, { error: "not found" });
		}
	}

	// Returns true if the request was for the admin area.
	function handle(req, res) {
		const url = new URL(req.url, "http://x");
		const path = url.pathname;
		if (path !== "/admin" && !path.startsWith("/admin/")) return false;
		const ip = clientIp(req);
		if (!enabled) {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("Not found");
			return true;
		}
		if (accounts.admin.bannedIps.has(ip)) {
			res.writeHead(403);
			res.end();
			return true;
		}
		if (path === "/admin" || path === "/admin/") {
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"x-frame-options": "DENY",
				"referrer-policy": "no-referrer",
				"x-robots-tag": "noindex",
			});
			res.end(ADMIN_HTML);
			return true;
		}
		api(req, res, path, ip).catch((e) => {
			if (e && e.status) return json(res, e.status, { error: e.message });
			console.error("admin error:", e && e.message);
			if (!res.headersSent) json(res, 500, { error: e && e.message ? e.message : "error" });
		});
		return true;
	}

	return { handle, enabled };
}

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Moox Admin</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#111827;--mut:#6b7280;--line:#e5e7eb;--acc:#2563eb;--bad:#dc2626;--warn:#d97706;--good:#16a34a}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e5e7eb;--mut:#9ca3af;--line:#2a2f3a;--acc:#60a5fa;--bad:#f87171;--warn:#fbbf24;--good:#4ade80}}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:center;gap:.6rem;padding:.7rem 1rem;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;flex-wrap:wrap}
header h1{font-size:1.05rem;margin:0;margin-right:auto}
nav{display:flex;gap:.3rem;flex-wrap:wrap}
button,select,input{font:inherit;color:inherit}
button{padding:.45rem .8rem;border:1px solid var(--line);background:var(--card);border-radius:6px;cursor:pointer}
button:hover{border-color:var(--acc)}
button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
button.pri{background:var(--acc);color:#fff;border-color:var(--acc)}
button.dng{color:var(--bad);border-color:var(--bad)}
button.sm{padding:.2rem .5rem;font-size:.8rem}
input,select{padding:.45rem .6rem;border:1px solid var(--line);border-radius:6px;background:var(--card)}
main{max-width:1100px;margin:1rem auto;padding:0 1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.7rem;margin-bottom:1rem}
.stat,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem 1rem}
.stat b{display:block;font-size:1.6rem}
.stat span{color:var(--mut);font-size:.85rem}
.card{margin-bottom:1rem}
.card h2{margin:.1rem 0 .7rem;font-size:1rem}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.7rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.45rem .4rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;font-size:.8rem}
.tw{overflow-x:auto}
.pill{margin:0 .3rem .2rem 0;display:inline-block;padding:.05rem .5rem;border-radius:99px;font-size:.75rem;border:1px solid var(--line)}
.pill.alert,.pill.bad{color:var(--bad);border-color:var(--bad)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.pill.good{color:var(--good);border-color:var(--good)}
.mut{color:var(--mut)}
code,.mono{font-family:ui-monospace,Menlo,monospace}
.codes{width:100%;min-height:8rem;font-family:ui-monospace,Menlo,monospace;font-size:1rem;letter-spacing:.04em}
.msg{padding:.5rem .8rem;border-radius:6px;margin-bottom:.8rem;border:1px solid var(--line)}
.msg.bad{color:var(--bad);border-color:var(--bad)}
.msg.good{color:var(--good);border-color:var(--good)}
.login{max-width:340px;margin:18vh auto;padding:0 1rem;text-align:center}
.login form{display:flex;gap:.5rem}.login input{flex:1}
.banner{background:var(--bad);color:#fff;padding:.5rem 1rem;text-align:center}
[hidden]{display:none!important}
</style></head><body>
<div id="app"></div>
<script>
"use strict";
var app = document.getElementById("app");
function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (k === "class") el.className = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  (function add(list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) add(c);
      else el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
  })(Array.prototype.slice.call(arguments, 2));
  return el;
}
function api(path, body) {
  var opt = body === undefined ? { credentials: "same-origin" } :
    { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-moox-admin": "1" }, body: JSON.stringify(body) };
  return fetch("/admin/api/" + path, opt).then(function (r) {
    return r.json().then(function (j) {
      if (r.status === 401 && path !== "login") { showLogin(); throw new Error("Not logged in"); }
      if (!r.ok) throw new Error(j.error || "Error " + r.status);
      return j;
    });
  });
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  var hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60);
  return hh ? hh + "h " + mm + "m" : mm ? mm + "m " + (s % 60) + "s" : s + "s";
}
function fmtTime(ms) { return ms ? new Date(ms).toLocaleString() : "never"; }
function fmtBytes(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB"; }
function ago(ms) { return ms ? fmtDur((Date.now() - ms) / 1000) + " ago" : "never"; }

var tab = "overview", timer = null, flash = null;

function showLogin() {
  clearInterval(timer);
  var err = h("p", { class: "mut" });
  var pw = h("input", { type: "password", placeholder: "Admin password", autocomplete: "current-password", required: true, autofocus: true });
  app.replaceChildren(h("div", { class: "login" }, h("h1", null, "Moox Admin"),
    h("form", { onsubmit: function (e) {
      e.preventDefault();
      api("login", { password: pw.value }).then(function () { start(); }).catch(function (x) { err.textContent = x.message; });
    } }, pw, h("button", { class: "pri" }, "Enter")), err));
}

function start() {
  var tabs = [["overview", "Overview"], ["live", "Live"], ["users", "Users"], ["codes", "Codes"], ["security", "Security"], ["controls", "Controls"]];
  var nav = h("nav");
  tabs.forEach(function (t) {
    nav.append(h("button", { class: tab === t[0] ? "on" : "", onclick: function () { tab = t[0]; start(); } }, t[1]));
  });
  var body = h("main");
  app.replaceChildren(
    h("header", null, h("h1", null, "Moox Admin"), nav,
      h("button", { onclick: function () { api("logout", {}).then(showLogin); } }, "Log out")),
    body);
  clearInterval(timer);
  var render = { overview: rOverview, live: rLive, users: rUsers, codes: rCodes, security: rSecurity, controls: rControls }[tab];
  render(body);
  if (tab === "overview" || tab === "live") timer = setInterval(function () { render(body); }, 5000);
}

function msg(kind, text) { return h("div", { class: "msg " + kind }, text); }
function act(fn, after) {
  return function () { fn().then(after).catch(function (e) { alert(e.message); }); };
}

// ---------- overview ----------
function rOverview(body) {
  api("overview").then(function (s) {
    var items = [
      [s.onlineUsers, "people online"], [s.connections, "live connections"], [s.users, "accounts"],
      [s.premium, "unlimited accounts"], [s.signups24h, "sign-ups (24h)"], [s.guests24h, "guests (24h)"], [s.failedLogins1h, "failed logins (1h)"],
      [s.warnings1h, "warnings (1h)"], [s.alerts24h, "alerts (24h)"], [s.banned, "suspended accounts"],
      [s.blockedIps, "blocked IPs"], [s.codesUnused, "unused codes"], [s.codesUsed, "used codes"]
    ];
    var grid = h("div", { class: "grid" });
    items.forEach(function (i) { grid.append(h("div", { class: "stat" }, h("b", null, i[0]), h("span", null, i[1]))); });
    var out = [];
    if (s.lockdown) out.push(h("div", { class: "banner" }, "LOCKDOWN is on: nobody can use the proxy. Turn it off under Controls."));
    out.push(grid, h("div", { class: "card" }, h("h2", null, "Server"),
      h("p", null, "Sign-ups: ", h("b", null, s.signupMode), " · Free time: ", s.freeMinutes + " min/day (Sydney day " + s.day + ", resets in " + fmtDur(s.resetInSeconds) + ")"),
      h("p", { class: "mut" }, "Running for " + fmtDur(s.uptimeSeconds) + " · memory " + s.memoryMb + " MB")));
    api("events?severity=alert&limit=5").then(function (e) {
      var c = h("div", { class: "card" }, h("h2", null, "Latest alerts"));
      if (!e.events.length) c.append(h("p", { class: "mut" }, "None. Nothing suspicious has been recorded."));
      e.events.forEach(function (ev) { c.append(h("p", null, h("span", { class: "pill alert" }, ev.type), " " + (ev.detail || "") + " ", h("span", { class: "mut" }, ago(ev.ts)))); });
      body.append(c);
    });
    body.replaceChildren.apply(body, out);
  }).catch(function (e) { body.replaceChildren(msg("bad", e.message)); });
}

// ---------- live ----------
function rLive(body) {
  api("live").then(function (d) {
    var t = h("table", null, h("thead", null, h("tr", null, ["Account", "IP address", "Connected", "Data moved", "Last busy", ""].map(function (x) { return h("th", null, x); }))));
    var tb = h("tbody");
    d.connections.forEach(function (c) {
      tb.append(h("tr", null, h("td", null, c.username), h("td", { class: "mono" }, c.ip), h("td", null, ago(c.since)),
        h("td", null, fmtBytes(c.bytes)), h("td", null, c.activeAt ? ago(c.activeAt) : "idle"),
        h("td", null, h("button", { class: "sm", onclick: act(function () { return api("user", { id: c.userId, action: "kick" }); }, function () { rLive(body); }) }, "Terminate"),
          " ", h("button", { class: "sm dng", onclick: function () { if (confirm("Block IP " + c.ip + "?")) act(function () { return api("ip", { action: "ban", ip: c.ip, reason: "blocked from live view" }); }, function () { rLive(body); })(); } }, "Block IP"))));
    });
    t.append(tb);
    body.replaceChildren(h("div", { class: "card" }, h("h2", null, "Live connections (" + d.connections.length + ")"),
      d.connections.length ? h("div", { class: "tw" }, t) : h("p", { class: "mut" }, "Nobody is connected right now."),
      h("p", { class: "mut" }, "Refreshes every 5 seconds. Terminate logs the account out everywhere and cuts its connections.")));
  }).catch(function (e) { body.replaceChildren(msg("bad", e.message)); });
}

// ---------- users ----------
function rUsers(body) {
  var q = h("input", { type: "search", placeholder: "Search username" });
  var gcb = h("input", { type: "checkbox", id: "showg" });
  var list = h("div");
  function load() {
    api("users?q=" + encodeURIComponent(q.value) + (gcb.checked ? "&guests=1" : "")).then(function (d) {
      var t = h("table", null, h("thead", null, h("tr", null, ["User", "Status", "Today", "Last login", "Signed up", "Actions"].map(function (x) { return h("th", null, x); }))));
      var tb = h("tbody");
      d.users.forEach(function (u) {
        var status = [];
        if (u.banned) status.push(h("span", { class: "pill bad" }, "suspended"));
        if (u.premium) status.push(h("span", { class: "pill good" }, u.forever ? "unlimited" : "unlimited until " + new Date(u.premium_until).toLocaleDateString()));
        if (u.online) status.push(h("span", { class: "pill" }, "online"));
        if (!status.length) status.push(h("span", { class: "mut" }, "free"));
        var ban = u.banned
          ? h("button", { class: "sm", onclick: act(function () { return api("user", { id: u.id, action: "unban" }); }, load) }, "Unsuspend")
          : h("button", { class: "sm dng", onclick: function () { var r = prompt("Suspend " + u.username + "? Optional reason:", ""); if (r !== null) act(function () { return api("user", { id: u.id, action: "ban", arg: r }); }, load)(); } }, "Suspend");
        tb.append(h("tr", null,
          h("td", null, h("b", null, u.username), h("div", { class: "mut mono" }, "#" + u.id + (u.guest ? " · guest" : ""))),
          h("td", null, status),
          h("td", null, fmtDur(u.today)),
          h("td", null, fmtTime(u.last_login), h("div", { class: "mut mono" }, u.last_ip || "")),
          h("td", null, fmtTime(u.created), h("div", { class: "mut mono" }, u.signup_ip || "")),
          h("td", null,
            ban, " ",
            h("button", { class: "sm", onclick: act(function () { return api("user", { id: u.id, action: "kick" }); }, load) }, "Log out"), " ",
            u.premium
              ? h("button", { class: "sm", onclick: act(function () { return api("user", { id: u.id, action: "revoke" }); }, load) }, "Remove unlimited")
              : h("button", { class: "sm", onclick: function () { var d = prompt("Give unlimited time for how many days? (0 = forever)", "0"); if (d !== null) act(function () { return api("user", { id: u.id, action: "grant", arg: d }); }, load)(); } }, "Give unlimited"), " ",
            h("button", { class: "sm", onclick: act(function () { return api("user", { id: u.id, action: "reset_usage" }); }, load) }, "Reset today"), " ",
            h("button", { class: "sm", onclick: function () { var p = prompt("New password for " + u.username + " (8+ characters):"); if (p) act(function () { return api("user", { id: u.id, action: "set_password", arg: p }); }, function () { alert("Password changed and the user was logged out."); })(); } }, "Set password"), " ",
            h("button", { class: "sm dng", onclick: function () { if (confirm("Delete " + u.username + " permanently, with their saved favorites?")) act(function () { return api("user", { id: u.id, action: "delete" }); }, load)(); } }, "Delete"))));
      });
      t.append(tb);
      list.replaceChildren(d.users.length ? h("div", { class: "tw" }, t) : h("p", { class: "mut" }, "No accounts found."));
    }).catch(function (e) { list.replaceChildren(msg("bad", e.message)); });
  }
  q.addEventListener("input", function () { clearTimeout(q._t); q._t = setTimeout(load, 250); });
  body.replaceChildren(h("div", { class: "card" }, h("h2", null, "Accounts"), h("div", { class: "row" }, q, h("label", null, gcb, " show guests"), h("button", { onclick: load }, "Refresh")), list));
  gcb.addEventListener("change", load);
  load();
}

// ---------- codes ----------
function rCodes(body) {
  var count = h("input", { type: "number", min: "1", max: "50", value: "1", style: "width:5rem" });
  var days = h("select", null,
    h("option", { value: "0" }, "Unlimited, no expiry"), h("option", { value: "7" }, "Unlimited for 7 days"),
    h("option", { value: "30" }, "Unlimited for 30 days"), h("option", { value: "90" }, "Unlimited for 90 days"), h("option", { value: "365" }, "Unlimited for 1 year"));
  var note = h("input", { placeholder: "Note, e.g. who it's for (optional)", maxlength: "80" });
  var out = h("div");
  var list = h("div");

  function show(codes) {
    var ta = h("textarea", { class: "codes", readonly: true }, codes.join("\n"));
    out.replaceChildren(h("div", { class: "card" }, h("h2", null, codes.length === 1 ? "Your new code" : "Your new codes"),
      ta,
      h("div", { class: "row" },
        h("button", { class: "pri", onclick: function () {
          (navigator.clipboard ? navigator.clipboard.writeText(codes.join("\n")) : Promise.reject()).then(function () { alert("Copied!"); }).catch(function () { ta.select(); alert("Press Ctrl+C to copy."); });
        } }, "Copy"),
        h("button", { onclick: function () {
          var links = codes.map(function (c) { return location.origin + "/login?code=" + c; }).join("\n");
          (navigator.clipboard ? navigator.clipboard.writeText(links) : Promise.reject()).then(function () { alert("Copied! Each link opens the sign-up page with the code already filled in."); }).catch(function () { alert("Couldn't copy automatically."); });
        } }, codes.length === 1 ? "Copy invite link" : "Copy invite links"),
        h("span", { class: "mut" }, "Each code works once, on one account. Send the code, or the invite link, which fills it in for them."))));
  }
  function load() {
    api("codes").then(function (d) {
      var t = h("table", null, h("thead", null, h("tr", null, ["Code", "Gives", "Status", "Note", "Made", ""].map(function (x) { return h("th", null, x); }))));
      var tb = h("tbody");
      d.codes.forEach(function (c) {
        var st = c.revoked ? h("span", { class: "pill" }, "cancelled")
          : c.redeemed_by ? h("span", { class: "pill bad" }, "used by " + (c.redeemed_name || "deleted account") + " " + ago(c.redeemed_at))
          : h("span", { class: "pill good" }, "unused");
        tb.append(h("tr", null, h("td", { class: "mono" }, c.code), h("td", null, c.premium_days ? c.premium_days + " days" : "unlimited"), h("td", null, st),
          h("td", { class: "mut" }, c.note || ""), h("td", { class: "mut" }, fmtTime(c.created)),
          h("td", null, !c.redeemed_by && !c.revoked ? [h("button", { class: "sm", onclick: function () { var l = location.origin + "/login?code=" + c.code; (navigator.clipboard ? navigator.clipboard.writeText(l) : Promise.reject()).then(function () { alert("Invite link copied."); }).catch(function () { prompt("Copy this link:", l); }); } }, "Copy link"), " ", h("button", { class: "sm", onclick: function () { if (confirm("Cancel this code?")) act(function () { return api("codes/revoke", { code: c.code }); }, load)(); } }, "Cancel")] : "")));
      });
      t.append(tb);
      list.replaceChildren(h("div", { class: "card" }, h("h2", null, "All codes"), d.codes.length ? h("div", { class: "tw" }, t) : h("p", { class: "mut" }, "No codes yet. Make one above.")));
    }).catch(function (e) { list.replaceChildren(msg("bad", e.message)); });
  }
  var gen = h("button", { class: "pri", onclick: function () {
    gen.disabled = true;
    api("codes/create", { count: +count.value || 1, days: +days.value, note: note.value }).then(function (d) { show(d.codes); load(); })
      .catch(function (e) { alert(e.message); }).then(function () { gen.disabled = false; });
  } }, "Generate");
  body.replaceChildren(
    h("div", { class: "card" }, h("h2", null, "Generate codes"),
      h("div", { class: "row" }, h("label", null, "How many ", count), days, note, gen),
      h("p", { class: "mut" }, "A code makes one account unlimited. It can be used once, ever.")),
    out, list);
  load();
}

// ---------- security ----------
function rSecurity(body) {
  var sev = h("select", null, h("option", { value: "all" }, "Everything"), h("option", { value: "alert" }, "Alerts only"), h("option", { value: "warn" }, "Warnings only"), h("option", { value: "info" }, "Info only"));
  var list = h("div");
  function load() {
    api("events?severity=" + sev.value + "&limit=300").then(function (d) {
      var t = h("table", null, h("thead", null, h("tr", null, ["When", "Level", "What", "Who", "IP", "Details", ""].map(function (x) { return h("th", null, x); }))));
      var tb = h("tbody");
      d.events.forEach(function (e) {
        tb.append(h("tr", null, h("td", { class: "mut" }, fmtTime(e.ts)), h("td", null, h("span", { class: "pill " + e.severity }, e.severity)),
          h("td", null, e.type.replace(/_/g, " ")), h("td", null, e.username || ""), h("td", { class: "mono" }, e.ip || ""), h("td", { class: "mut" }, e.detail || ""),
          h("td", null, e.ip ? h("button", { class: "sm dng", onclick: function () { if (confirm("Block IP " + e.ip + "?")) act(function () { return api("ip", { action: "ban", ip: e.ip, reason: e.type }); }, load)(); } }, "Block IP") : "")));
      });
      t.append(tb);
      list.replaceChildren(d.events.length ? h("div", { class: "tw" }, t) : h("p", { class: "mut" }, "Nothing recorded."));
    }).catch(function (e) { list.replaceChildren(msg("bad", e.message)); });
  }
  sev.addEventListener("change", load);
  body.replaceChildren(h("div", { class: "card" }, h("h2", null, "Security log"),
    h("p", { class: "mut" }, "Wrong passwords, bots, logins from many places, blocked tries, and everything you do here. This shows what the server can see; it can't tell if the hosting account itself is broken into."),
    h("div", { class: "row" }, sev, h("button", { onclick: load }, "Refresh")), list));
  load();
}

// ---------- controls ----------
function rControls(body) {
  var out = h("div");
  function load() {
    Promise.all([api("overview"), api("ips")]).then(function (r) {
      var s = r[0], ips = r[1].ips;
      var modes = [["open", "Open: anyone can sign up"], ["code", "Code only: a code is needed to sign up"], ["closed", "Closed: nobody new can sign up"]];
      var mRow = h("div", { class: "row" });
      modes.forEach(function (m) { mRow.append(h("button", { class: s.signupMode === m[0] ? "on" : "", onclick: act(function () { return api("signup-mode", { mode: m[0] }); }, load) }, m[1])); });
      var ann = h("input", { placeholder: "Message (optional)", maxlength: "200", style: "flex:1;min-width:14rem", value: s.announcement || "" });
      var ip = h("input", { placeholder: "IP address to block" }), why = h("input", { placeholder: "Reason (optional)" });
      var t = h("table"), tb = h("tbody");
      ips.forEach(function (x) {
        tb.append(h("tr", null, h("td", { class: "mono" }, x.ip), h("td", { class: "mut" }, x.reason || ""),
          h("td", null, h("button", { class: "sm", onclick: act(function () { return api("ip", { action: "unban", ip: x.ip }); }, load) }, "Unblock"))));
      });
      t.append(tb);
      out.replaceChildren(
        h("div", { class: "card" }, h("h2", null, "Emergency"),
          h("p", { class: "mut" }, "Lockdown cuts every proxy connection and stops anyone using it until you turn it off. Admin still works."),
          h("div", { class: "row" },
            s.lockdown ? h("button", { class: "pri", onclick: act(function () { return api("lockdown", { on: false }); }, load) }, "Turn lockdown OFF")
              : h("button", { class: "dng", onclick: function () { if (confirm("Cut everyone off?")) act(function () { return api("lockdown", { on: true }); }, load)(); } }, "Lockdown: cut everyone off"),
            h("button", { onclick: function () { if (confirm("Close all current connections? People can reconnect.")) act(function () { return api("kick-all", {}); }, function (d) { alert("Closed " + d.closed + " connections."); })(); } }, "Close all connections"))),
        h("div", { class: "card" }, h("h2", null, "Message to everyone"),
          h("p", { class: "mut" }, "Shows as a banner to every signed-in person, e.g. \"Back online at 5pm\". Leave empty and save to remove it."),
          h("div", { class: "row" }, ann, h("button", { class: "pri", onclick: act(function () { return api("announcement", { text: ann.value }); }, function () { alert("Saved."); }) }, "Save message"))),
        h("div", { class: "card" }, h("h2", null, "Who can sign up"), mRow),
        h("div", { class: "card" }, h("h2", null, "Guest access"),
          h("p", { class: "mut" }, "Guests get " + s.guestMinutes + " minutes a day with nothing saved, then see Log in / Sign up."),
          h("div", { class: "row" },
            h("button", { class: s.guestsEnabled ? "on" : "", onclick: act(function () { return api("guests", { on: true }); }, load) }, "Guests allowed"),
            h("button", { class: s.guestsEnabled ? "" : "on", onclick: act(function () { return api("guests", { on: false }); }, load) }, "Guests off"))),
        h("div", { class: "card" }, h("h2", null, "Backup"),
          h("p", { class: "mut" }, "Downloads a file with your accounts (no passwords), codes and blocked IPs, in case the database is ever lost."),
          h("button", { onclick: function () {
            api("export").then(function (d) {
              var a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
              a.download = "moox-admin-backup.json"; document.body.append(a); a.click(); a.remove();
            }).catch(function (e) { alert(e.message); });
          } }, "Download backup")),
        h("div", { class: "card" }, h("h2", null, "Blocked IP addresses (" + ips.length + ")"),
          h("div", { class: "row" }, ip, why, h("button", { class: "dng", onclick: act(function () { return api("ip", { action: "ban", ip: ip.value, reason: why.value }); }, load) }, "Block")),
          ips.length ? h("div", { class: "tw" }, t) : h("p", { class: "mut" }, "No blocked addresses.")));
    }).catch(function (e) { out.replaceChildren(msg("bad", e.message)); });
  }
  body.replaceChildren(out);
  load();
}

api("overview").then(start).catch(function () { showLogin(); });
</script></body></html>`;
