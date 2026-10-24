"use strict";

const $ = (id) => document.getElementById(id);
const homeForm = $("form");
const homeAddress = $("address");
const errorEl = $("error");
const errorCode = $("error-code");
const bar = $("bar");
const barForm = $("bar-form");
const barAddress = $("bar-address");
const favBtn = $("btn-fav");
const favGrid = $("fav-grid");
const tabStrip = $("tabs");
const tabList = $("tab-list");
const siteError = $("site-error");

const { ScramjetController } = $scramjetLoadController();
const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});
scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

// ---------- Tabs ----------
// Each tab: { id, frame, url, title, retries, starting, error }
//   frame  - the ScramjetFrame, or null for a blank "new tab" (shows the home page)
//   url    - the real (un-proxied) address being viewed
const MAX_TABS = 12;
const MAX_RETRIES = 4;
let tabs = [];
let activeId = null;
let nextId = 1;

const activeTab = () => tabs.find((t) => t.id === activeId) || null;

function createTab() {
	const tab = { id: nextId++, frame: null, url: "", title: "New tab", retries: 0, starting: false, error: null };
	tabs.push(tab);
	activeId = tab.id;
	return tab;
}

function setActive(id) {
	if (id === activeId) return;
	activeId = id;
	Menu.close();
	Suggest.hide();
	updateView();
}

function newBlankTab() {
	if (tabs.length >= MAX_TABS) return alert("You can have up to " + MAX_TABS + " tabs open. Close one first.");
	createTab();
	Menu.close();
	updateView();
	homeAddress.value = "";
	homeAddress.focus();
}

// ---------- Google "I'm not a robot" page ----------
// Google blocks many server/datacenter addresses. We can't solve their check,
// so offer to run the same search somewhere that doesn't block this server.
function checkRobotWall(url) {
	const box = $("robot-banner");
	let u;
	try {
		u = new URL(url);
	} catch {
		return;
	}
	if (!/(^|\.)google\.[a-z.]+$/.test(u.hostname) || !u.pathname.startsWith("/sorry")) {
		box.hidden = true;
		return;
	}
	let q = "";
	try {
		q = new URL(u.searchParams.get("continue") || "").searchParams.get("q") || "";
	} catch {}
	box.textContent = "";
	const msg = document.createElement("span");
	msg.textContent = "Google is asking for a robot check and blocks this server's address, so it can't be solved here. ";
	const go1 = document.createElement("button");
	go1.type = "button";
	go1.textContent = q ? "Search \u201c" + q.slice(0, 24) + "\u201d on DuckDuckGo" : "Open DuckDuckGo";
	go1.addEventListener("click", () => {
		box.hidden = true;
		go(q ? "https://duckduckgo.com/?q=" + encodeURIComponent(q) : "https://duckduckgo.com/");
	});
	const go2 = document.createElement("button");
	go2.type = "button";
	go2.textContent = "Use DuckDuckGo from now on";
	go2.addEventListener("click", () => {
		Settings.set("engine", "duckduckgo");
		go2.textContent = "Done";
		go2.disabled = true;
	});
	const x = document.createElement("button");
	x.type = "button";
	x.textContent = "\u00d7";
	x.setAttribute("aria-label", "Dismiss");
	x.addEventListener("click", () => (box.hidden = true));
	box.append(msg, go1, go2, x);
	box.hidden = false;
}

// ---------- Full screen (hides the tab bar and address bar) ----------
function setZen(on) {
	document.body.classList.toggle("zen", on);
	$("zen-exit").hidden = !on || !document.body.classList.contains("browsing");
}
function toggleZen() {
	setZen(!document.body.classList.contains("zen"));
}
async function copyUrl() {
	const t = activeTab();
	if (!t || !t.url) return;
	try {
		await navigator.clipboard.writeText(t.url);
		toast("Address copied");
	} catch {
		prompt("Copy this address:", t.url);
	}
}
// A small message that fades away
function toast(text) {
	let el = document.getElementById("toast");
	if (!el) {
		el = document.createElement("div");
		el.id = "toast";
		el.setAttribute("role", "status");
		document.body.append(el);
	}
	el.textContent = text;
	el.classList.add("show");
	clearTimeout(toast.t);
	toast.t = setTimeout(() => el.classList.remove("show"), 1800);
}
function duplicateTab() {
	const t = activeTab();
	if (t && t.url) go(t.url, { newTab: true });
}
function closeOtherTabs() {
	for (const t of tabs.slice()) if (t.id !== activeId) closeTab(t.id);
}

const closedTabs = [];
function reopenClosedTab() {
	const u = closedTabs.pop();
	if (u) go(u, { newTab: true });
}

function closeTab(id) {
	const i = tabs.findIndex((t) => t.id === id);
	if (i < 0) return;
	const [tab] = tabs.splice(i, 1);
	if (tab.url) closedTabs.push(tab.url);
	if (closedTabs.length > 10) closedTabs.shift();
	if (tab.frame) tab.frame.frame.remove();
	if (activeId === id) activeId = tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null;
	Menu.close();
	Suggest.hide();
	updateView();
}

// Home button: blank out the page. The last tab simply closes.
function goHome() {
	const tab = activeTab();
	if (!tab) return;
	if (tabs.length === 1) return closeTab(tab.id);
	if (tab.frame) tab.frame.frame.remove();
	Object.assign(tab, { frame: null, url: "", title: "New tab", retries: 0, starting: false, error: null });
	updateView();
}

function cycleTab(dir) {
	if (tabs.length < 2) return;
	const i = tabs.findIndex((t) => t.id === activeId);
	setActive(tabs[(i + dir + tabs.length) % tabs.length].id);
}

// ---------- Site icons ----------
function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

// A colored letter tile; the real icon (served by /icon) covers it once loaded.
function makeIcon(url, small) {
	const host = hostOf(url).replace(/^www\./, "");
	const el = document.createElement("span");
	el.className = "ico" + (small ? " sm" : "");
	let hue = 0;
	for (const ch of host) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
	el.style.background = `hsl(${hue} 45% 42%)`;
	el.textContent = (host[0] || "?").toUpperCase();

	const img = document.createElement("img");
	img.alt = "";
	img.loading = "lazy";
	img.addEventListener("error", () => img.remove());
	img.src = "/icon?domain=" + encodeURIComponent(hostOf(url).split(":")[0]);
	el.appendChild(img);
	return el;
}

// ---------- Starting the proxy and opening sites ----------
async function startProxy() {
	await registerSW();
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
	if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
		await connection.setTransport("/libcurl/index.mjs", [{ websocket: wispUrl }]);
	}
}

function isRealPage(url) {
	try {
		const u = new URL(url);
		return /^https?:$/.test(u.protocol) && u.origin !== location.origin;
	} catch {
		return false;
	}
}

function attachFrame(tab) {
	const f = scramjet.createFrame();
	f.frame.className = "site-frame";
	document.body.appendChild(f.frame);
	tab.frame = f;
	applyZoom();

	f.addEventListener("urlchange", (event) => {
		if (!isRealPage(event.url)) return;
		tab.url = event.url;
		checkRobotWall(event.url);
		Store.addHistory(event.url, "");
		if (tab.id === activeId) {
			barAddress.value = event.url;
			updateFavButton();
		}
		Menu.refreshHistory();
	});
	f.frame.addEventListener("load", () => onFrameLoad(tab));
}

function navigate(tab, url) {
	if (!tab.frame) attachFrame(tab);
	tab.url = url;
	tab.title = hostOf(url);
	tab.retries = 0;
	tab.starting = false;
	tab.error = null;
	activeId = tab.id;
	homeAddress.value = ""; // the home search box starts fresh next time you're back there
	tab.frame.go(url);
	updateView();
}

async function go(input, opts = {}) {
	errorEl.textContent = "";
	errorCode.textContent = "";
	if (opts.newTab && tabs.length >= MAX_TABS) return alert("You can have up to " + MAX_TABS + " tabs open. Close one first.");
	const url = toUrl(input);
	try {
		await startProxy();
	} catch (err) {
		console.error(err);
		const t = activeTab();
		if (t && t.frame) {
			t.error = { url: t.url, text: "Could not start the proxy.\n" + String(err), retryable: false };
			updateView();
		} else {
			errorEl.textContent = "Could not start the proxy.";
			errorCode.textContent = String(err);
		}
		return;
	}
	navigate(opts.newTab ? createTab() : activeTab() || createTab(), url);
}

// ---------- Noticing failed pages ----------
// Scramjet shows its own "Uh oh!" page inside the frame when a site can't be
// loaded. We recognise it (the frame is same-origin) so we can retry quietly
// when the proxy was just still warming up, and otherwise show a friendlier page.
function readScramjetError(doc) {
	const text = (doc.body && doc.body.innerText) || "";
	if (!/Uh oh!/.test(text) || !/Scramjet/.test(text) || !/There was an error loading/.test(text)) return null;
	const m = text.match(/There was an error loading\s+(\S+)/);
	return {
		url: m ? m[1] : "",
		text: text.trim().slice(0, 3000),
		retryable: /wasm not loaded yet|invalid MessagePort/i.test(text),
	};
}

function onFrameLoad(tab) {
	if (!tabs.includes(tab) || !tab.frame) return;
	let doc = null;
	try {
		doc = tab.frame.frame.contentDocument;
	} catch {}
	if (!doc || !doc.body) return;

	const err = readScramjetError(doc);
	if (err) {
		if (err.url && isRealPage(err.url)) tab.url = err.url;
		if (err.retryable && tab.retries < MAX_RETRIES) {
			// The transport was still starting up. Try the same page again shortly.
			tab.retries++;
			tab.starting = true;
			updateView();
			setTimeout(() => {
				if (tabs.includes(tab) && tab.frame && tab.starting) tab.frame.go(tab.url);
			}, 700 * tab.retries);
			return;
		}
		tab.starting = false;
		tab.error = err;
		updateView();
		return;
	}

	tab.starting = false;
	tab.error = null;
	tab.retries = 0;
	if (doc.title) {
		tab.title = doc.title;
		Store.updateTitle(tab.url, doc.title);
		Menu.refreshHistory();
	}
	updateView();
}

const STARTING = { starting: true };
let shownError = null; // which error object siteError is currently drawn for

function renderSiteError(tab) {
	const e = tab && tab.frame ? (tab.starting ? STARTING : tab.error) : null;
	siteError.hidden = !e;
	if (!e) return void (shownError = null);
	if (shownError === e) return;
	shownError = e;
	siteError.textContent = "";

	const card = document.createElement("div");
	card.className = "se-card";
	const add = (tag, text, cls) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		n.textContent = text;
		card.append(n);
		return n;
	};

	if (e.starting) {
		const spin = document.createElement("div");
		spin.className = "se-spin";
		card.append(spin);
		add("h2", "Starting up…");
		add("p", "Getting the proxy ready. This only takes a moment.");
		siteError.append(card);
		return;
	}

	add("h2", "This page couldn't load");
	add("p", tab.url || e.url || "", "se-url");
	add(
		"p",
		e.retryable
			? "The proxy was still warming up. Wait a few seconds and press Try again."
			: "The site may be down, may not allow proxies, or may not work through this one. Try again, or try a different site."
	);

	const row = document.createElement("div");
	row.className = "btn-row";
	const mk = (label, onclick, primary) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "btn" + (primary ? " primary" : "");
		b.textContent = label;
		b.addEventListener("click", onclick);
		row.append(b);
	};
	mk("Try again", () => navigate(tab, tab.url || e.url), true);
	mk("Go back", () => tab.frame && tab.frame.back());
	mk("Back to home", goHome);
	card.append(row);

	const details = document.createElement("details");
	const sum = document.createElement("summary");
	sum.textContent = "Technical details";
	const pre = document.createElement("pre");
	pre.textContent = e.text || "";
	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "btn";
	copy.textContent = "Copy details";
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(e.text || "");
			copy.textContent = "Copied";
		} catch {
			copy.textContent = "Couldn't copy";
		}
	});
	details.append(sum, pre, copy);
	card.append(details);
	siteError.append(card);
}

// ---------- Drawing the current state ----------
function renderTabs() {
	tabList.textContent = "";
	for (const t of tabs) {
		const isActive = t.id === activeId;
		const item = document.createElement("div");
		item.className = "tabitem" + (isActive ? " active" : "");
		if (t.url) {
			let hash = 0;
			for (const ch of hostOf(t.url).replace(/^www\./, "")) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
			item.style.setProperty("--site", "hsl(" + hash + " 70% 55%)");
		}

		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "tabbtn";
		btn.setAttribute("role", "tab");
		btn.setAttribute("aria-selected", String(isActive));
		btn.tabIndex = isActive ? 0 : -1;
		btn.title = t.title;
		const label = document.createElement("span");
		label.className = "tt";
		label.textContent = t.title;
		btn.append(t.url ? makeIcon(t.url, true) : document.createTextNode(""), label);
		btn.addEventListener("click", () => setActive(t.id));
		btn.addEventListener("auxclick", (e) => {
			if (e.button === 1) {
				e.preventDefault();
				closeTab(t.id);
			}
		});
		btn.addEventListener("keydown", (e) => {
			if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
				e.preventDefault();
				cycleTab(e.key === "ArrowRight" ? 1 : -1);
				const sel = tabList.querySelector('[aria-selected="true"]');
				if (sel) sel.focus();
			}
		});

		const x = document.createElement("button");
		x.type = "button";
		x.className = "tabx";
		x.title = "Close tab";
		x.setAttribute("aria-label", "Close tab: " + t.title);
		x.textContent = "×";
		x.addEventListener("click", () => closeTab(t.id));

		item.append(btn, x);
		tabList.append(item);
	}
}

function updateView() {
	const tab = activeTab();
	const browsing = !!(tab && tab.frame);
	document.body.classList.toggle("has-tabs", tabs.length > 0);
	document.body.classList.toggle("browsing", browsing);
	tabStrip.hidden = tabs.length === 0;
	bar.hidden = !browsing;
	$("home").hidden = browsing;
	for (const t of tabs) if (t.frame) t.frame.frame.hidden = t !== tab;
	barAddress.value = browsing ? tab.url : "";
	renderTabs();
	renderSiteError(tab);
	updateFavButton();
	if (!browsing) document.body.classList.remove("zen");
	if (!browsing || !(tab && /\/sorry/.test(tab.url))) $("robot-banner").hidden = true;
	$("zen-exit").hidden = !document.body.classList.contains("zen");
	document.title = browsing && tab.title && tab.title !== "New tab" ? tab.title + " \u00b7 Moox Proxy" : "Moox Proxy";
	saveSession();
	if (!browsing) {
		renderFavorites();
		renderRecent();
		renderClock();
	}
}

// ---------- Recent sites + reopen last session (home page) ----------
const SESSION_KEY = "moox:session";
function saveSession() {
	const urls = tabs.filter((t) => t.url).map((t) => t.url);
	if (!urls.length) return; // keep the last real session when everything is closed
	try {
		localStorage.setItem(SESSION_KEY, JSON.stringify(urls.slice(0, MAX_TABS)));
	} catch {}
}
function lastSession() {
	try {
		const v = JSON.parse(localStorage.getItem(SESSION_KEY) || "[]");
		return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
	} catch {
		return [];
	}
}
async function reopenSession(urls) {
	const first = urls.shift();
	if (first) await go(first);
	for (const u of urls) await go(u, { newTab: true });
}
function renderRecent() {
	const box = $("recent");
	const row = $("recent-row");
	row.textContent = "";
	const seen = new Set(Store.favorites().map((f) => hostOf(f.url)));
	const items = [];
	for (const h of Store.history()) {
		const host = hostOf(h.url);
		if (seen.has(host)) continue;
		seen.add(host);
		items.push(h);
		if (items.length >= 6) break;
	}
	const sess = tabs.length ? [] : lastSession();
	box.hidden = !Settings.get("recent") || (!items.length && !sess.length);
	if (sess.length) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "chip";
		b.textContent = "↩ Reopen last session (" + sess.length + (sess.length === 1 ? " tab)" : " tabs)");
		b.addEventListener("click", () => reopenSession(sess.slice()));
		row.append(b);
	}
	for (const h of items) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "chip";
		b.title = h.url;
		b.append(makeIcon(h.url, true), document.createTextNode(" " + (h.title || hostOf(h.url)).slice(0, 24)));
		b.addEventListener("click", (e) => go(h.url, { newTab: e.ctrlKey || e.metaKey }));
		row.append(b);
	}
}

// Page zoom for the sites you visit (set in Settings > Accessibility).
function applyZoom() {
	const z = Settings.get("zoom") / 100;
	for (const t of tabs) if (t.frame) t.frame.frame.style.setProperty("--z", String(z));
}

// ---------- Favorites grid (home page) ----------
let dragUrl = null;

// "Edit favorites" (touch screens): shows rename / remove / move buttons on every tile.
$("fav-edit").addEventListener("click", () => {
	const on = !$("favs").classList.contains("editing");
	$("favs").classList.toggle("editing", on);
	$("fav-edit").setAttribute("aria-pressed", String(on));
	$("fav-edit").textContent = on ? "Done" : "Edit favorites";
});

function renderFavorites() {
	$("favs").hidden = !Settings.get("showFavs");
	favGrid.textContent = "";
	const favs = Store.favorites();

	for (const fav of favs) {
		const tile = document.createElement("div");
		tile.className = "tile";
		tile.dataset.url = fav.url;
		tile.draggable = true;

		const open = document.createElement("button");
		open.type = "button";
		open.className = "tile-open";
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = fav.title || hostOf(fav.url);
		open.title = (fav.title || fav.url) + " — drag to reorder, or Shift+←/→";
		open.append(makeIcon(fav.url, false), name);
		// Ctrl/Cmd-click or middle-click opens in a new tab
		open.addEventListener("click", (e) => go(fav.url, { newTab: e.ctrlKey || e.metaKey }));
		open.addEventListener("auxclick", (e) => {
			if (e.button === 1) {
				e.preventDefault();
				go(fav.url, { newTab: true });
			}
		});
		open.addEventListener("keydown", (e) => {
			if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
			e.preventDefault();
			const list = Store.favorites();
			const i = list.findIndex((f) => f.url === fav.url);
			const j = i + (e.key === "ArrowRight" ? 1 : -1);
			if (j < 0 || j >= list.length) return;
			Store.moveFavorite(fav.url, j);
			renderFavorites();
			const moved = [...favGrid.children].find((c) => c.dataset.url === fav.url);
			if (moved) moved.querySelector(".tile-open").focus();
		});

		const edit = document.createElement("button");
		edit.type = "button";
		edit.className = "edit";
		edit.title = "Rename";
		edit.setAttribute("aria-label", "Rename " + (fav.title || fav.url));
		edit.textContent = "✎";
		edit.addEventListener("click", () => {
			const next = prompt("Name for this favorite:", fav.title || hostOf(fav.url));
			if (next && next.trim()) {
				Store.renameFavorite(fav.url, next);
				renderFavorites();
			}
		});

		const x = document.createElement("button");
		x.type = "button";
		x.className = "x";
		x.title = "Remove";
		x.setAttribute("aria-label", "Remove " + (fav.title || fav.url));
		x.textContent = "×";
		x.addEventListener("click", () => {
			Store.removeFavorite(fav.url);
			renderFavorites();
		});

		// Drag to reorder
		tile.addEventListener("dragstart", (e) => {
			dragUrl = fav.url;
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", fav.url);
			tile.classList.add("dragging");
		});
		tile.addEventListener("dragend", () => {
			dragUrl = null;
			tile.classList.remove("dragging");
			for (const c of favGrid.children) c.classList.remove("over");
		});
		tile.addEventListener("dragover", (e) => {
			if (dragUrl && dragUrl !== fav.url) {
				e.preventDefault();
				tile.classList.add("over");
			}
		});
		tile.addEventListener("dragleave", () => tile.classList.remove("over"));
		tile.addEventListener("drop", (e) => {
			e.preventDefault();
			if (!dragUrl) return;
			Store.moveFavorite(dragUrl, Store.favorites().findIndex((f) => f.url === fav.url));
			dragUrl = null;
			renderFavorites();
		});

		// Touch screens can't drag or use Shift+arrows, so they get move buttons.
		const mover = (dir) => {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "mv " + (dir < 0 ? "mv-l" : "mv-r");
			b.textContent = dir < 0 ? "\u25c0" : "\u25b6";
			b.title = dir < 0 ? "Move earlier" : "Move later";
			b.setAttribute("aria-label", (dir < 0 ? "Move " : "Move ") + (fav.title || fav.url) + (dir < 0 ? " earlier" : " later"));
			b.addEventListener("click", () => {
				const list = Store.favorites();
				const i = list.findIndex((f) => f.url === fav.url);
				const j = i + dir;
				if (j < 0 || j >= list.length) return;
				Store.moveFavorite(fav.url, j);
				renderFavorites();
			});
			return b;
		};
		tile.append(open, edit, x, mover(-1), mover(1));
		favGrid.appendChild(tile);
	}

	const add = document.createElement("button");
	add.type = "button";
	add.className = "tile add";
	const plus = document.createElement("span");
	plus.className = "ico";
	plus.textContent = "+";
	const label = document.createElement("span");
	label.className = "name";
	label.textContent = "Add favorite";
	add.append(plus, label);
	add.addEventListener("click", () => {
		const input = prompt("Website to add (for example wikipedia.org):");
		if (!input || !input.trim()) return;
		const url = toUrl(input);
		if (!isRealPage(url)) return;
		Store.addFavorite(url, hostOf(url).replace(/^www\./, ""));
		renderFavorites();
	});
	// Dropping on "Add favorite" moves the dragged tile to the end
	add.addEventListener("dragover", (e) => {
		if (dragUrl) e.preventDefault();
	});
	add.addEventListener("drop", (e) => {
		e.preventDefault();
		if (!dragUrl) return;
		Store.moveFavorite(dragUrl, Store.favorites().length);
		dragUrl = null;
		renderFavorites();
	});
	favGrid.appendChild(add);
}

function updateFavButton() {
	const t = activeTab();
	const on = t && t.url && Store.isFavorite(t.url);
	favBtn.textContent = on ? "★" : "☆";
	favBtn.classList.toggle("on", !!on);
	favBtn.title = on ? "Remove from favorites" : "Add to favorites";
}

// ---------- Home page clock ----------
function renderClock() {
	const mode = Settings.get("clock");
	const box = $("clock");
	box.hidden = mode === "off" || document.body.classList.contains("browsing");
	if (box.hidden) return;
	const now = new Date();
	$("clock-time").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: mode === "12" });
	$("clock-date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
setInterval(renderClock, 10000);

function updatePlaceholder() {
	homeAddress.placeholder = "Search with " + Settings.engineName() + " or enter a website";
	homeAddress.setAttribute("aria-label", homeAddress.placeholder);
}

// React to settings changes right away.
Settings.onChange((key) => {
	if (key === "zoom" || key === "*") applyZoom();
	if (key === "engine" || key === "*") updatePlaceholder();
	if (key === "clock" || key === "*") renderClock();
	if (key === "showFavs" || key === "*") renderFavorites();
	if (key === "recent" || key === "*") renderRecent();
	if (key === "tabTheme") Menu.rerender();
	if (key === "tabSiteColor" || key === "*") renderTabs();
});

// ---------- Wiring ----------
homeForm.addEventListener("submit", (event) => {
	event.preventDefault();
	Suggest.hide();
	go(homeAddress.value);
});
barForm.addEventListener("submit", (event) => {
	event.preventDefault();
	Suggest.hide();
	if (barAddress.value.trim()) go(barAddress.value);
});

$("btn-home").addEventListener("click", goHome);
$("btn-back").addEventListener("click", () => activeTab() && activeTab().frame && activeTab().frame.back());
$("btn-forward").addEventListener("click", () => activeTab() && activeTab().frame && activeTab().frame.forward());
$("btn-reload").addEventListener("click", () => activeTab() && activeTab().frame && activeTab().frame.reload());
$("btn-newtab").addEventListener("click", newBlankTab);

favBtn.addEventListener("click", () => {
	const t = activeTab();
	if (!t || !t.url) return;
	let title = "";
	try {
		title = t.frame.frame.contentDocument.title;
	} catch {}
	Store.toggleFavorite(t.url, title);
	updateFavButton();
});

Menu.init({
	go,
	makeIcon,
	hostOf,
	onDataChange: () => {
		renderFavorites();
		updateFavButton();
	},
});

Account.init({
	onDataChange: () => {
		renderFavorites();
		updateFavButton();
		Menu.refreshHistory();
	},
});

Home.init({ go, makeIcon, hostOf });
$("zen-exit").addEventListener("click", () => setZen(false));
Apps.init({
	go,
	makeIcon,
	hostOf,
	openTool: (n) => Home.openByName(n),
	openMenu: (n) => Menu.open(n),
	newTab: newBlankTab,
	reopenClosed: reopenClosedTab,
	zen: toggleZen,
	duplicate: duplicateTab,
	copyUrl,
	closeOthers: closeOtherTabs,
});
Backgrounds.init();
Account.onChange(() => Home.renderGreeting());

Suggest.init({ makeIcon, hostOf });
Suggest.attach(homeAddress, (value) => go(value));
Suggest.attach(barAddress, (value) => go(value));

// Keyboard shortcuts (only when you're not typing in a box)
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		if (document.body.classList.contains("zen") && !Menu.isOpen()) return setZen(false);
		return Menu.close();
	}
	if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "t") {
		event.preventDefault();
		return reopenClosedTab();
	}
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	if (Apps.isOpen()) return;
	if (Home.toolOpen()) return; // keys belong to the calculator, timer or notes
	const t = event.target;
	if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
	const key = event.key.toLowerCase();
	const browsing = document.body.classList.contains("browsing");
	if (key === "/") {
		event.preventDefault();
		const box = browsing ? barAddress : homeAddress;
		box.focus();
		box.select();
	} else if (key === "m") {
		event.preventDefault();
		Menu.toggle();
	} else if (key === "t") {
		event.preventDefault();
		newBlankTab();
	} else if (key === "w" && tabs.length) {
		event.preventDefault();
		closeTab(activeId);
	} else if (key === "]") {
		event.preventDefault();
		cycleTab(1);
	} else if (key === "[") {
		event.preventDefault();
		cycleTab(-1);
	} else if (key === "h" && browsing) {
		event.preventDefault();
		goHome();
	}
});

updatePlaceholder();
renderFavorites();
renderRecent();
renderClock();

// Register the service worker right away (not just on the first search) so the
// browser can offer to install Moox Proxy as an app.
registerSW().catch(() => {});

// Keeps the Chrome address-bar shortcut working: https://YOUR-ADDRESS/?url=%s
const preset = new URLSearchParams(location.search).get("url");
if (preset) {
	homeAddress.value = preset;
	go(preset);
}
