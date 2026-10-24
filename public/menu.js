"use strict";

// The ☰ menu: History, Settings and More (backup, shortcuts, log out).
const Menu = (() => {
	const menu = document.getElementById("menu");
	const body = document.getElementById("menu-body");
	const tabs = [...menu.querySelectorAll(".tab")];
	const toggleButtons = [document.getElementById("btn-menu"), document.getElementById("btn-menu-home")];

	let ctx = null; // set by init(): { go, makeIcon, hostOf, onDataChange }
	let tab = "history";
	let lastFocus = null;

	// ---------- tiny DOM helper (no innerHTML, so nothing can inject markup) ----------
	function el(tag, attrs = {}, ...kids) {
		const n = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k === "class") n.className = v;
			else if (k === "text") n.textContent = v;
			else if (k === "checked" || k === "value") n[k] = v;
			else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
			else n.setAttribute(k, v === true ? "" : v);
		}
		for (const kid of kids.flat()) if (kid != null) n.append(kid);
		return n;
	}

	function say(text) {
		const m = document.getElementById("menu-msg");
		if (m) m.textContent = text;
	}

	// ---------- History tab ----------
	function renderHistory() {
		const items = Store.history();
		const list = el("ul", { id: "hist-list" });

		for (const entry of items) {
			const open = el(
				"button",
				{ type: "button", class: "item", onclick: () => ctx.go(entry.url) },
				ctx.makeIcon(entry.url, true),
				el("span", { class: "txt" }, el("span", { class: "t", text: entry.title || entry.url }), el("span", { class: "u", text: ctx.hostOf(entry.url) }))
			);
			const del = el("button", {
				type: "button",
				class: "del",
				title: "Remove",
				"aria-label": "Remove " + (entry.title || entry.url) + " from history",
				text: "×",
				onclick: () => {
					Store.removeHistory(entry.id);
					render();
				},
			});
			list.append(el("li", {}, open, del));
		}

		body.append(
			el(
				"div",
				{ class: "menu-head" },
				el("strong", { text: "History" }),
				items.length
					? el("button", {
							type: "button",
							class: "btn",
							text: "Clear all",
							onclick: () => {
								if (confirm("Clear all browsing history saved in this browser?")) {
									Store.clearHistory();
									render();
								}
							},
						})
					: null
			),
			list,
			el("p", { class: "muted", text: items.length ? "" : "No history yet." }),
			el("p", { class: "muted", text: "Saved in this browser only." })
		);
	}

	// ---------- Settings tab ----------
	let rowId = 0;
	const uid = () => "set-" + ++rowId;

	function selectRow(label, key, options, hint) {
		const id = uid();
		const sel = el("select", { id });
		for (const [value, text] of options) sel.append(el("option", { value: String(value), text }));
		sel.value = String(Settings.get(key));
		sel.addEventListener("change", () => {
			const isNumber = typeof Settings.defaults[key] === "number";
			Settings.set(key, isNumber ? Number(sel.value) : sel.value);
		});
		return [el("div", { class: "row" }, el("label", { for: id, text: label }), sel), hint ? el("p", { class: "hint", text: hint }) : null];
	}

	function toggleRow(label, key, hint) {
		const id = uid();
		const cb = el("input", { type: "checkbox", id, class: "switch", role: "switch", checked: Settings.get(key) });
		cb.addEventListener("change", () => Settings.set(key, cb.checked));
		return [el("div", { class: "row" }, el("label", { for: id, text: label }), cb), hint ? el("p", { class: "hint", text: hint }) : null];
	}

	const ACCENTS = [
		["blue", "Blue", "#2563eb"],
		["green", "Green", "#15803d"],
		["purple", "Purple", "#7c3aed"],
		["orange", "Orange", "#c2410c"],
		["pink", "Pink", "#be185d"],
		["red", "Red", "#dc2626"],
		["teal", "Teal", "#0f766e"],
		["cyan", "Cyan", "#0891b2"],
		["indigo", "Indigo", "#4f46e5"],
		["lime", "Lime", "#65a30d"],
		["yellow", "Yellow", "#eab308"],
		["rose", "Rose", "#e11d48"],
		["slate", "Slate", "#475569"],
		["gold", "Gold", "#b45309"],
		["mint", "Mint", "#10b981"],
		["violet", "Violet", "#9333ea"],
	];

	function tabColorRow() {
		const id = uid();
		const input = el("input", { type: "color", id, value: Settings.get("tabCustom") });
		input.addEventListener("input", () => Settings.set("tabCustom", input.value));
		return el("div", { class: "row" }, el("label", { for: id, text: "Pick a tab bar color" }), input);
	}

	function accentRow() {
		const wrap = el("div", { class: "swatches", role: "group", "aria-label": "Accent color" });
		const buttons = ACCENTS.map(([value, name, color]) => {
			const b = el("button", {
				type: "button",
				class: "swatch",
				title: name,
				"aria-label": name,
				"aria-pressed": String(Settings.get("accent") === value),
				style: "background:" + color,
				onclick: () => {
					Settings.set("accent", value);
					buttons.forEach((x, i) => x.setAttribute("aria-pressed", String(ACCENTS[i][0] === value)));
				},
			});
			return b;
		});
		wrap.append(...buttons);
		return el("div", { class: "row" }, el("span", { text: "Accent color" }), wrap);
	}

	function textRow(label, key, placeholder, max) {
		const id = uid();
		const input = el("input", { type: "text", id, maxlength: String(max), placeholder, autocomplete: "off", value: Settings.get(key) });
		input.addEventListener("change", () => {
			if (!Settings.set(key, input.value.trim())) input.value = Settings.get(key);
		});
		return el("div", { class: "row stack-row" }, el("label", { for: id, text: label }), input);
	}

	function colorRow() {
		const id = uid();
		const input = el("input", { type: "color", id, value: Settings.get("accentCustom") });
		input.addEventListener("input", () => {
			Settings.set("accentCustom", input.value);
			Settings.set("accent", "custom");
			document.querySelectorAll(".swatch").forEach((b) => b.setAttribute("aria-pressed", "false"));
		});
		return el("div", { class: "row" }, el("label", { for: id, text: "Your own color" }), input);
	}

	// Shrinks a picture to a sensible size so it fits in browser storage.
	function readPicture(file) {
		return new Promise((resolve, reject) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => {
				const max = 1600;
				const scale = Math.min(1, max / Math.max(img.width, img.height));
				const c = document.createElement("canvas");
				c.width = Math.max(1, Math.round(img.width * scale));
				c.height = Math.max(1, Math.round(img.height * scale));
				c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
				URL.revokeObjectURL(url);
				resolve(c.toDataURL("image/jpeg", 0.82));
			};
			img.onerror = () => (URL.revokeObjectURL(url), reject(new Error("bad image")));
			img.src = url;
		});
	}

	function wallpaperRow() {
		const input = el("input", { type: "file", accept: "image/*", hidden: true, "aria-label": "Choose a background picture" });
		input.addEventListener("change", async () => {
			const f = input.files[0];
			input.value = "";
			if (!f) return;
			if (!f.type.startsWith("image/")) return say("That isn't a picture.");
			try {
				const data = await readPicture(f);
				if (Settings.setWallpaper(data)) {
					render();
					say("Background picture set.");
				} else say("That picture is too big for this browser to keep. Try a smaller one.");
			} catch {
				say("Couldn't read that picture.");
			}
		});
		return [
			el(
				"div",
				{ class: "row" },
				el("span", { text: "Your own picture" }),
				el(
					"div",
					{ class: "btn-row" },
					el("button", { type: "button", class: "btn", text: Settings.hasWallpaper() ? "Change…" : "Choose…", onclick: () => input.click() }),
					Settings.hasWallpaper()
						? el("button", {
								type: "button",
								class: "btn",
								text: "Remove",
								onclick: () => {
									Settings.clearWallpaper();
									render();
								},
						  })
						: null,
					input
				)
			),
			el("p", { class: "hint", text: "Saved in this browser only. Pick \u201cMy picture\u201d as the home background to show it." }),
		];
	}

	function zoomRow() {
		const out = el("output", { "aria-live": "polite" });
		const show = () => (out.textContent = Settings.get("zoom") + "%");
		const step = (dir) => {
			const zs = Settings.zooms;
			const i = zs.indexOf(Settings.get("zoom"));
			const next = zs[Math.min(zs.length - 1, Math.max(0, i + dir))];
			Settings.set("zoom", next);
			show();
		};
		show();
		const id = uid();
		return [
			el(
				"div",
				{ class: "row" },
				el("span", { id, text: "Page zoom" }),
				el(
					"div",
					{ class: "stepper", role: "group", "aria-labelledby": id },
					el("button", { type: "button", "aria-label": "Zoom out", text: "−", onclick: () => step(-1) }),
					out,
					el("button", { type: "button", "aria-label": "Zoom in", text: "+", onclick: () => step(1) }),
					el("button", {
						type: "button",
						text: "Reset",
						"aria-label": "Reset zoom to 100%",
						onclick: () => {
							Settings.set("zoom", 100);
							show();
						},
					})
				)
			),
			el("p", { class: "hint", text: "Makes the websites you visit bigger or smaller." }),
		];
	}

	const LOOKS = [
		["Clean", { theme: "light", accent: "blue", bg: "plain", tabTheme: "auto", tileStyle: "solid", corners: "normal" }],
		["Midnight", { theme: "dark", accent: "blue", bg: "stars", tabTheme: "midnight", tileStyle: "glass", corners: "round" }],
		["Ocean", { theme: "dark", accent: "blue", bg: "aurora", tabTheme: "ocean", tileStyle: "glass", corners: "round" }],
		["Sunset", { theme: "dark", accent: "orange", bg: "flow", tabTheme: "sunset", tileStyle: "glass", corners: "round" }],
		["Forest", { theme: "dark", accent: "green", bg: "fireflies", tabTheme: "forest", tileStyle: "glass", corners: "normal" }],
		["Candy", { theme: "light", accent: "pink", bg: "bubbles", tabTheme: "rose", tileStyle: "solid", corners: "round" }],
		["Gamer", { theme: "dark", accent: "red", bg: "grid", tabTheme: "gx", tileStyle: "glass", corners: "normal", gxbar: true }],
		["Grape", { theme: "dark", accent: "purple", bg: "snow", tabTheme: "grape", tileStyle: "outline", corners: "normal" }],
	];
	// Picks a random mix of every visual setting.
	const SURPRISE_KEYS = ["palette", "accent", "bg", "fontStyle", "corners", "tileStyle", "tabTheme", "tabStyle", "titleStyle", "clockStyle", "iconStyle", "shadow", "borders", "clickFx"];
	function surpriseRow() {
		const b = el("button", { type: "button", class: "btn primary", text: "\u{1F3B2} Surprise me (random look)" });
		b.addEventListener("click", () => {
			for (const k of SURPRISE_KEYS) {
				const list = Settings.options[k].filter((v) => v !== "custom" && !(k === "palette" && Math.random() < 0.4 && v !== "default"));
				Settings.set(k, list[Math.floor(Math.random() * list.length)]);
			}
			render();
		});
		return el("div", { class: "btn-row" }, b, el("p", { class: "hint", text: "Don't like it? Tap again, or pick a Look above." }));
	}

	function looksRow() {
		const wrap = el("div", { class: "looks" });
		for (const [name, set] of LOOKS) {
			wrap.append(el("button", { type: "button", class: "chip", text: name, onclick: () => {
				for (const [k, v] of Object.entries(set)) Settings.set(k, v);
				body.dispatchEvent(new CustomEvent("looks"));
				render();
			} }));
		}
		return [el("p", { class: "hint", text: "One-tap looks (you can still tweak everything below):" }), wrap];
	}

	function renderSettings() {
		const engines = Object.entries(Settings.engines).map(([k, v]) => [k, k === "brave" ? v.name + " (recommended)" : v.name]);
		body.append(
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Looks and colors" }),
				looksRow(),
				surpriseRow(),
				selectRow("Theme", "theme", [["system", "Match my device"], ["light", "Light"], ["dark", "Dark"]], Settings.get("palette") !== "default" ? "A color palette is on, so it decides light or dark. Set Palette to Default to use this." : null),
				selectRow("Palette", "palette", [["default", "Default"], ["amoled", "Pure black (AMOLED)"], ["midnight", "Midnight blue"], ["nord", "Nord"], ["dracula", "Dracula"], ["forest", "Deep forest"], ["coffee", "Coffee"], ["terminal", "Green terminal"], ["solarized", "Solarized light"], ["sepia", "Sepia paper"], ["rose", "Rose"], ["lavender", "Lavender"], ["mint", "Mint"]]),
				accentRow(),
				colorRow()
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Background" }),
				selectRow("Home background", "bg", [
					["plain", "Plain"],
					["gradient", "Soft gradient"],
					["aurora", "Aurora"],
					["sunset", "Sunset"],
					["ocean", "Ocean"],
					["peach", "Peach"],
					["mesh", "Color mesh"],
					["cotton", "Cotton candy"],
					["spotlight", "Spotlight"],
					["grid", "Grid"],
					["dots", "Dots"],
					["stripes", "Stripes"],
					["noise", "Film grain"],
					["flow", "Flowing colors (animated)"],
					["stars", "Twinkling stars (animated)"],
					["snow", "Falling snow (animated)"],
					["rain", "Rain (animated)"],
					["matrix", "Code rain (animated)"],
					["sakura", "Cherry blossoms (animated)"],
					["bubbles", "Floating bubbles (animated)"],
					["fireflies", "Fireflies (animated)"],
					["custom", "My picture"],
				]),
				wallpaperRow(),
				Settings.get("bg") === "custom" ? selectRow("Dim my picture", "bgDim", [[0, "None"], [20, "A little"], [40, "Medium"], [60, "A lot"]], "Makes text easier to read on bright pictures.") : null
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Style" }),
				selectRow("Font", "fontStyle", [["system", "Standard"], ["clean", "Clean"], ["serif", "Serif"], ["slab", "Slab"], ["mono", "Monospace"], ["typewriter", "Typewriter"], ["rounded", "Rounded"], ["hand", "Handwriting"], ["condensed", "Condensed"], ["wide", "Wide"]]),
				selectRow("Corners", "corners", [["sharp", "Sharp"], ["normal", "Normal"], ["round", "Very round"]]),
				selectRow("Tile style", "tileStyle", [["solid", "Solid"], ["glass", "Glass"], ["outline", "Outline"], ["neon", "Neon glow"], ["gradient", "Gradient"], ["soft", "Soft"]]),
				selectRow("Tile size", "tileSize", [["small", "Small"], ["normal", "Normal"], ["large", "Large"]]),
				selectRow("Site icons", "iconStyle", [["rounded", "Rounded"], ["circle", "Circles"], ["square", "Squares"]]),
				selectRow("Borders", "borders", [["thin", "Thin"], ["none", "None"], ["thick", "Thick"]]),
				selectRow("Shadows", "shadow", [["soft", "Soft"], ["none", "None"], ["strong", "Strong"]]),
				selectRow("Click effect", "clickFx", [["off", "Off"], ["ripple", "Ripple"], ["sparkle", "Sparkle"]])
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Home layout" }),
				selectRow("Page width", "homeWidth", [["narrow", "Narrow"], ["normal", "Normal"], ["wide", "Wide"]]),
				selectRow("Title style", "titleStyle", [["gradient", "Gradient"], ["plain", "Plain"], ["neon", "Neon glow"], ["hidden", "Hidden"]]),
				selectRow("Time look", "clockStyle", [["normal", "Normal"], ["big", "Big"], ["thin", "Thin"], ["mono", "Digital"]])
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Tabs" }),
				selectRow("Tab bar colors", "tabTheme", [["auto", "Match theme"], ["gx", "Gamer red"], ["ocean", "Ocean"], ["sunset", "Sunset"], ["forest", "Forest"], ["grape", "Grape"], ["rose", "Rose"], ["mint", "Mint"], ["gold", "Gold"], ["midnight", "Midnight"], ["graphite", "Graphite"], ["custom", "My color"]]),
				Settings.get("tabTheme") === "custom" ? tabColorRow() : null,
				selectRow("Tab shape", "tabStyle", [["classic", "Classic"], ["pill", "Pills"], ["line", "Underline"]]),
				toggleRow("Color stripe on each tab", "tabSiteColor", "Gives every website its own color so tabs are easy to tell apart."),
				toggleRow("Side bar with quick apps (gamer style)", "gxbar", "A strip on the left with Discord, Twitch, YouTube, Spotify and more. Tap one while browsing to open it beside your page."),
				selectRow("Put unused tabs to sleep", "tabSleep", [[0, "Never"], [5, "After 5 minutes"], [15, "After 15 minutes"], [30, "After 30 minutes"]], "Sleeping tabs stop loading and using data. Tap one to wake it.")
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Home page" }),
				selectRow("Clock", "clock", [["off", "Off"], ["12", "12-hour"], ["24", "24-hour"]]),
				toggleRow("Greeting", "greeting"),
				textRow("Name for the greeting", "userName", "Your name (optional)", 30),
				toggleRow("Quick links (YouTube, Google...)", "quickLinks"),
				toggleRow("Daily fun fact", "quote"),
				toggleRow("Recent sites and reopen session", "recent"),
				toggleRow("Tools (calculator, timer, notes, weather)", "tools"),
				toggleRow("Favorites", "showFavs"),
				textRow("Weather city", "weatherCity", "e.g. Sydney", 60),
				selectRow("Temperature", "units", [["c", "\u00b0C"], ["f", "\u00b0F"]])
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Search" }),
				selectRow("Search engine", "engine", engines, "Used when you type words instead of a website address. Brave recommended: it works well from this server, while Google often shows a robot check."),
				toggleRow("Search suggestions", "suggestions", "Shows ideas as you type. What you type is sent to DuckDuckGo or Google through your server.")
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Accessibility" }),
				selectRow("Text size", "textSize", [["small", "Small"], ["normal", "Normal"], ["large", "Large"], ["xlarge", "Extra large"]], "Changes Moox Proxy's own text. Use page zoom for websites."),
				toggleRow("High contrast", "highContrast"),
				toggleRow("Easy-to-read font", "readableFont"),
				toggleRow("Reduce motion", "reduceMotion"),
				zoomRow()
			),
			el("div", { class: "btn-row" }, el("button", {
				type: "button",
				class: "btn",
				text: "Reset settings",
				onclick: () => {
					Settings.reset();
					render();
				},
			}))
		);
	}

	// ---------- More tab ----------
	function download(name, text) {
		const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
		const a = el("a", { href: url, download: name });
		a.addEventListener("click", (e) => e.stopPropagation()); // don't count as a click outside the menu
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	async function importFile(file) {
		if (!file) return;
		if (file.size > 2 * 1024 * 1024) return say("That file is too big to be a Moox backup.");
		let data;
		try {
			data = JSON.parse(await file.text());
		} catch {
			return say("That file isn't a valid backup.");
		}
		if (!data || data.app !== "moox-proxy") return say("That file isn't a Moox Proxy backup.");
		const added = Store.importData(data);
		Settings.importSettings(data.settings);
		ctx.onDataChange();
		say(`Imported ${added.favorites} favorite(s) and ${added.history} history item(s), plus your settings.`);
	}

	// Help for putting Moox on a home screen / desktop.
	function installGroup() {
		const info = typeof Mobile !== "undefined" ? Mobile.installInfo() : null;
		if (!info || info.standalone) return null;
		const kids = [el("h3", { text: "Install as an app" })];
		if (info.canPrompt) {
			kids.push(
				el("p", { class: "hint", text: "Adds Moox to your home screen or desktop so it opens like an app." }),
				el("div", { class: "btn-row" }, el("button", { type: "button", class: "btn primary", text: "Install Moox", onclick: () => Mobile.promptInstall() }))
			);
		} else if (info.ios) {
			kids.push(el("p", { class: "hint", text: info.inApp ? "Open this page in Safari first. Then tap the Share button and choose Add to Home Screen." : "Tap the Share button in Safari, then choose Add to Home Screen." }));
		} else {
			kids.push(el("p", { class: "hint", text: "In Chrome, use the install icon in the address bar, or the ⋮ menu and Install app." }));
		}
		return el("fieldset", { class: "group" }, kids);
	}

	function renderMore() {
		const fileInput = el("input", { type: "file", accept: "application/json,.json", hidden: true, "aria-label": "Choose a backup file" });
		fileInput.addEventListener("change", () => {
			importFile(fileInput.files[0]);
			fileInput.value = "";
		});

		const keys = [
			["Focus the address bar", "/"],
			["Open or close this menu", "M"],
			["New tab", "T"],
			["Close this tab", "W"],
			["Next / previous tab", "]  ["],
			["Close the page (home)", "H"],
			["Move a favorite (when selected)", "Shift + \u2190 \u2192"],
			["Close the menu", "Esc"],
		];

		body.append(
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Backup" }),
				el("p", { class: "hint", text: "Your favorites, history and settings live in this browser. Export them to keep a copy or move to another device." }),
				el(
					"div",
					{ class: "btn-row" },
					el("button", {
						type: "button",
						class: "btn primary",
						text: "Export my data",
						onclick: () => {
							const data = { app: "moox-proxy", version: 1, exported: new Date().toISOString(), settings: Settings.exportSettings(), ...Store.exportData() };
							download("moox-backup.json", JSON.stringify(data, null, 2));
							say("Backup downloaded.");
						},
					}),
					el("button", { type: "button", class: "btn", text: "Import…", onclick: () => fileInput.click() }),
					fileInput
				)
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Keyboard shortcuts" }),
				el("p", { class: "hint", text: "Work when you're not typing in a box. While a website has focus, click the bar at the top first." }),
				el("ul", { class: "keys" }, keys.map(([what, key]) => el("li", {}, el("span", { text: what }), el("kbd", { text: key }))))
			),
			installGroup(),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Account and data" }),
				el(
					"div",
					{ class: "btn-row" },
					el("button", {
						type: "button",
						class: "btn",
						text: "Log out",
						onclick: () => {
							// Clears the login cookie, then reloads. Harmless if no password is set.
							fetch("/logout", { redirect: "manual", credentials: "same-origin" })
								.catch(() => {})
								.finally(() => (location.href = "/"));
						},
					}),
					el("button", {
						type: "button",
						class: "btn danger",
						text: "Delete all my data",
						onclick: () => {
							if (!confirm("Delete all favorites, history and settings saved in this browser? This can't be undone.")) return;
							Store.clearAll();
							Settings.reset();
							ctx.onDataChange();
							say("All saved data deleted.");
						},
					})
				)
			),
			el("p", { class: "muted", text: "Moox Proxy · powered by Scramjet" }),
			el("p", { id: "menu-msg", class: "", role: "status", "aria-live": "polite" })
		);
	}

	// ---------- Account tab (only when the server has accounts) ----------
	function renderAccount() {
		Account.renderTab(body, say);
		body.append(el("p", { id: "menu-msg", class: "", role: "status", "aria-live": "polite" }));
	}

	// ---------- Shell ----------
	const visibleTabs = () => tabs.filter((t) => !t.hidden);

	function render() {
		if (tab === "account" && !Account.enabled()) tab = "history";
		rowId = 0;
		for (const t of tabs) {
			const on = t.dataset.tab === tab;
			t.setAttribute("aria-selected", String(on));
			t.tabIndex = on ? 0 : -1;
		}
		body.setAttribute("aria-labelledby", "tab-" + tab);
		body.textContent = "";
		if (tab === "history") renderHistory();
		else if (tab === "settings") renderSettings();
		else if (tab === "account") renderAccount();
		else renderMore();
	}

	function setExpanded(on) {
		for (const b of toggleButtons) b.setAttribute("aria-expanded", String(on));
	}

	function open(which) {
		if (which) tab = which;
		if (tab === "account" && Account.enabled()) Account.refresh().then(() => !menu.hidden && tab === "account" && render());
		lastFocus = document.activeElement;
		menu.hidden = false;
		render();
		setExpanded(true);
		const active = tabs.find((t) => t.dataset.tab === tab);
		if (active) active.focus();
	}

	function close() {
		if (menu.hidden) return;
		const hadFocus = menu.contains(document.activeElement);
		menu.hidden = true;
		setExpanded(false);
		if (hadFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
	}

	function init(context) {
		ctx = context;
		for (const t of tabs) {
			t.addEventListener("click", () => {
				tab = t.dataset.tab;
				render();
			});
			// Left/Right arrows move between tabs
			t.addEventListener("keydown", (e) => {
				if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
				const vis = visibleTabs();
				const i = vis.indexOf(t);
				const next = vis[(i + (e.key === "ArrowRight" ? 1 : vis.length - 1)) % vis.length];
				tab = next.dataset.tab;
				render();
				next.focus();
				e.preventDefault();
			});
		}
		for (const b of toggleButtons) {
			b.addEventListener("click", (e) => {
				e.stopPropagation();
				if (menu.hidden) open();
				else close();
			});
		}
		// Click anywhere outside the menu to close it.
		// (composedPath is fixed when the click starts, so this still works when the
		// clicked button was removed from the page by the click itself.)
		document.addEventListener("click", (e) => {
			if (!menu.hidden && !e.composedPath().includes(menu)) close();
		});
		// Clicks inside the website (an iframe) never reach this page, but they do
		// move focus into it, so close the menu when that happens too.
		window.addEventListener("blur", () => {
			const a = document.activeElement;
			if (!menu.hidden && a && a.tagName === "IFRAME") close();
		});
	}

	return {
		init,
		open,
		close,
		toggle: () => (menu.hidden ? open() : close()),
		isOpen: () => !menu.hidden,
		rerender() {
			if (!menu.hidden && tab === "settings") {
				const y = body.scrollTop;
				render();
				body.scrollTop = y;
			}
		},
		refreshHistory() {
			if (!menu.hidden && tab === "history") render();
		},
	};
})();
