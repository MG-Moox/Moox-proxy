// Moox Proxy: a Scramjet-powered web proxy.
//
// How it fits together:
//   browser  --(service worker, Scramjet)-->  /wisp/ websocket  -->  the internet
// This server only hosts the static files, the Scramjet/BareMux/libcurl bundles
// and the Wisp websocket endpoint. All page rewriting happens in the browser.
//
// Env vars:
//   PORT            port to listen on (default 8080)
//   PROXY_PASSWORD  if set, require a login (cookie) for the site AND the Wisp
//                   endpoint. Strongly recommended when public.
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
//                   turn on ACCOUNTS (sign-up, daily limit, codes, admin page).
//                   When set, PROXY_PASSWORD is not used.
//   ADMIN_PASSWORD  password for /admin (10+ characters). Admin is off if unset.
//   SIGNUP_MODE     open | code | closed (default open; changeable in /admin)
//   FREE_MINUTES    free minutes per day (default 60)
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
import { createIcons } from "./icons.js";
import { createSuggest } from "./suggest.js";
import { createDb } from "./db.js";
import { createEvents } from "./security.js";
import { createAccounts } from "./accounts.js";
import { createAdmin } from "./admin.js";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const PASSWORD = process.env.PROXY_PASSWORD || "";

// ---------- Wisp configuration ----------
// Keep the proxy away from internal networks (SSRF protection). The explicit
// flags are the primary guard; the regex blacklist is a second layer in case a
// wisp-js version ignores an option name.
logging.set_level(logging.NONE);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	allow_private_ips: false,
	allow_loopback_ips: false,
	hostname_blacklist: [
		/^localhost$/i,
		/\.localhost$/i,
		/\.internal$/i,
		/^127\./,
		/^10\./,
		/^192\.168\./,
		/^172\.(1[6-9]|2\d|3[01])\./,
		/^169\.254\./,
		/^0\./,
		/^\[?(::1?|f[cd][0-9a-f]{2}:|fe80:)/i,
	],
	dns_servers: ["1.1.1.3", "1.0.0.3"],
});

// ---------- Auth (login page + cookie, see auth.js) ----------
const auth = createAuth(PASSWORD);
const icons = createIcons();
const suggest = createSuggest();

// ---------- Accounts (optional) ----------
const ACCOUNTS_ON = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
let db = null;
const events = createEvents(() => db);
let accounts = null;
let admin = null;
if (ACCOUNTS_ON) {
	db = createDb({ url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN });
	accounts = createAccounts({
		db,
		events,
		freeMinutes: parseFloat(process.env.FREE_MINUTES || "60") || 60,
		defaultSignupMode: process.env.SIGNUP_MODE || "open",
	});
	admin = createAdmin({ password: process.env.ADMIN_PASSWORD || "", accounts, events });
}

const fail500 = (res) => () => {
	if (!res.headersSent) res.writeHead(500);
	res.end();
};

// Everything after login: favicons, suggestions, then the static site.
function serve(req, res, handler) {
	if (req.url.startsWith("/icon?")) return void icons.handle(req, res).catch(fail500(res));
	if (req.url.startsWith("/suggest?")) return void suggest.handle(req, res).catch(fail500(res));
	// Scramjet needs cross-origin isolation.
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	handler(req, res);
}

// ---------- Server ----------
const fastify = Fastify({
	serverFactory: (handler) =>
		createServer()
			.on("request", (req, res) => {
				// Health check for uptime pings; needs no password and reveals nothing.
				if (req.url === "/health") {
					res.writeHead(200, { "content-type": "text/plain" });
					return res.end("ok");
				}
				if (ACCOUNTS_ON) {
					if (admin.handle(req, res)) return;
					accounts
						.gate(req, res)
						.then((user) => {
							if (user) serve(req, res, handler);
						})
						.catch(fail500(res));
					return;
				}
				// Serves /login and /logout, and redirects or rejects anyone not logged in.
				if (auth.handle(req, res)) return;
				serve(req, res, handler);
			})
			.on("upgrade", async (req, socket, head) => {
				if (!req.url.endsWith("/wisp/")) return socket.end();
				if (!ACCOUNTS_ON) {
					if (!auth.isAuthorized(req)) return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
					return wisp.routeRequest(req, socket, head);
				}
				socket.on("error", () => {});
				const r = await accounts.authorizeUpgrade(req);
				if (socket.destroyed) return;
				if (!r.ok) return socket.end(`HTTP/1.1 ${r.status} Refused\r\nconnection: close\r\n\r\n`);
				accounts.tracker.register(r.user, r.ip, socket);
				wisp.routeRequest(req, socket, head);
			}),
});

fastify.register(fastifyStatic, { root: publicPath, decorateReply: true });
fastify.register(fastifyStatic, { root: scramjetPath, prefix: "/scram/", decorateReply: false });
fastify.register(fastifyStatic, { root: libcurlPath, prefix: "/libcurl/", decorateReply: false });
fastify.register(fastifyStatic, { root: baremuxPath, prefix: "/baremux/", decorateReply: false });

fastify.setNotFoundHandler((_req, reply) =>
	reply.code(404).type("text/html").sendFile("404.html")
);

const shutdown = () => {
	fastify.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

let port = parseInt(process.env.PORT || "", 10);
if (Number.isNaN(port)) port = 8080;

(async () => {
	if (ACCOUNTS_ON) {
		await accounts.init(); // creates the tables on first run
		console.log("Accounts: ON (database connected)");
		if (!admin.enabled) console.warn("ADMIN_PASSWORD is not set (or shorter than 10 characters): the admin page is OFF.");
	}
	await fastify.listen({ port, host: "0.0.0.0" });
	console.log(`Moox Proxy (Scramjet) running at http://localhost:${port}`);
	if (!ACCOUNTS_ON && !PASSWORD) console.warn("WARNING: PROXY_PASSWORD is not set. Do not expose this publicly.");
})().catch((e) => {
	console.error("Failed to start:", e && e.message);
	process.exit(1);
});
