"use strict";

// Animated home-page backgrounds drawn on one canvas behind everything:
// stars, snow, bubbles and fireflies. It stops when the tab is hidden or a
// website is open, draws a single still frame if "Reduce motion" is on, and
// never runs faster than 30 frames a second so it stays light on phones.
const Backgrounds = (() => {
	const MODES = new Set(["stars", "snow", "bubbles", "fireflies"]);
	let canvas = null;
	let ctx2d = null;
	let parts = [];
	let mode = "";
	let raf = 0;
	let last = 0;
	let w = 0;
	let h = 0;
	let colors = { fg: "#ffffff", accent: "#2563eb" };

	const rnd = (a, b) => a + Math.random() * (b - a);

	function readColors() {
		const cs = getComputedStyle(document.documentElement);
		colors = { fg: cs.getPropertyValue("--fg").trim() || "#fff", accent: cs.getPropertyValue("--accent").trim() || "#2563eb" };
	}

	function make() {
		const count = Math.max(20, Math.min(110, Math.round((w * h) / 14000)));
		parts = [];
		for (let i = 0; i < count; i++) {
			if (mode === "stars") parts.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(0.4, 1.8), p: rnd(0, 6.28), s: rnd(0.6, 2) });
			else if (mode === "snow") parts.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(1, 3.2), vy: rnd(18, 55), dx: rnd(-12, 12), p: rnd(0, 6.28) });
			else if (mode === "bubbles") parts.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(6, 26), vy: rnd(10, 34), p: rnd(0, 6.28) });
			else parts.push({ x: rnd(0, w), y: rnd(0, h), r: rnd(1.5, 3.2), vx: rnd(-14, 14), vy: rnd(-14, 14), p: rnd(0, 6.28) });
		}
	}

	function resize() {
		if (!canvas) return;
		w = canvas.width = window.innerWidth;
		h = canvas.height = window.innerHeight;
		make();
		frame(0, true);
	}

	function frame(now, still) {
		if (!ctx2d) return;
		const dt = still ? 0 : Math.min(0.1, (now - last) / 1000);
		last = now;
		ctx2d.clearRect(0, 0, w, h);
		const t = now / 1000;
		for (const p of parts) {
			if (mode === "stars") {
				ctx2d.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * p.s + p.p));
				ctx2d.fillStyle = colors.fg;
				ctx2d.beginPath();
				ctx2d.arc(p.x, p.y, p.r, 0, 6.283);
				ctx2d.fill();
			} else if (mode === "snow") {
				p.y += p.vy * dt;
				p.x += (p.dx + Math.sin(t + p.p) * 10) * dt;
				if (p.y > h + 5) (p.y = -5), (p.x = rnd(0, w));
				ctx2d.globalAlpha = 0.7;
				ctx2d.fillStyle = colors.fg;
				ctx2d.beginPath();
				ctx2d.arc(p.x, p.y, p.r, 0, 6.283);
				ctx2d.fill();
			} else if (mode === "bubbles") {
				p.y -= p.vy * dt;
				p.x += Math.sin(t * 0.8 + p.p) * 14 * dt;
				if (p.y < -p.r * 2) (p.y = h + p.r * 2), (p.x = rnd(0, w));
				ctx2d.globalAlpha = 0.35;
				ctx2d.strokeStyle = colors.accent;
				ctx2d.lineWidth = 1.5;
				ctx2d.beginPath();
				ctx2d.arc(p.x, p.y, p.r, 0, 6.283);
				ctx2d.stroke();
			} else {
				p.x += p.vx * dt;
				p.y += p.vy * dt;
				if (p.x < -10) p.x = w + 10;
				if (p.x > w + 10) p.x = -10;
				if (p.y < -10) p.y = h + 10;
				if (p.y > h + 10) p.y = -10;
				ctx2d.globalAlpha = 0.25 + 0.75 * Math.abs(Math.sin(t * 0.9 + p.p));
				ctx2d.fillStyle = colors.accent;
				ctx2d.shadowColor = colors.accent;
				ctx2d.shadowBlur = 12;
				ctx2d.beginPath();
				ctx2d.arc(p.x, p.y, p.r, 0, 6.283);
				ctx2d.fill();
				ctx2d.shadowBlur = 0;
			}
		}
		ctx2d.globalAlpha = 1;
	}

	function loop(now) {
		raf = requestAnimationFrame(loop);
		if (now - last < 33) return; // about 30 fps
		frame(now, false);
	}

	function stop() {
		cancelAnimationFrame(raf);
		raf = 0;
	}

	function shouldRun() {
		const root = document.documentElement;
		return MODES.has(mode) && !document.hidden && !document.body.classList.contains("browsing") && root.dataset.contrast !== "high";
	}

	function sync() {
		const want = Settings.get("bg");
		if (!MODES.has(want)) {
			mode = "";
			stop();
			if (canvas) canvas.hidden = true;
			return;
		}
		if (!canvas) {
			canvas = document.createElement("canvas");
			canvas.id = "bg-canvas";
			canvas.setAttribute("aria-hidden", "true");
			document.body.prepend(canvas);
			ctx2d = canvas.getContext("2d");
		}
		if (want !== mode) {
			mode = want;
			readColors();
			canvas.hidden = false;
			resize();
		}
		stop();
		readColors();
		if (!shouldRun()) return;
		if (document.documentElement.dataset.motion === "reduce") return frame(0, true); // one still frame
		last = 0;
		raf = requestAnimationFrame(loop);
	}

	function init() {
		Settings.onChange(() => sync());
		window.addEventListener("resize", () => canvas && !canvas.hidden && resize());
		document.addEventListener("visibilitychange", sync);
		// Stop drawing while a website is open (the home page is hidden behind it).
		new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
		sync();
	}

	return { init };
})();
