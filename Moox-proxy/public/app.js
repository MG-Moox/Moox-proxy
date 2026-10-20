"use strict";

const form = document.getElementById("form");
const address = document.getElementById("address");
const errorEl = document.getElementById("error");
const errorCode = document.getElementById("error-code");

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

async function go(input) {
	errorEl.textContent = "";
	errorCode.textContent = "";
	try {
		await registerSW();

		const wispUrl =
			(location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
		if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
			await connection.setTransport("/libcurl/index.mjs", [{ websocket: wispUrl }]);
		}

		const frame = scramjet.createFrame();
		frame.frame.id = "frame";
		document.getElementById("home").hidden = true;
		document.body.appendChild(frame.frame);
		frame.go(toUrl(input));
	} catch (err) {
		document.getElementById("home").hidden = false;
		errorEl.textContent = "Could not start the proxy.";
		errorCode.textContent = String(err);
		throw err;
	}
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	go(address.value);
});

// Keeps the Chrome address-bar shortcut working: https://YOUR-ADDRESS/?url=%s
const preset = new URLSearchParams(location.search).get("url");
if (preset) {
	address.value = preset;
	go(preset);
}
