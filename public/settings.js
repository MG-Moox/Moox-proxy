"use strict";

// User settings, saved in this browser (localStorage) and applied to <html> as
// data- attributes that style.css reads. This script runs in <head> (not
// deferred) so the theme is applied before the page paints, with no flash.
const Settings = (() => {
	const KEY = "moox:settings";

	const ENGINES = {
		duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
		google: { name: "Google", url: "https://www.google.com/search?q=%s" },
		bing: { name: "Bing (Microsoft Edge)", url: "https://www.bing.com/search?q=%s" },
		yahoo: { name: "Yahoo", url: "https://search.yahoo.com/search?p=%s" },
		brave: { name: "Brave Search", url: "https://search.brave.com/search?q=%s" },
	};

	const ZOOMS = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200];

	// Allowed values for every setting. Anything else is ignored.
	const OPTIONS = {
		theme: ["system", "light", "dark"],
		accent: ["blue", "green", "purple", "orange", "pink", "red"],
		bg: ["plain", "gradient", "aurora", "grid"],
		textSize: ["small", "normal", "large", "xlarge"],
		engine: Object.keys(ENGINES),
		clock: ["off", "12", "24"],
		zoom: ZOOMS,
		highContrast: [true, false],
		readableFont: [true, false],
		reduceMotion: [true, false],
		showFavs: [true, false],
		suggestions: [true, false],
	};

	const DEFAULTS = {
		theme: "system",
		accent: "blue",
		bg: "plain",
		textSize: "normal",
		engine: "duckduckgo",
		clock: "off",
		zoom: 100,
		highContrast: false,
		readableFont: false,
		reduceMotion: false,
		showFavs: true,
		suggestions: true,
	};

	const listeners = [];
	let current = load();

	function valid(key, value) {
		return key in OPTIONS && OPTIONS[key].includes(value);
	}

	function load() {
		const out = { ...DEFAULTS };
		try {
			const saved = JSON.parse(localStorage.getItem(KEY));
			if (saved && typeof saved === "object") {
				for (const key of Object.keys(DEFAULTS)) if (valid(key, saved[key])) out[key] = saved[key];
			}
		} catch {}
		return out;
	}

	function save() {
		try {
			localStorage.setItem(KEY, JSON.stringify(current));
		} catch {}
	}

	const dark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

	function apply() {
		const root = document.documentElement;
		const scheme = current.theme === "system" ? (dark && dark.matches ? "dark" : "light") : current.theme;
		root.dataset.scheme = scheme;
		root.dataset.accent = current.accent;
		root.dataset.bg = current.bg;
		root.dataset.text = current.textSize;
		root.dataset.contrast = current.highContrast ? "high" : "normal";
		root.dataset.font = current.readableFont ? "readable" : "default";
		root.dataset.motion = current.reduceMotion ? "reduce" : "normal";
	}
	if (dark && dark.addEventListener) dark.addEventListener("change", apply);
	apply();

	function notify(key) {
		for (const fn of listeners) {
			try {
				fn(key, current[key]);
			} catch {}
		}
	}

	return {
		engines: ENGINES,
		zooms: ZOOMS,
		defaults: DEFAULTS,

		get: (key) => current[key],
		all: () => ({ ...current }),

		set(key, value) {
			if (!valid(key, value) || current[key] === value) return false;
			current[key] = value;
			save();
			apply();
			notify(key);
			return true;
		},

		reset() {
			current = { ...DEFAULTS };
			save();
			apply();
			notify("*");
		},

		// For backups: settings out as plain data, and back in with validation.
		exportSettings: () => ({ ...current }),
		importSettings(data) {
			if (!data || typeof data !== "object") return 0;
			let n = 0;
			for (const key of Object.keys(DEFAULTS)) {
				if (valid(key, data[key]) && current[key] !== data[key]) {
					current[key] = data[key];
					n++;
				}
			}
			save();
			apply();
			notify("*");
			return n;
		},

		// URL template for the chosen search engine; %s is replaced by the query.
		searchTemplate: () => (ENGINES[current.engine] || ENGINES.duckduckgo).url,
		engineName: () => (ENGINES[current.engine] || ENGINES.duckduckgo).name,

		onChange: (fn) => listeners.push(fn),
	};
})();
