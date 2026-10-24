// Weather for the home page widget: GET /weather?city=Sydney&units=c
//
// The server asks Open-Meteo (a free weather service that needs no key) on your
// behalf, so the browser never talks to it directly. The destination hosts are
// fixed. Results are cached for 10 minutes.
const GEO = (q) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=en&format=json`;
const FORECAST = (lat, lon, f) =>
	`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
	`&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day` +
	`&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto` +
	(f ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
// Backup forecast source (MET Norway) used if Open-Meteo refuses or is down.
const METNO = (lat, lon) => `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`;
const STALE_MS = 6 * 60 * 60 * 1000;
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 200;
const MAX_BYTES = 64 * 1024;
const MAX_BYTES_METNO = 600 * 1024;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export function shapeWeather(place, fc) {
	const c = fc && fc.current;
	const d = fc && fc.daily;
	if (!c || !d || !Array.isArray(d.time)) return null;
	return {
		place: String(place.name || "").slice(0, 80),
		region: String(place.admin1 || place.country || "").slice(0, 80),
		current: {
			temp: num(c.temperature_2m),
			feels: num(c.apparent_temperature),
			humidity: num(c.relative_humidity_2m),
			wind: num(c.wind_speed_10m),
			code: Number.isInteger(c.weather_code) ? c.weather_code : 0,
			day: c.is_day === 0 ? false : true,
		},
		days: d.time.slice(0, 4).map((date, i) => ({
			date: String(date),
			code: Number.isInteger(d.weather_code[i]) ? d.weather_code[i] : 0,
			max: num(d.temperature_2m_max[i]),
			min: num(d.temperature_2m_min[i]),
		})),
	};
}

const WMO_FROM_SYMBOL = (s) => {
	s = String(s || "");
	if (s.includes("thunder")) return 95;
	if (s.includes("snow")) return 71;
	if (s.includes("sleet")) return 67;
	if (s.includes("heavyrain")) return 65;
	if (s.includes("rain")) return s.includes("light") ? 61 : 63;
	if (s.startsWith("fog")) return 45;
	if (s.startsWith("clearsky")) return 0;
	if (s.startsWith("fair")) return 1;
	if (s.startsWith("partlycloudy")) return 2;
	return 3;
};

// Turns a MET Norway forecast into the same shape as Open-Meteo's.
export function shapeMetno(place, mj, fahrenheit) {
	const ts = mj && mj.properties && mj.properties.timeseries;
	if (!Array.isArray(ts) || !ts.length) return null;
	const T = (c) => (fahrenheit ? c * 1.8 + 32 : c);
	const W = (ms) => (fahrenheit ? ms * 2.23694 : ms * 3.6);
	const offset = Math.round((place.longitude || 0) / 15) * 3600_000;
	const first = ts[0].data.instant.details;
	const sym = (e) => (e.data.next_1_hours || e.data.next_6_hours || e.data.next_12_hours || {}).summary;
	const byDay = new Map();
	for (const e of ts) {
		const d = e.data.instant.details;
		if (typeof d.air_temperature !== "number") continue;
		const day = new Date(Date.parse(e.time) + offset).toISOString().slice(0, 10);
		const g = byDay.get(day) || { max: -Infinity, min: Infinity, codes: [] };
		g.max = Math.max(g.max, d.air_temperature);
		g.min = Math.min(g.min, d.air_temperature);
		const s = sym(e);
		const lh = new Date(Date.parse(e.time) + offset).getUTCHours();
		if (s && lh >= 9 && lh <= 17) g.codes.push(WMO_FROM_SYMBOL(s.symbol_code));
		byDay.set(day, g);
	}
	const hour = new Date(Date.parse(ts[0].time) + offset).getUTCHours();
	const s0 = sym(ts[0]);
	const days = [...byDay.entries()].slice(0, 4).map(([date, g]) => ({
		date,
		code: g.codes.length ? Math.max(...g.codes) : s0 ? WMO_FROM_SYMBOL(s0.symbol_code) : 3,
		max: num(T(g.max)),
		min: num(T(g.min)),
	}));
	return {
		place: String(place.name || "").slice(0, 80),
		region: String(place.admin1 || place.country || "").slice(0, 80),
		current: {
			temp: num(T(first.air_temperature)),
			feels: num(T(first.air_temperature)),
			humidity: num(first.relative_humidity),
			wind: num(W(first.wind_speed || 0)),
			code: s0 ? WMO_FROM_SYMBOL(s0.symbol_code) : 3,
			day: hour >= 6 && hour < 19,
		},
		days,
	};
}

export function createWeather(urls = { geo: GEO, forecast: FORECAST, metno: METNO }) {
	const cache = new Map();

	async function getOnce(url, max = MAX_BYTES) {
		const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json", "user-agent": "MooxProxy/2 (personal weather widget; github.com/MG-Moox/Moox-proxy)" } });
		if (!r.ok) throw new Error("upstream " + r.status);
		const text = await r.text();
		if (text.length > max) throw new Error("too big");
		return JSON.parse(text);
	}
	// One quick retry: shared server addresses are sometimes rate limited for a moment.
	async function getJson(url, max) {
		try {
			return await getOnce(url, max);
		} catch (e) {
			await new Promise((r) => setTimeout(r, 700));
			return getOnce(url, max);
		}
	}

	async function lookup(city, fahrenheit) {
		const key = city.toLowerCase() + "|" + (fahrenheit ? "f" : "c");
		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
		// "@lat,lon" comes from the "use my location" button
		const ll = /^@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(city);
		let place;
		if (ll) {
			const la = Number(ll[1]), lo = Number(ll[2]);
			if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) place = { name: "Your location", latitude: la, longitude: lo };
		} else {
			// "Hobart, Tasmania": search the first part, prefer a result that matches the rest
			const [first, ...rest] = city.split(",");
			const hint = rest.join(" ").trim().toLowerCase();
			const geo = await getJson(urls.geo(first.trim() || city));
			const results = geo && Array.isArray(geo.results) ? geo.results : [];
			place = (hint && results.find((r) => [r.admin1, r.admin2, r.country, r.country_code].some((x) => x && String(x).toLowerCase().includes(hint)))) || results[0] || null;
		}
		let data = null;
		if (place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
			try {
				data = shapeWeather(place, await getJson(urls.forecast(place.latitude, place.longitude, fahrenheit)));
				if (!data) throw new Error("unexpected forecast format");
			} catch (e) {
				console.error("weather: Open-Meteo failed (" + e.message + "), trying MET Norway");
				if (!urls.metno) throw e;
				const mj = await getJson(urls.metno(place.latitude.toFixed(3), place.longitude.toFixed(3)), MAX_BYTES_METNO);
				data = shapeMetno(place, mj, fahrenheit);
				if (!data) throw e;
			}
		}
		if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
		cache.set(key, { at: Date.now(), data });
		return data;
	}

	async function handle(req, res) {
		const url = new URL(req.url, "http://localhost");
		const city = (url.searchParams.get("city") || "").trim();
		const f = url.searchParams.get("units") === "f";
		let status = 200;
		let body;
		if (city.length < 2 || city.length > 60) {
			status = 400;
			body = { error: "Enter a city name." };
		} else {
			try {
				let data;
				try {
					data = await lookup(city, f);
				} catch (e) {
					console.error("weather: lookup failed:", e.message);
					const old = cache.get(city.toLowerCase() + "|" + (f ? "f" : "c"));
					if (old && old.data && Date.now() - old.at < STALE_MS) data = old.data; // better than nothing
					else throw e;
				}
				if (data) body = { ok: true, ...data, units: f ? "f" : "c" };
				else {
					status = 404;
					body = { error: "Couldn't find that place." };
				}
			} catch (e) {
				console.error("weather error:", e && e.message);
				const old = cache.get(city.toLowerCase() + "|" + (f ? "f" : "c")); // stale copy is better than nothing
				if (old && old.data) {
					body = { ok: true, ...old.data, units: f ? "f" : "c" };
				} else {
					status = 502;
					const why = e && e.message ? String(e.message).replace(/[^\w .:-]/g, "").slice(0, 40) : "";
					body = { error: "The weather service isn't answering right now." + (why ? " (" + why + ")" : "") };
				}
			}
		}
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(text),
			"cache-control": "private, max-age=300",
			"x-content-type-options": "nosniff",
		});
		res.end(text);
	}

	return { handle };
}
