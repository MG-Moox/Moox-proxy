// Search suggestions for the address box: GET /suggest?q=some+words
//
// The server asks a suggestion service on your behalf and returns a short JSON
// list. Doing it here (not in the browser) avoids cross-origin blocking. The
// destination hosts are fixed, so the query can't be used to reach anything
// else. Only people logged in to your proxy can use it.
const SOURCES = [
	(q) => `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
	(q) => `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
];
const MAX_QUERY = 100;
const MAX_RESULTS = 8;
const MAX_BYTES = 32 * 1024;
const TTL_MS = 60 * 1000;
const MAX_CACHE = 300;

// Understands the two common formats:
//   OpenSearch: ["query", ["suggestion", ...]]
//   DuckDuckGo: [{ "phrase": "suggestion" }, ...]
export function parseSuggestions(data) {
	let list = [];
	if (Array.isArray(data) && Array.isArray(data[1])) list = data[1];
	else if (Array.isArray(data)) list = data.map((x) => (x && typeof x === "object" ? x.phrase : x));
	const out = [];
	for (const item of list) {
		if (typeof item !== "string") continue;
		const s = item.trim();
		if (!s || s.length > MAX_QUERY || out.includes(s)) continue;
		out.push(s);
		if (out.length >= MAX_RESULTS) break;
	}
	return out;
}

export function createSuggest(sources = SOURCES) {
	const cache = new Map(); // query -> { at, list }

	async function lookup(q) {
		const hit = cache.get(q.toLowerCase());
		if (hit && Date.now() - hit.at < TTL_MS) return hit.list;

		let list = [];
		for (const makeUrl of sources) {
			try {
				const r = await fetch(makeUrl(q), { signal: AbortSignal.timeout(3000) });
				if (!r.ok) continue;
				const text = await r.text();
				if (text.length > MAX_BYTES) continue;
				list = parseSuggestions(JSON.parse(text));
				if (list.length) break;
			} catch {}
		}
		if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
		cache.set(q.toLowerCase(), { at: Date.now(), list });
		return list;
	}

	// Returns true if it handled the request.
	async function handle(req, res) {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname !== "/suggest") return false;

		const q = (url.searchParams.get("q") || "").trim();
		let suggestions = [];
		if (q.length >= 2 && q.length <= MAX_QUERY) suggestions = await lookup(q);

		const body = JSON.stringify({ q, suggestions });
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(body),
			"cache-control": "private, max-age=60",
			"x-content-type-options": "nosniff",
		});
		res.end(body);
		return true;
	}

	return { handle };
}
