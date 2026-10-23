"use strict";

// Phone helpers: a warning when Moox is opened inside another app's built-in
// browser (the Google app, Instagram, ...), where proxies often can't work, and
// install help for "Add to Home Screen" (iPhone) / "Install app" (Android).
const Mobile = (() => {
	const ua = navigator.userAgent || "";
	const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
	// Built-in browsers: Google app (GSA), Facebook, Instagram, TikTok, Snapchat, Line, WeChat, Twitter.
	const inApp = /GSA\/|FBAN|FBAV|FB_IAB|Instagram|TikTok|musical_ly|Snapchat|Line\/|MicroMessenger|Twitter/i.test(ua);
	let deferred = null;

	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		deferred = e;
	});
	window.addEventListener("appinstalled", () => {
		deferred = null;
	});

	function warn() {
		const box = document.getElementById("app-warn");
		if (!box || !inApp) return;
		try {
			if (localStorage.getItem("moox:inapp-dismissed")) return;
		} catch {}
		const text = document.createElement("span");
		text.textContent = ios
			? "You're in an app's built-in browser, so Moox may not work properly. Open this page in Safari for the best results."
			: "You're in an app's built-in browser, so Moox may not work properly. Open this page in Chrome for the best results.";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.className = "btn";
		copy.textContent = "Copy link";
		copy.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(location.origin + "/");
				copy.textContent = "Copied";
			} catch {
				copy.textContent = location.origin;
			}
		});
		const x = document.createElement("button");
		x.type = "button";
		x.setAttribute("aria-label", "Dismiss");
		x.textContent = "×";
		x.addEventListener("click", () => {
			box.hidden = true;
			try {
				localStorage.setItem("moox:inapp-dismissed", "1");
			} catch {}
		});
		box.replaceChildren(text, copy, x);
		box.hidden = false;
	}

	return {
		warn,
		inApp,
		ios,
		standalone,
		// What the More tab should say about installing.
		installInfo: () => ({ standalone, ios, canPrompt: Boolean(deferred), inApp }),
		async promptInstall() {
			if (!deferred) return false;
			deferred.prompt();
			try {
				await deferred.userChoice;
			} catch {}
			deferred = null;
			return true;
		},
	};
})();

Mobile.warn();
