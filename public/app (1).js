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

let frame = null; // the current ScramjetFrame, or null on the home page
let currentUrl = ""; // real (un-proxied) address of the page being viewed

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

// ---------- Opening sites ----------
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

function showBrowsing(on) {
	document.body.classList.toggle("browsing", on);
	bar.hidden = !on;
	$("home").hidden = on;
	Menu.close();
	if (!on) {
		renderFavorites();
		renderClock();
	}
}

// Page zoom for the sites you visit (set in Settings > Accessibility).
function applyZoom() {
	if (!frame) return;
	const z = Settings.get("zoom") / 100;
	const f = frame.frame;
	if (z === 1) {
		f.style.width = f.style.height = f.style.transform = f.style.transformOrigin = "";
	} else {
		f.style.width = 100 / z + "%";
		f.style.height = `calc((100% - 3rem) / ${z})`;
		f.style.transform = `scale(${z})`;
		f.style.transformOrigin = "0 0";
	}
}

function openFrame() {
	if (frame) return frame;
	frame = scramjet.createFrame();
	frame.frame.id = "frame";
	document.body.appendChild(frame.frame);
	applyZoom();

	frame.addEventListener("urlchange", (event) => {
		if (!isRealPage(event.url)) return;
		currentUrl = event.url;
		barAddress.value = currentUrl;
		Store.addHistory(currentUrl, "");
		updateFavButton();
		Menu.refreshHistory();
	});

	// Once a page has loaded, record its real title.
	frame.frame.addEventListener("load", () => {
		try {
			const title = frame.frame.contentDocument.title;
			if (currentUrl && title) {
				Store.updateTitle(currentUrl, title);
				Menu.refreshHistory();
			}
		} catch {}
	});
	return frame;
}

async function go(input) {
	errorEl.textContent = "";
	errorCode.textContent = "";
	try {
		await startProxy();
		showBrowsing(true);
		openFrame().go(toUrl(input));
	} catch (err) {
		closeFrame();
		errorEl.textContent = "Could not start the proxy.";
		errorCode.textContent = String(err);
		throw err;
	}
}

function closeFrame() {
	if (frame) frame.frame.remove();
	frame = null;
	currentUrl = "";
	barAddress.value = "";
	showBrowsing(false);
}

// ---------- Favorites grid (home page) ----------
function renderFavorites() {
	$("favs").hidden = !Settings.get("showFavs");
	favGrid.textContent = "";

	for (const fav of Store.favorites()) {
		const tile = document.createElement("div");
		tile.className = "tile";

		const open = document.createElement("button");
		open.type = "button";
		open.className = "tile-open";
		const name = document.createElement("span");
		name.className = "name";
		name.textContent = fav.title || hostOf(fav.url);
		open.title = fav.title || fav.url;
		open.append(makeIcon(fav.url, false), name);
		open.addEventListener("click", () => go(fav.url));

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

		tile.append(open, x);
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
	favGrid.appendChild(add);
}

function updateFavButton() {
	const on = currentUrl && Store.isFavorite(currentUrl);
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
});

// ---------- Wiring ----------
homeForm.addEventListener("submit", (event) => {
	event.preventDefault();
	go(homeAddress.value);
});
barForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (barAddress.value.trim()) go(barAddress.value);
});

$("btn-home").addEventListener("click", closeFrame);
$("btn-back").addEventListener("click", () => frame && frame.back());
$("btn-forward").addEventListener("click", () => frame && frame.forward());
$("btn-reload").addEventListener("click", () => frame && frame.reload());

favBtn.addEventListener("click", () => {
	if (!currentUrl) return;
	let title = "";
	try {
		title = frame.frame.contentDocument.title;
	} catch {}
	Store.toggleFavorite(currentUrl, title);
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

// Keyboard shortcuts (only when you're not typing in a box)
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") return Menu.close();
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	const t = event.target;
	if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
	const key = event.key.toLowerCase();
	if (key === "/") {
		event.preventDefault();
		const box = document.body.classList.contains("browsing") ? barAddress : homeAddress;
		box.focus();
		box.select();
	} else if (key === "m") {
		event.preventDefault();
		Menu.toggle();
	} else if (key === "h" && document.body.classList.contains("browsing")) {
		event.preventDefault();
		closeFrame();
	}
});

updatePlaceholder();
renderFavorites();
renderClock();

// Keeps the Chrome address-bar shortcut working: https://YOUR-ADDRESS/?url=%s
const preset = new URLSearchParams(location.search).get("url");
if (preset) {
	homeAddress.value = preset;
	go(preset);
}
