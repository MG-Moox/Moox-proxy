"use strict";
// Apps & games page, plus the Ctrl+K command palette.
const Apps = (() => {
	let ctx = { go() {}, makeIcon: () => document.createElement("span"), hostOf: (u) => u, openTool() {}, openMenu() {} };
	let list = null; // [{id?, name, url, category}]
	let panel = null;
	let palette = null;
	let cat = "All";
	let q = "";
	let lastFocus = null;

	const el = (tag, attrs = {}, ...kids) => {
		const e = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (k === "text") e.textContent = v;
			else e.setAttribute(k, v);
		}
		e.append(...kids);
		return e;
	};

	async function load() {
		if (list) return list;
		for (const url of ["/api/apps", "/apps-default.json"]) {
			try {
				const r = await fetch(url, { credentials: "same-origin" });
				if (!r.ok) continue;
				const j = await r.json();
				const a = Array.isArray(j) ? j : j.apps;
				if (Array.isArray(a) && a.length) return (list = a);
			} catch {}
		}
		return (list = []);
	}

	// ---------- the page ----------
	function build() {
		panel = el("div", { id: "apps", role: "dialog", "aria-modal": "true", "aria-label": "Apps and games", hidden: "" });
		const head = el("div", { class: "apps-head" });
		const title = el("h2", { text: "Apps & games" });
		const search = el("input", { id: "apps-search", type: "search", placeholder: "Search apps and games", autocomplete: "off", "aria-label": "Search apps" });
		const surprise = el("button", { type: "button", class: "chip", id: "apps-surprise", text: "🎲 Surprise me" });
		const close = el("button", { type: "button", class: "chip", id: "apps-close", "aria-label": "Close", text: "✕" });
		head.append(title, search, surprise, close);
		const chips = el("div", { id: "apps-cats" });
		const grid = el("div", { id: "apps-grid" });
		panel.append(head, chips, grid);
		document.body.append(panel);
		search.addEventListener("input", () => {
			q = search.value.trim().toLowerCase();
			draw();
		});
		close.addEventListener("click", closePage);
		surprise.addEventListener("click", () => surpriseMe());
		panel.addEventListener("mousedown", (e) => {
			if (e.target === panel) closePage();
		});
	}

	function draw() {
		const chips = panel.querySelector("#apps-cats");
		const grid = panel.querySelector("#apps-grid");
		const cats = ["All", ...new Set(list.map((a) => a.category))];
		if (!cats.includes(cat)) cat = "All";
		chips.textContent = "";
		for (const c of cats) {
			const b = el("button", { type: "button", class: "chip", "aria-pressed": String(c === cat), text: c });
			b.addEventListener("click", () => {
				cat = c;
				draw();
			});
			chips.append(b);
		}
		grid.textContent = "";
		const shown = list.filter((a) => (cat === "All" || a.category === cat) && (!q || (a.name + " " + a.category + " " + ctx.hostOf(a.url)).toLowerCase().includes(q)));
		if (!shown.length) grid.append(el("p", { class: "apps-empty", text: list.length ? "Nothing matches that." : "No apps yet." }));
		for (const a of shown) {
			const open = el("button", { type: "button", class: "tile-open", title: a.name });
			open.append(ctx.makeIcon(a.url, false), el("span", { class: "name", text: a.name }));
			open.addEventListener("click", (e) => launch(a, e.ctrlKey || e.metaKey));
			const star = el("button", { type: "button", class: "apps-star", "aria-label": "Add " + a.name + " to favorites" });
			const sync = () => {
				const on = Store.isFavorite(a.url);
				star.textContent = on ? "★" : "☆";
				star.setAttribute("aria-pressed", String(on));
			};
			sync();
			star.addEventListener("click", () => {
				Store.toggleFavorite(a.url, a.name);
				sync();
				if (window.Account && Account.pushSoon) Account.pushSoon();
			});
			grid.append(el("div", { class: "tile" }, open, star));
		}
	}

	function launch(a, newTab) {
		closePage(true);
		ctx.go(a.url, { newTab });
	}

	async function surpriseMe() {
		await load();
		const games = list.filter((a) => a.category === "Games");
		const pool = games.length ? games : list;
		if (!pool.length) return;
		launch(pool[Math.floor(Math.random() * pool.length)], false);
	}

	async function openPage() {
		if (!panel) build();
		lastFocus = document.activeElement;
		closePalette();
		Menu.close();
		panel.hidden = false;
		panel.querySelector("#apps-grid").textContent = "Loading…";
		await load();
		draw();
		panel.querySelector("#apps-search").focus();
	}
	function closePage(skipFocus) {
		if (!panel || panel.hidden) return;
		panel.hidden = true;
		if (!skipFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
	}

	// ---------- command palette (Ctrl/Cmd+K) ----------
	function actions() {
		const a = [
			["📱", "Apps & games", () => openPage()],
			["🎲", "Surprise me with a game", () => surpriseMe()],
			["🧮", "Calculator", () => ctx.openTool("calc")],
			["🌤️", "Weather", () => ctx.openTool("weather")],
			["⏱️", "Timer & stopwatch", () => ctx.openTool("timer")],
			["📝", "Notes", () => ctx.openTool("notes")],
			["⚙️", "Settings", () => ctx.openMenu("settings")],
			["👤", "Account & time left", () => ctx.openMenu("account")],
			["🕘", "History", () => ctx.openMenu("history")],
			["➕", "New tab", () => ctx.newTab()],
			["↩", "Reopen closed tab", () => ctx.reopenClosed && ctx.reopenClosed()],
		];
		return a.map(([icon, label, run]) => ({ icon, label, run, kind: "Action" }));
	}
	function sources() {
		const out = actions();
		const seen = new Set();
		const add = (kind, name, url) => {
			if (!url || seen.has(url)) return;
			seen.add(url);
			out.push({ kind, icon: "🌐", label: name || ctx.hostOf(url), url, run: () => ctx.go(url) });
		};
		for (const f of Store.favorites()) add("Favorite", f.title, f.url);
		for (const a of list || []) add("App", a.name, a.url);
		for (const h of Store.history().slice(0, 60)) add("Recent", h.title, h.url);
		return out;
	}

	async function openPalette() {
		if (palette) return closePalette();
		await load();
		closePage(true);
		lastFocus = document.activeElement;
		const input = el("input", { id: "pal-input", type: "text", placeholder: "Type to search, or type a site / search and press Enter", autocomplete: "off", "aria-label": "Command palette" });
		const ul = el("ul", { id: "pal-list", role: "listbox" });
		palette = el("div", { id: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" }, el("div", { id: "pal-card" }, input, ul));
		document.body.append(palette);
		const all = sources();
		let items = [];
		let sel = 0;
		const render = () => {
			const t = input.value.trim().toLowerCase();
			items = (t ? all.filter((x) => (x.label + " " + (x.url || "")).toLowerCase().includes(t)) : all.slice(0, 12)).slice(0, 12);
			const raw = input.value.trim();
			if (raw) items.push({ icon: "🔎", kind: "Go", label: "Go to or search “" + raw + "”", run: () => ctx.go(raw) });
			sel = Math.min(sel, items.length - 1);
			ul.textContent = "";
			items.forEach((x, i) => {
				const li = el("li", { role: "option", "aria-selected": String(i === sel) }, el("span", { class: "pal-ico", text: x.icon }), el("span", { class: "pal-label", text: x.label }), el("span", { class: "pal-kind", text: x.kind }));
				li.addEventListener("mousedown", (e) => {
					e.preventDefault();
					run(x);
				});
				ul.append(li);
			});
		};
		const run = (x) => {
			closePalette(true);
			x.run();
		};
		input.addEventListener("input", () => {
			sel = 0;
			render();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
				render();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (items[sel]) run(items[sel]);
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				closePalette();
			}
		});
		palette.addEventListener("mousedown", (e) => {
			if (e.target === palette) closePalette();
		});
		render();
		input.focus();
	}
	function closePalette(skipFocus) {
		if (!palette) return;
		palette.remove();
		palette = null;
		if (!skipFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
	}

	function init(context) {
		ctx = { ...ctx, ...context };
		document.addEventListener("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				openPalette();
			} else if (e.key === "Escape" && panel && !panel.hidden && !palette) closePage();
		});
		load(); // warm the list so the palette and Surprise me are instant
	}

	return { init, open: openPage, close: closePage, isOpen: () => Boolean((panel && !panel.hidden) || palette), surprise: surpriseMe, palette: openPalette };
})();
