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
const library = $("library");
const libList = $("lib-list");
const libEmpty = $("lib-empty");
const clearBtn = $("btn-clear");

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
let tab = "fav"; // "fav" or "hist"

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
	library.classList.remove("open");
	if (!on) renderLibrary();
}

function openFrame() {
	if (frame) return frame;
	frame = scramjet.createFrame();
	frame.frame.id = "frame";
	document.body.appendChild(frame.frame);

	frame.addEventListener("urlchange", (event) => {
		if (!isRealPage(event.url)) return;
		currentUrl = event.url;
		barAddress.value = currentUrl;
		Store.addHistory(currentUrl, "");
		updateFavButton();
		if (!library.classList.contains("open")) return;
		renderLibrary();
	});

	// Once a page has loaded, record its real title.
	frame.frame.addEventListener("load", () => {
		try {
			const title = frame.frame.contentDocument.title;
			if (currentUrl && title) {
				Store.updateTitle(currentUrl, title);
				if (library.classList.contains("open")) renderLibrary();
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

// ---------- Favorites / history panel ----------
function hostOf(url) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function renderLibrary() {
	const items = tab === "fav" ? Store.favorites() : Store.history();
	$("tab-fav").classList.toggle("active", tab === "fav");
	$("tab-hist").classList.toggle("active", tab === "hist");
	clearBtn.hidden = tab !== "hist" || items.length === 0;

	libList.textContent = "";
	libEmpty.textContent = items.length
		? ""
		: tab === "fav"
			? "No favorites yet. Open a site and press the star."
			: "No history yet.";

	for (const entry of items) {
		const li = document.createElement("li");

		const open = document.createElement("button");
		open.type = "button";
		open.className = "item";
		const t = document.createElement("span");
		t.className = "t";
		t.textContent = entry.title || entry.url;
		const u = document.createElement("span");
		u.className = "u";
		u.textContent = hostOf(entry.url);
		open.append(t, u);
		open.addEventListener("click", () => go(entry.url));

		const del = document.createElement("button");
		del.type = "button";
		del.className = "del";
		del.title = "Remove";
		del.textContent = "×";
		del.addEventListener("click", () => {
			if (tab === "fav") Store.removeFavorite(entry.url);
			else Store.removeHistory(entry.id);
			renderLibrary();
			updateFavButton();
		});

		li.append(open, del);
		libList.appendChild(li);
	}
}

function updateFavButton() {
	const on = currentUrl && Store.isFavorite(currentUrl);
	favBtn.textContent = on ? "★" : "☆";
	favBtn.classList.toggle("on", !!on);
	favBtn.title = on ? "Remove from favorites" : "Add to favorites";
}

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
$("btn-lib").addEventListener("click", () => {
	renderLibrary();
	library.classList.toggle("open");
});
favBtn.addEventListener("click", () => {
	if (!currentUrl) return;
	let title = "";
	try {
		title = frame.frame.contentDocument.title;
	} catch {}
	Store.toggleFavorite(currentUrl, title);
	updateFavButton();
	if (library.classList.contains("open")) renderLibrary();
});

$("tab-fav").addEventListener("click", () => {
	tab = "fav";
	renderLibrary();
});
$("tab-hist").addEventListener("click", () => {
	tab = "hist";
	renderLibrary();
});
clearBtn.addEventListener("click", () => {
	if (confirm("Clear all browsing history saved in this browser?")) {
		Store.clearHistory();
		renderLibrary();
	}
});

renderLibrary();

// Keeps the Chrome address-bar shortcut working: https://YOUR-ADDRESS/?url=%s
const preset = new URLSearchParams(location.search).get("url");
if (preset) {
	homeAddress.value = preset;
	go(preset);
}
