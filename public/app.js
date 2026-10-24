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
	if (split && id !== split.a && id !== split.b) split = null;
	activeId = id;
	const lazy = tabs.find((t) => t.id === id && t.lazy && !t.frame);
	if (lazy) {
		lazy.lazy = false;
		lazy.asleep = false;
		Menu.close();
		updateView();
		go(lazy.pinUrl || lazy.url);
		return;
	}
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

// ---------- Right-click (or press-and-hold) menu for tabs ----------
function closeTabMenu() {
	const m = document.getElementById("tab-menu");
	if (m) m.remove();
	document.removeEventListener("mousedown", tabMenuOutside, true);
	document.removeEventListener("keydown", tabMenuKey, true);
	window.removeEventListener("blur", closeTabMenu);
}
const tabMenuOutside = (e) => {
	const m = document.getElementById("tab-menu");
	if (m && !m.contains(e.target)) closeTabMenu();
};
const tabMenuKey = (e) => {
	if (e.key === "Escape") {
		e.stopPropagation();
		closeTabMenu();
	}
};
// Pinned tabs are remembered in this browser and come back, ready to open, next time.
const PIN_KEY = "moox:pinned";
function savePinned() {
	const list = tabs.filter((t) => t.pinned && (t.pinUrl || t.url)).map((t) => ({ url: t.pinUrl || t.url, title: String(t.title || "").slice(0, 80) }));
	try {
		localStorage.setItem(PIN_KEY, JSON.stringify(list.slice(0, 12)));
	} catch {}
}
function restorePinned() {
	let list = [];
	try {
		list = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
	} catch {}
	for (const p of Array.isArray(list) ? list.slice(0, 12) : []) {
		if (!p || typeof p.url !== "string" || !/^https?:\/\//i.test(p.url)) continue;
		tabs.push({ id: nextId++, frame: null, url: p.url, pinUrl: p.url, title: p.title || hostOf(p.url), retries: 0, starting: false, error: null, pinned: true, lazy: true });
	}
	activeId = null; // stay on the home page
}

function pinTab(t) {
	t.pinned = !t.pinned;
	t.pinUrl = t.pinned ? t.url : "";
	tabs.sort((x, y) => Number(Boolean(y.pinned)) - Number(Boolean(x.pinned))); // stable: pinned first
	savePinned();
	renderTabs();
}
function closeTabsRightOf(t) {
	const i = tabs.indexOf(t);
	for (const o of tabs.slice(i + 1)) if (!o.pinned) closeTab(o.id);
}
function openTabMenu(t, x, y) {
	closeTabMenu();
	const i = tabs.indexOf(t);
	const items = [
		["New tab", () => newBlankTab()],
		t.frame ? ["Reload", () => t.frame.reload()] : null,
		t.url ? ["Duplicate", () => go(t.url, { newTab: true })] : null,
		["sep"],
		[t.pinned ? "Unpin tab" : "Pin tab", () => pinTab(t)],
		t.url ? ["Copy address", async () => {
			try {
				await navigator.clipboard.writeText(t.url);
				toast("Address copied");
			} catch {
				prompt("Copy this address:", t.url);
			}
		}] : null,
		t.url ? [Store.isFavorite(t.url) ? "Remove from favorites" : "Add to favorites", () => {
			Store.toggleFavorite(t.url, t.title);
			updateFavButton();
			renderFavorites();
		}] : null,
		["sep"],
		t.frame && activeTab() && activeTab().frame && activeTab() !== t ? ["Split view with this tab", () => splitWithActive(t.id)] : null,
		split && (split.a === t.id || split.b === t.id) ? ["Close split view", () => endSplit()] : null,
		["Close tab", () => closeTab(t.id)],
		tabs.length > 1 ? ["Close other tabs", () => { for (const o of tabs.slice()) if (o !== t && !o.pinned) closeTab(o.id); }] : null,
		i < tabs.length - 1 ? ["Close tabs to the right", () => closeTabsRightOf(t)] : null,
		closedTabs.length ? ["Reopen closed tab", () => reopenClosedTab()] : null,
	].filter(Boolean);
	const menu = document.createElement("div");
	menu.id = "tab-menu";
	menu.setAttribute("role", "menu");
	for (const [label, fn] of items) {
		if (label === "sep") {
			menu.append(Object.assign(document.createElement("hr"), {}));
			continue;
		}
		const b = document.createElement("button");
		b.type = "button";
		b.setAttribute("role", "menuitem");
		b.textContent = label;
		b.addEventListener("click", () => {
			closeTabMenu();
			fn();
		});
		menu.append(b);
	}
	document.body.append(menu);
	const r = menu.getBoundingClientRect();
	menu.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + "px";
	menu.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + "px";
	document.addEventListener("mousedown", tabMenuOutside, true);
	document.addEventListener("keydown", tabMenuKey, true);
	window.addEventListener("blur", closeTabMenu);
	menu.querySelector("button").focus();
}

// ---------- Split view (two pages side by side, or stacked on a phone) ----------
let split = null; // { a: tabId, b: tabId }
function startSplit(aId, bId) {
	const A = tabs.find((t) => t.id === aId), B = tabs.find((t) => t.id === bId);
	if (!A || !B || A === B || !A.frame || !B.frame) return false;
	split = { a: aId, b: bId };
	activeId = bId;
	updateView();
	return true;
}
function endSplit() {
	split = null;
	updateView();
}
function swapSplit() {
	if (split) {
		split = { a: split.b, b: split.a };
		updateView();
	}
}
// Opens a page next to the one you're looking at.
async function openBeside(input) {
	const first = activeTab();
	if (!first || !first.frame) return go(input);
	const prev = first.id;
	await go(input, { newTab: true });
	const nt = activeTab();
	if (nt && nt.id !== prev) startSplit(prev, nt.id);
}
function splitWithActive(otherId) {
	const cur = activeTab();
	if (cur && cur.id !== otherId) startSplit(cur.id, otherId);
}

// ---------- Side bar (Opera GX style) ----------
const SIDE_APPS = [
	["Discord", "https://discord.com/app"],
	["Twitch", "https://www.twitch.tv/"],
	["YouTube", "https://www.youtube.com/"],
	["Spotify", "https://open.spotify.com/"],
	["Reddit", "https://www.reddit.com/"],
	["Chess.com", "https://www.chess.com/play"],
];
// Simple line icons for Moox's own buttons (the sites use their real logos)
const SIDE_SVG = {
	apps: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
	notes: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4M8 12h8M8 16h6"/></svg>',
	calc: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/></svg>',
	settings: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
function buildSideBar() {
	const nav = $("gx-bar");
	const mk = (icon, label, fn) => {
		const b = document.createElement("button");
		b.type = "button";
		b.title = label;
		b.setAttribute("aria-label", label);
		if (typeof icon === "string") b.innerHTML = SIDE_SVG[icon]; // fixed strings above, not user input
		else b.append(icon);
		b.addEventListener("click", (e) => fn(e));
		return b;
	};
	nav.append(mk("apps", "Apps and games", () => Apps.open()));
	for (const [name, url] of SIDE_APPS) {
		nav.append(mk(makeIcon(url, true), name + " (opens beside this page; Ctrl-click for a new tab)", (e) => (e.ctrlKey || e.metaKey ? go(url, { newTab: true }) : openBeside(url))));
	}
	nav.append(Object.assign(document.createElement("span"), { className: "gx-gap" }));
	nav.append(mk("notes", "Notes", () => Home.openByName("notes")));
	nav.append(mk("calc", "Calculator", () => Home.openByName("calc")));
	nav.append(mk("settings", "Settings", () => Menu.open("settings")));
}

// ---------- Sleeping tabs (saves data; wake by tapping) ----------
function sleepOldTabs() {
	const mins = Settings.get("tabSleep");
	if (!mins) return;
	let changed = false;
	for (const t of tabs) {
		if (!t.frame || t.id === activeId || (split && (t.id === split.a || t.id === split.b))) continue;
		if (Date.now() - (t.lastActive || 0) < mins * 60_000) continue;
		t.frame.frame.remove();
		Object.assign(t, { frame: null, lazy: true, retries: 0, starting: false, error: null, asleep: true });
		changed = true;
	}
	if (changed) renderTabs();
}
setInterval(sleepOldTabs, 30_000);

const closedTabs = [];
function reopenClosedTab() {
	const u = closedTabs.pop();
	if (u) go(u, { newTab: true });
}

function closeTab(id) {
	const i = tabs.findIndex((t) => t.id === id);
	if (i < 0) return;
	const [tab] = tabs.splice(i, 1);
	if (split && (split.a === id || split.b === id)) split = null;
	if (tab.pinned) savePinned();
	if (tab.url) closedTabs.push(tab.url);
	if (closedTabs.length > 10) closedTabs.shift();
	if (tab.frame) tab.frame.frame.remove();
	if (activeId === id) {
		const next = tabs[Math.min(i, tabs.length - 1)];
		activeId = next && !(next.lazy && !next.frame) ? next.id : (tabs.find((t) => t.frame) || {}).id || null;
	}
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
	savePinned();
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

		if (t.asleep && !t.frame) {
			item.classList.add("asleep");
			item.title = "Asleep. Tap to wake.";
		}
		if (t.pinned) {
			item.classList.add("pinned");
			x.hidden = true;
		}
		item.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			openTabMenu(t, e.clientX, e.clientY);
		});
		// Touch: press and hold
		let hold = 0;
		item.addEventListener("touchstart", (e) => {
			const p = e.touches[0];
			hold = setTimeout(() => {
				hold = -1;
				openTabMenu(t, p.clientX, p.clientY);
			}, 550);
		}, { passive: true });
		const cancelHold = () => clearTimeout(hold > 0 ? hold : 0);
		item.addEventListener("touchmove", cancelHold, { passive: true });
		item.addEventListener("touchend", (e) => {
			cancelHold();
			if (hold === -1) {
				e.preventDefault(); // don't also switch tab
				hold = 0;
			}
		});

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
	if (split && !(tabs.find((t) => t.id === split.a && t.frame) && tabs.find((t) => t.id === split.b && t.frame))) split = null;
	const inSplit = Boolean(split && browsing && (activeId === split.a || activeId === split.b));
	document.body.classList.toggle("split", inSplit);
	for (const t of tabs) {
		if (!t.frame) continue;
		t.frame.frame.hidden = inSplit ? t.id !== split.a && t.id !== split.b : t !== tab;
		t.frame.frame.classList.toggle("sp1", inSplit && t.id === split.a);
		t.frame.frame.classList.toggle("sp2", inSplit && t.id === split.b);
	}
	if (tab) tab.lastActive = Date.now();
	for (const [n, key] of [[1, "a"], [2, "b"]]) {
		const head = $("sp-head" + n);
		head.hidden = !inSplit;
		if (!inSplit) continue;
		const t = tabs.find((x) => x.id === split[key]);
		head.classList.toggle("on", t.id === activeId);
		const ti = head.querySelector(".sp-title");
		ti.textContent = t.title || hostOf(t.url);
		ti.onclick = () => setActive(t.id);
		head.querySelector(".sp-swap").onclick = swapSplit;
		head.querySelector(".sp-close").onclick = endSplit;
	}
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
	const urls = tabs.filter((t) => t.url && !t.pinned).map((t) => t.url);
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
	const sess = tabs.some((t) => t.frame) ? [] : lastSession();
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
buildSideBar();
Settings.onChange((key) => {
	if (key === "gxbar" || key === "*") $("gx-bar").hidden = !Settings.get("gxbar");
});
$("gx-bar").hidden = !Settings.get("gxbar");
Apps.init({
	go,
	makeIcon,
	hostOf,
	openTool: (n) => Home.openByName(n),
	listTabs: () => tabs.filter((t) => t.url).map((t) => ({ id: t.id, title: t.title, url: t.url })),
	switchTab: (id) => setActive(id),
	openMenu: (n) => Menu.open(n),
	newTab: newBlankTab,
	reopenClosed: reopenClosedTab,
	zen: toggleZen,
	besideSite: () => {
		const v = prompt("Address or search for the page to show beside this one:");
		if (v && v.trim()) openBeside(v.trim());
	},
	endSplit,
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
restorePinned();
updateView();
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

// ---------- Click effects (Settings > Style > Click effect) ----------
document.addEventListener("pointerdown", (e) => {
	const fx = Settings.get("clickFx");
	if (fx === "off" || document.documentElement.dataset.motion === "reduce") return;
	const add = (cls, vars) => {
		const d = document.createElement("span");
		d.className = "fx " + cls;
		d.style.left = e.clientX + "px";
		d.style.top = e.clientY + "px";
		for (const k in vars) d.style.setProperty(k, vars[k]);
		document.body.append(d);
		setTimeout(() => d.remove(), 800);
	};
	if (fx === "ripple") add("ripple");
	else for (let i = 0; i < 8; i++) {
		const ang = (i / 8) * 6.283 + Math.random() * 0.5, dist = 26 + Math.random() * 26;
		add("spark", { "--dx": Math.cos(ang) * dist + "px", "--dy": Math.sin(ang) * dist + "px" });
	}
}, true);
