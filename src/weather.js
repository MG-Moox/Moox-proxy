// Weather for the home page widget: GET /weather?city=Sydney&units=c
//
// The server asks Open-Meteo (a free weather service that needs no key) on your
// behalf, so the browser never talks to it directly. The destination hosts are
// fixed. Results are cached for 10 minutes.
const GEO = (q) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
const FORECAST = (lat, lon, f) =>
	`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
	`&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day` +
	`&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto` +
	(f ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
const TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 200;
const MAX_BYTES = 64 * 1024;

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

export function createWeather(urls = { geo: GEO, forecast: FORECAST }) {
	const cache = new Map();

	async function getJson(url) {
		const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
		if (!r.ok) throw new Error("upstream " + r.status);
		const text = await r.text();
		if (text.length > MAX_BYTES) throw new Error("too big");
		return JSON.parse(text);
	}

	async function lookup(city, fahrenheit) {
		const key = city.toLowerCase() + "|" + (fahrenheit ? "f" : "c");
		const hit = cache.get(key);
		if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
		const geo = await getJson(urls.geo(city));
		const place = geo && Array.isArray(geo.results) ? geo.results[0] : null;
		let data = null;
		if (place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
			const fc = await getJson(urls.forecast(place.latitude, place.longitude, fahrenheit));
			data = shapeWeather(place, fc);
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
				const data = await lookup(city, f);
				if (data) body = { ok: true, ...data, units: f ? "f" : "c" };
				else {
					status = 404;
					body = { error: "Couldn't find that place." };
				}
			} catch {
				status = 502;
				body = { error: "The weather service isn't answering right now." };
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
