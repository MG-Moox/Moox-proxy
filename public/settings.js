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
		accent: ["blue", "green", "purple", "orange", "pink", "red", "custom"],
		bg: ["plain", "gradient", "aurora", "grid", "flow", "stars", "snow", "bubbles", "fireflies", "custom"],
		textSize: ["small", "normal", "large", "xlarge"],
		engine: Object.keys(ENGINES),
		clock: ["off", "12", "24"],
		zoom: ZOOMS,
		highContrast: [true, false],
		readableFont: [true, false],
		reduceMotion: [true, false],
		showFavs: [true, false],
		suggestions: [true, false],
		fontStyle: ["system", "serif", "mono", "rounded"],
		corners: ["sharp", "normal", "round"],
		tileStyle: ["solid", "glass", "outline"],
		tileSize: ["small", "normal", "large"],
		bgDim: [0, 20, 40, 60],
		units: ["c", "f"],
		greeting: [true, false],
		quickLinks: [true, false],
		tools: [true, false],
	};

	// Free-text settings: checked with a function instead of a list.
	const TEXT = {
		userName: (v) => typeof v === "string" && v.length <= 30,
		weatherCity: (v) => typeof v === "string" && v.length <= 60,
		accentCustom: (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v),
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
		fontStyle: "system",
		corners: "normal",
		tileStyle: "solid",
		tileSize: "normal",
		bgDim: 20,
		units: "c",
		greeting: true,
		quickLinks: true,
		tools: true,
		userName: "",
		weatherCity: "",
		accentCustom: "#2563eb",
	};

	const listeners = [];
	let current = load();

	function valid(key, value) {
		if (key in TEXT) return TEXT[key](value);
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
		root.dataset.fontstyle = current.fontStyle;
		root.dataset.corners = current.corners;
		root.dataset.tiles = current.tileStyle;
		root.dataset.tilesize = current.tileSize;
		root.style.setProperty("--dim", String(current.bgDim / 100));
		// Custom accent colour: set the colour and a readable text colour for buttons.
		if (current.accent === "custom") {
			const hex = current.accentCustom;
			const lum = (0.299 * parseInt(hex.slice(1, 3), 16) + 0.587 * parseInt(hex.slice(3, 5), 16) + 0.114 * parseInt(hex.slice(5, 7), 16)) / 255;
			root.style.setProperty("--accent", hex);
			root.style.setProperty("--focus", hex);
			root.style.setProperty("--accent-fg", lum > 0.62 ? "#111111" : "#ffffff");
		} else {
			root.style.removeProperty("--accent");
			root.style.removeProperty("--focus");
			root.style.removeProperty("--accent-fg");
		}
		// A custom wallpaper only applies if one has been saved.
		let wall = "";
		try {
			wall = localStorage.getItem("moox:wallpaper") || "";
		} catch {}
		if (current.bg === "custom" && wall) root.style.setProperty("--wallpaper", `url("${wall}")`);
		else root.style.removeProperty("--wallpaper");
		root.dataset.wall = current.bg === "custom" && wall ? "on" : "off";
		// Phone browser chrome colour follows the theme.
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.setAttribute("content", scheme === "dark" ? "#111111" : "#ffffff");
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

		// Custom wallpaper (a downsized image saved in this browser only).
		hasWallpaper() {
			try {
				return Boolean(localStorage.getItem("moox:wallpaper"));
			} catch {
				return false;
			}
		},
		setWallpaper(dataUrl) {
			try {
				localStorage.setItem("moox:wallpaper", dataUrl);
			} catch {
				return false;
			}
			current.bg = "custom";
			save();
			apply();
			notify("bg");
			return true;
		},
		clearWallpaper() {
			try {
				localStorage.removeItem("moox:wallpaper");
			} catch {}
			if (current.bg === "custom") current.bg = "plain";
			save();
			apply();
			notify("bg");
		},
	};
})();
