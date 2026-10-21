// Site icons for the favorites grid: GET /icon?domain=example.com
//
// The server fetches the icon from a favicon service and hands it to the page.
// Doing it here (instead of in the browser) avoids cross-origin blocking, and
// the destination host is fixed, so the "domain" value can't be used to reach
// internal addresses.
const DEFAULT_BASE = "https://www.google.com/s2/favicons";
const MAX_BYTES = 100 * 1024;
const MAX_CACHE = 500;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function createIcons(base = DEFAULT_BASE) {
	const cache = new Map(); // domain -> { type, body } | null (no icon)

	async function fetchIcon(domain) {
		if (cache.has(domain)) return cache.get(domain);
		let result = null;
		try {
			const r = await fetch(`${base}?domain=${encodeURIComponent(domain)}&sz=64`, {
				signal: AbortSignal.timeout(4000),
			});
			const type = r.headers.get("content-type") || "";
			if (r.ok && type.startsWith("image/")) {
				const body = Buffer.from(await r.arrayBuffer());
				if (body.length > 0 && body.length <= MAX_BYTES) result = { type, body };
			}
		} catch {}
		if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
		cache.set(domain, result);
		return result;
	}

	// Returns true if it handled the request.
	async function handle(req, res) {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname !== "/icon") return false;

		const domain = (url.searchParams.get("domain") || "").toLowerCase();
		const icon = DOMAIN_RE.test(domain) ? await fetchIcon(domain) : null;
		if (!icon) {
			res.writeHead(404, { "content-type": "text/plain", "cache-control": "public, max-age=3600" });
			res.end("no icon");
			return true;
		}
		res.writeHead(200, {
			"content-type": icon.type,
			"content-length": icon.body.length,
			"cache-control": "public, max-age=604800",
			"x-content-type-options": "nosniff",
		});
		res.end(icon.body);
		return true;
	}

	return { handle };
}
