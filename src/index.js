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
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
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
				// Serves /login and /logout, and redirects or rejects anyone not logged in.
				if (auth.handle(req, res)) return;
				// Scramjet needs cross-origin isolation.
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (!auth.isAuthorized(req)) {
					socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
					return;
				}
				if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
				else socket.end();
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

fastify.listen({ port, host: "0.0.0.0" }).then(() => {
	console.log(`Moox Proxy (Scramjet) running at http://localhost:${port}`);
	if (!PASSWORD) console.warn("WARNING: PROXY_PASSWORD is not set. Do not expose this publicly.");
});
