"use strict";

// Extras on the home page: greeting, quick links, weather, and small tools
// (calculator, timer and stopwatch, notes) that open in a panel. Everything
// here runs in your browser; only the weather asks the server for data.
const Home = (() => {
	const $ = (id) => document.getElementById(id);
	let ctx = { go() {}, makeIcon: () => document.createElement("span") };
	let lastFocus = null;
	let openTool = "";

	function el(tag, attrs = {}, ...kids) {
		const n = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k === "class") n.className = v;
			else if (k === "text") n.textContent = v;
			else if (k === "value") n.value = v;
			else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
			else n.setAttribute(k, v === true ? "" : v);
		}
		for (const kid of kids.flat()) if (kid != null) n.append(kid);
		return n;
	}

	// ---------- greeting ----------
	function renderGreeting() {
		const box = $("greeting");
		if (!box) return;
		box.hidden = !Settings.get("greeting") || document.body.classList.contains("browsing");
		renderQuote();
		if (box.hidden) return;
		const hr = new Date().getHours();
		const part = hr < 5 ? "Good night" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
		const name = Settings.get("userName").trim() || (typeof Account !== "undefined" ? Account.username() : "");
		const emoji = hr < 5 ? "\u{1F319}" : hr < 12 ? "\u2600\uFE0F" : hr < 18 ? "\u{1F324}\uFE0F" : "\u{1F305}";
		box.textContent = emoji + " " + (name ? `${part}, ${name}` : part);
		renderQuote();
	}

	// ---------- daily fun fact (works offline, changes each day) ----------
	const FACTS = [
		"Honey never spoils. Edible honey has been found in 3,000-year-old tombs.",
		"Octopuses have three hearts and blue blood.",
		"A day on Venus is longer than its year.",
		"Bananas are berries, but strawberries aren't.",
		"Wombats make cube-shaped poo.",
		"There are more trees on Earth than stars in the Milky Way, by some estimates.",
		"The Eiffel Tower grows about 15 cm taller in summer heat.",
		"Sharks are older than trees.",
		"Tasmania has some of the cleanest air in the world.",
		"A group of flamingos is called a flamboyance.",
		"Lightning is about five times hotter than the surface of the Sun.",
		"The first website is still online at info.cern.ch.",
		"Sea otters hold hands while they sleep so they don't drift apart.",
		"Your brain uses about 20% of your body's energy.",
		"The shortest war in history lasted about 40 minutes.",
		"Mount Everest grows a few millimetres every year.",
		"Cows have best friends and get stressed when separated.",
		"Water can boil and freeze at the same time (the triple point).",
		"A snail can sleep for three years.",
		"The Great Barrier Reef is the largest living structure on Earth.",
		"Koalas have fingerprints almost identical to humans'.",
		"The letter E is the most used letter in English.",
		"Jellyfish have survived for over 500 million years.",
		"Hot water can sometimes freeze faster than cold water.",
		"Dolphins call each other by name using unique whistles.",
		"A teaspoon of a neutron star would weigh about a billion tonnes.",
		"Pineapples take about two years to grow.",
		"Crows can remember human faces for years.",
		"The Moon moves about 3.8 cm farther from Earth every year.",
		"Antarctica is the driest continent.",
		"Butterflies taste with their feet.",
	];
	function renderQuote() {
		const box = $("quote");
		if (!box) return;
		box.hidden = !Settings.get("quote") || document.body.classList.contains("browsing");
		if (box.hidden) return;
		const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
		box.textContent = "\u{1F4A1} Fun fact: " + FACTS[day % FACTS.length];
	}

	// ---------- quick links ----------
	const QUICK = [
		["YouTube", "https://www.youtube.com/"],
		["Google", "https://www.google.com/"],
		["Wikipedia", "https://en.wikipedia.org/"],
		["Reddit", "https://www.reddit.com/"],
		["GitHub", "https://github.com/"],
		["Maps", "https://www.google.com/maps"],
		["Spotify", "https://open.spotify.com/"],
		["Twitch", "https://www.twitch.tv/"],
	];

	function renderQuick() {
		const box = $("quick");
		box.hidden = !Settings.get("quickLinks");
		if (box.hidden || box.dataset.built) return;
		box.dataset.built = "1";
		const grid = $("quick-grid");
		for (const [name, url] of QUICK) {
			const open = el("button", { type: "button", class: "tile-open", title: name });
			open.append(ctx.makeIcon(url, false), el("span", { class: "name", text: name }));
			open.addEventListener("click", (e) => ctx.go(url, { newTab: e.ctrlKey || e.metaKey }));
			grid.append(el("div", { class: "tile" }, open));
		}
	}

	function renderTools() {
		$("tools").hidden = !Settings.get("tools");
	}

	// ---------- panel ----------
	function close() {
		if (!openTool) return;
		$("tool").hidden = true;
		openTool = "";
		$("tool-body").textContent = "";
		if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
	}

	function open(name, title, build) {
		lastFocus = document.activeElement;
		openTool = name;
		$("tool-title").textContent = title;
		const body = $("tool-body");
		body.textContent = "";
		build(body);
		$("tool").hidden = false;
		// The calculator listens for keys on its body, so put focus there; the
		// other tools keep focus on the close button (notes/weather focus their own box).
		if (name === "calc") {
			body.tabIndex = -1;
			body.focus();
		} else $("tool-close").focus();
	}

	// ---------- calculator ----------
	// A small hand-written parser, so nothing is ever run as code.
	// Understands + - * / % ( ) and decimals.
	function calculate(text) {
		const src = text.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\s+/g, "");
		let i = 0;
		const peek = () => src[i];
		function number() {
			const m = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\.?/i.exec(src.slice(i));
			if (!m) throw new Error("bad");
			i += m[0].length;
			return parseFloat(m[0]);
		}
		function primary() {
			if (peek() === "(") {
				i++;
				const v = expr();
				if (peek() !== ")") throw new Error("bad");
				i++;
				return v;
			}
			return number();
		}
		function postfix() {
			let v = primary();
			while (peek() === "%") (i++, (v /= 100));
			return v;
		}
		function unary() {
			if (peek() === "-") return i++, -unary();
			if (peek() === "+") return i++, unary();
			return postfix();
		}
		function term() {
			let v = unary();
			while (peek() === "*" || peek() === "/") {
				const op = src[i++];
				const r = unary();
				if (op === "/" && r === 0) throw new Error("div0");
				v = op === "*" ? v * r : v / r;
			}
			return v;
		}
		function expr() {
			let v = term();
			while (peek() === "+" || peek() === "-") {
				const op = src[i++];
				const r = term();
				v = op === "+" ? v + r : v - r;
			}
			return v;
		}
		if (!src) return 0;
		const v = expr();
		if (i !== src.length) throw new Error("bad");
		if (!Number.isFinite(v)) throw new Error("bad");
		return Number(v.toPrecision(12));
	}

	function buildCalculator(body) {
		let expression = "";
		let previous = "";
		const prev = el("div", { class: "calc-prev", "aria-hidden": "true" });
		const screen = el("output", { class: "calc-screen", "aria-live": "polite" });
		const show = () => {
			screen.textContent = expression || "0";
			prev.textContent = previous;
		};
		const press = (k) => {
			if (k === "C") (expression = ""), (previous = "");
			else if (k === "⌫") expression = expression.slice(0, -1);
			else if (k === "=") {
				if (!expression) return;
				try {
					const r = String(calculate(expression));
					previous = expression + " =";
					expression = r;
				} catch (e) {
					previous = expression;
					expression = "";
					screen.textContent = e.message === "div0" ? "Can't divide by 0" : "Error";
					prev.textContent = previous;
					return;
				}
			} else if (k === "±") {
				expression = expression.startsWith("-") ? expression.slice(1) : expression ? "-" + expression : "";
			} else {
				if (previous.endsWith("=") && /^[\d.(]/.test(k)) (expression = ""), (previous = "");
				else if (previous.endsWith("=")) previous = "";
				expression += k;
			}
			show();
		};
		const keys = ["C", "(", ")", "÷", "7", "8", "9", "×", "4", "5", "6", "-", "1", "2", "3", "+", "±", "0", ".", "=", "%", "⌫"];
		const grid = el("div", { class: "calc-grid" });
		for (const k of keys) {
			const op = /[÷×\-+=]/.test(k);
			grid.append(
				el("button", {
					type: "button",
					class: "btn calc-key" + (k === "=" ? " primary" : op ? " op" : ""),
					text: k,
					"aria-label": { "÷": "divide", "×": "times", "-": "minus", "+": "plus", "⌫": "backspace", "±": "plus or minus", "=": "equals", C: "clear" }[k] || k,
					onclick: () => press(k),
				})
			);
		}
		body.append(prev, screen, grid);
		show();
		body.addEventListener("keydown", (e) => {
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (/^[0-9.()+%]$/.test(e.key)) press(e.key);
			else if (e.key === "-") press("-");
			else if (e.key === "*") press("×");
			else if (e.key === "/") press("÷");
			else if (e.key === "Backspace") press("⌫");
			else if (e.key === "Enter") press("=");
			else if (e.key === "=") press("=");
			else if (e.key.toLowerCase() === "c") press("C");
			else return;
			e.preventDefault();
		});
	}

	// ---------- timer and stopwatch ----------
	const timer = { end: 0, left: 0, running: false, done: false, set: 300000, tick: 0 };
	const watch = { start: 0, base: 0, running: false, laps: [], tick: 0 };
	let audio = null;

	function beep() {
		try {
			audio = audio || new (window.AudioContext || window.webkitAudioContext)();
			for (let i = 0; i < 3; i++) {
				const o = audio.createOscillator();
				const g = audio.createGain();
				o.frequency.value = 880;
				g.gain.value = 0.15;
				o.connect(g).connect(audio.destination);
				o.start(audio.currentTime + i * 0.35);
				o.stop(audio.currentTime + i * 0.35 + 0.2);
			}
		} catch {}
	}

	const mmss = (ms) => {
		const s = Math.max(0, Math.ceil(ms / 1000));
		return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
	};
	const stopwatchText = (ms) => {
		const cs = Math.floor(ms / 10) % 100;
		const s = Math.floor(ms / 1000) % 60;
		const m = Math.floor(ms / 60000);
		return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
	};

	function timerLeft() {
		return timer.running ? Math.max(0, timer.end - Date.now()) : timer.left;
	}

	function timerFinished() {
		clearInterval(timer.tick);
		timer.running = false;
		timer.left = 0;
		timer.done = true;
		beep();
		const old = document.title;
		document.title = "⏰ Time's up!";
		setTimeout(() => (document.title = old), 8000);
		if (openTool !== "timer") openTimer();
		else renderTimerPanel();
	}

	let timerDraw = () => {};
	let watchDraw = () => {};

	function renderTimerPanel() {
		timerDraw();
	}

	function buildTimer(body) {
		const tabs = el("div", { class: "seg", role: "tablist" });
		const pane = el("div");
		let which = "countdown";

		const countdown = () => {
			pane.textContent = "";
			const out = el("output", { class: "big", "aria-live": "off" });
			const startBtn = el("button", { type: "button", class: "btn primary" });
			const resetBtn = el("button", { type: "button", class: "btn", text: "Reset" });
			const mins = el("input", { type: "number", min: "1", max: "600", value: String(Math.round(timer.set / 60000)), "aria-label": "Minutes" });
			const draw = () => {
				out.textContent = mmss(timer.done ? 0 : timerLeft() || (timer.running ? 0 : timer.set));
				startBtn.textContent = timer.running ? "Pause" : !timer.done && timerLeft() > 0 && timerLeft() < timer.set ? "Resume" : "Start";
			};
			timerDraw = draw;
			startBtn.addEventListener("click", () => {
				if (timer.running) {
					timer.left = timerLeft();
					timer.running = false;
					clearInterval(timer.tick);
				} else {
					audio = audio || new (window.AudioContext || window.webkitAudioContext)(); // allowed by this click
					const ms = timer.left > 0 && !timer.done ? timer.left : timer.set;
					timer.done = false;
					timer.end = Date.now() + ms;
					timer.running = true;
					clearInterval(timer.tick);
					timer.tick = setInterval(() => {
						if (timerLeft() <= 0) timerFinished();
						else timerDraw();
					}, 250);
				}
				draw();
			});
			resetBtn.addEventListener("click", () => {
				clearInterval(timer.tick);
				timer.running = false;
				timer.left = 0;
				timer.done = false;
				draw();
			});
			const setMinutes = (m) => {
				timer.set = Math.max(1, Math.min(600, m)) * 60000;
				timer.left = 0;
				timer.done = false;
				timer.running = false;
				clearInterval(timer.tick);
				mins.value = String(Math.round(timer.set / 60000));
				draw();
			};
			mins.addEventListener("change", () => setMinutes(parseInt(mins.value, 10) || 5));
			const presets = el("div", { class: "btn-row" });
			for (const m of [1, 5, 10, 25, 45]) presets.append(el("button", { type: "button", class: "btn", text: m + " min", onclick: () => setMinutes(m) }));
			pane.append(out, el("div", { class: "btn-row center" }, startBtn, resetBtn), presets, el("label", { class: "inline" }, "Minutes ", mins));
			draw();
		};

		const stopwatch = () => {
			pane.textContent = "";
			const out = el("output", { class: "big" });
			const startBtn = el("button", { type: "button", class: "btn primary" });
			const lapBtn = el("button", { type: "button", class: "btn", text: "Lap" });
			const resetBtn = el("button", { type: "button", class: "btn", text: "Reset" });
			const laps = el("ol", { class: "laps" });
			const elapsed = () => watch.base + (watch.running ? Date.now() - watch.start : 0);
			const draw = () => {
				out.textContent = stopwatchText(elapsed());
				startBtn.textContent = watch.running ? "Stop" : elapsed() > 0 ? "Resume" : "Start";
			};
			const drawLaps = () => {
				laps.textContent = "";
				watch.laps.forEach((l) => laps.prepend(el("li", { text: stopwatchText(l) })));
			};
			watchDraw = draw;
			startBtn.addEventListener("click", () => {
				if (watch.running) {
					watch.base = elapsed();
					watch.running = false;
					clearInterval(watch.tick);
				} else {
					watch.start = Date.now();
					watch.running = true;
					clearInterval(watch.tick);
					watch.tick = setInterval(() => watchDraw(), 50);
				}
				draw();
			});
			lapBtn.addEventListener("click", () => {
				if (elapsed() > 0) (watch.laps.push(elapsed()), drawLaps());
			});
			resetBtn.addEventListener("click", () => {
				clearInterval(watch.tick);
				watch.running = false;
				watch.base = 0;
				watch.laps = [];
				draw();
				drawLaps();
			});
			pane.append(out, el("div", { class: "btn-row center" }, startBtn, lapBtn, resetBtn), laps);
			draw();
			drawLaps();
		};

		const pick = (name) => {
			which = name;
			for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.k === name));
			name === "countdown" ? countdown() : stopwatch();
		};
		for (const [k, label] of [["countdown", "Timer"], ["stopwatch", "Stopwatch"]]) {
			tabs.append(el("button", { type: "button", class: "btn", "data-k": k, text: label, onclick: () => pick(k) }));
		}
		body.append(tabs, pane);
		pick(which);
	}

	function openTimer() {
		open("timer", "Timer", buildTimer);
	}

	// ---------- notes ----------
	function buildNotes(body) {
		let t = 0;
		const status = el("p", { class: "hint", role: "status", text: "Saved on this device" + (typeof Account !== "undefined" && Account.enabled() && !Account.isGuest() ? " and your account." : ".") });
		const area = el("textarea", { class: "notes", rows: "10", maxlength: "8000", placeholder: "Jot something down…", "aria-label": "Notes" });
		area.value = Store.notes();
		area.addEventListener("input", () => {
			status.textContent = "Saving…";
			clearTimeout(t);
			t = setTimeout(() => {
				Store.setNotes(area.value);
				status.textContent = "Saved";
			}, 500);
		});
		area.addEventListener("blur", () => {
			clearTimeout(t);
			Store.setNotes(area.value);
		});
		body.append(area, status);
		setTimeout(() => area.focus(), 0);
	}

	// ---------- weather ----------
	const WMO = (code, day = true) => {
		if (code === 0) return day ? ["☀️", "Clear"] : ["🌙", "Clear"];
		if (code === 1) return day ? ["🌤️", "Mostly clear"] : ["🌙", "Mostly clear"];
		if (code === 2) return ["⛅", "Partly cloudy"];
		if (code === 3) return ["☁️", "Cloudy"];
		if (code === 45 || code === 48) return ["🌫️", "Fog"];
		if (code >= 51 && code <= 57) return ["🌦️", "Drizzle"];
		if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return ["🌧️", "Rain"];
		if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ["❄️", "Snow"];
		if (code >= 95) return ["⛈️", "Thunderstorm"];
		return ["🌡️", "Weather"];
	};

	const wcache = new Map();
	async function fetchWeather(city) {
		const key = city.toLowerCase() + "|" + Settings.get("units");
		const hit = wcache.get(key);
		if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.data;
		const data = await fetchWeatherUncached(city);
		wcache.set(key, { at: Date.now(), data });
		return data;
	}
	async function fetchWeatherUncached(city) {
		const r = await fetch(`/weather?city=${encodeURIComponent(city)}&units=${Settings.get("units")}`, { credentials: "same-origin" });
		let data = null;
		try {
			data = await r.json();
		} catch {}
		if (!r.ok || !data || !data.ok) throw new Error((data && data.error) || "Couldn't get the weather.");
		return data;
	}

	async function renderMiniWeather() {
		const btn = $("weather-mini");
		const city = Settings.get("weatherCity").trim();
		if (!city || document.body.classList.contains("browsing")) {
			btn.hidden = true;
			return;
		}
		try {
			const w = await fetchWeather(city);
			const [icon, text] = WMO(w.current.code, w.current.day);
			btn.textContent = `${icon} ${Math.round(w.current.temp)}°${w.units.toUpperCase()} · ${w.place}`;
			btn.title = `${text}, feels like ${Math.round(w.current.feels)}°. Click for the forecast.`;
			btn.hidden = false;
		} catch {
			btn.hidden = true;
		}
	}

	function buildWeather(body) {
		const out = el("div", { class: "weather-out", "aria-live": "polite" });
		const city = el("input", { type: "text", maxlength: "60", placeholder: "City, e.g. Sydney", "aria-label": "City", autocomplete: "off" });
		city.value = Settings.get("weatherCity");
		const units = el("select", { "aria-label": "Units" }, el("option", { value: "c", text: "°C" }), el("option", { value: "f", text: "°F" }));
		units.value = Settings.get("units");
		const show = async () => {
			const name = city.value.trim();
			if (name.length < 2) return (out.textContent = "Type a city name.");
			out.textContent = "Loading…";
			try {
				Settings.set("units", units.value);
				const w = await fetchWeather(name);
				Settings.set("weatherCity", name);
				const [icon, text] = WMO(w.current.code, w.current.day);
				const u = "°" + w.units.toUpperCase();
				const days = el("div", { class: "wdays" });
				w.days.forEach((d, i) => {
					const [di, dt] = WMO(d.code);
					const label = i === 0 ? "Today" : new Date(d.date + "T12:00:00").toLocaleDateString([], { weekday: "short" });
					days.append(el("div", { class: "wday", title: dt }, el("div", { text: label }), el("div", { class: "wi", text: di }), el("div", { text: `${Math.round(d.max)}${u} / ${Math.round(d.min)}${u}` })));
				});
				out.textContent = "";
				out.append(
					el("div", { class: "wnow" }, el("span", { class: "wbig", text: icon }), el("div", {}, el("div", { class: "wtemp", text: `${Math.round(w.current.temp)}${u}` }), el("div", { class: "muted", text: `${text} · feels ${Math.round(w.current.feels)}${u}` }))),
					el("div", { class: "muted", text: `${w.place}${w.region ? ", " + w.region : ""} · wind ${Math.round(w.current.wind)} ${w.units === "f" ? "mph" : "km/h"} · humidity ${Math.round(w.current.humidity)}%` }),
					days
				);
				renderMiniWeather();
			} catch (e) {
				out.textContent = e.message;
			}
		};
		body.append(el("form", { class: "btn-row", onsubmit: (e) => (e.preventDefault(), show()) }, city, units, el("button", { type: "submit", class: "btn primary", text: "Show" })), out);
		if (city.value.trim()) show();
		else setTimeout(() => city.focus(), 0);
	}

	// ---------- version label ----------
	async function showVersion() {
		try {
			const r = await fetch("/version.json", { cache: "no-store" });
			const v = await r.json();
			$("version").textContent = "v" + v.version + (v.build ? " · " + v.build : "");
		} catch {}
	}

	// Tapping the version shows what changed in each update.
	async function buildNews(body) {
		body.classList.add("news");
		body.textContent = "Loading…";
		try {
			const r = await fetch("/changelog.json", { cache: "no-cache" });
			const list = await r.json();
			body.textContent = "";
			for (const entry of Array.isArray(list) ? list.slice(0, 10) : []) {
				const head = el("h3", { text: "v" + entry.version }, el("span", { class: "when", text: entry.date || "" }));
				const ul = el("ul", {}, (entry.changes || []).map((c) => el("li", { text: String(c) })));
				body.append(head, ul);
			}
		} catch {
			body.textContent = "Couldn't load the list.";
		}
	}

	// ---------- wiring ----------
	function init(context) {
		ctx = context;
		for (const b of document.querySelectorAll("[data-tool]")) {
			b.addEventListener("click", () => {
				const t = b.dataset.tool;
				if (t === "apps") return Apps.open();
				if (t === "calc") open("calc", "Calculator", buildCalculator);
				else if (t === "timer") openTimer();
				else if (t === "notes") open("notes", "Notes", buildNotes);
				else if (t === "weather") open("weather", "Weather", buildWeather);
			});
		}
		$("weather-mini").addEventListener("click", () => open("weather", "Weather", buildWeather));
		$("tool-close").addEventListener("click", close);
		$("tool").addEventListener("mousedown", (e) => {
			if (e.target === $("tool")) close();
		});
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && openTool) {
				close();
				e.stopImmediatePropagation();
			}
		});
		const refresh = () => {
			renderGreeting();
			renderQuick();
			renderTools();
		};
		Settings.onChange((key) => {
			refresh();
			if (key === "weatherCity" || key === "units" || key === "*") renderMiniWeather();
		});
		new MutationObserver(() => {
			renderGreeting();
			renderMiniWeather();
		}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
		refresh();
		renderMiniWeather();
		setInterval(renderMiniWeather, 15 * 60 * 1000);
		setInterval(renderGreeting, 60 * 1000);
		$("version").addEventListener("click", () => open("news", "What's new", buildNews));
		showVersion();
	}

	function openByName(t) {
		if (t === "calc") open("calc", "Calculator", buildCalculator);
		else if (t === "timer") openTimer();
		else if (t === "notes") open("notes", "Notes", buildNotes);
		else if (t === "weather") open("weather", "Weather", buildWeather);
	}
	return { init, renderGreeting, close, toolOpen: () => Boolean(openTool), calculate, openByName };
})();
