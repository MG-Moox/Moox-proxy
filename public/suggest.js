"use strict";

// Suggestions dropdown for the address boxes. Shows matching favorites and
// history instantly, plus search suggestions from the server (/suggest) when
// that setting is on.
const Suggest = (() => {
	const box = document.getElementById("suggest");
	let ctx = null; // { makeIcon, hostOf }
	let current = null; // { input, pick } for the box being typed in
	let rows = [];
	let active = -1;
	let timer = 0;
	let aborter = null;
	let seq = 0;

	function init(context) {
		ctx = context;
		window.addEventListener("resize", position);
		// Click anywhere else closes the list (clicks on the list itself don't blur the input).
		document.addEventListener("mousedown", (e) => {
			if (box.hidden) return;
			if (box.contains(e.target) || (current && e.target === current.input)) return;
			hide();
		});
	}

	function attach(input, pick) {
		input.setAttribute("role", "combobox");
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-controls", "suggest");
		input.setAttribute("aria-expanded", "false");
		input.addEventListener("input", () => {
			current = { input, pick };
			schedule();
		});
		input.addEventListener("keydown", (e) => keydown(e, input));
		input.addEventListener("blur", () => {
			setTimeout(() => {
				if (current && current.input === input && document.activeElement !== input) hide();
			}, 120);
		});
	}

	// ---------- data ----------
	function localMatches(q) {
		const needle = q.toLowerCase();
		const seen = new Set();
		const out = [];
		for (const e of [...Store.favorites(), ...Store.history()]) {
			if (seen.has(e.url)) continue;
			if (((e.title || "") + " " + e.url).toLowerCase().includes(needle)) {
				seen.add(e.url);
				out.push({ kind: "site", url: e.url, title: e.title || e.url });
				if (out.length >= 4) break;
			}
		}
		return out;
	}

	function wantsRemote(q) {
		return Settings.get("suggestions") && q.length >= 2 && !q.includes("://") && /[a-z]/i.test(q);
	}

	function schedule() {
		clearTimeout(timer);
		if (aborter) aborter.abort();
		const input = current.input;
		const q = input.value.trim();
		if (!q) return hide();
		render(localMatches(q), []);
		if (!wantsRemote(q)) return;
		const mine = ++seq;
		timer = setTimeout(async () => {
			aborter = new AbortController();
			try {
				const r = await fetch("/suggest?q=" + encodeURIComponent(q), { signal: aborter.signal, credentials: "same-origin" });
				if (!r.ok) return;
				const data = await r.json();
				if (mine !== seq || input.value.trim() !== q) return;
				const list = (Array.isArray(data.suggestions) ? data.suggestions : []).filter((s) => typeof s === "string").slice(0, 6);
				render(localMatches(q), list);
			} catch {}
		}, 160);
	}

	// ---------- drawing ----------
	function magnifier() {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("width", "18");
		svg.setAttribute("height", "18");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("class", "sug-mag");
		const c = document.createElementNS(ns, "circle");
		c.setAttribute("cx", "10");
		c.setAttribute("cy", "10");
		c.setAttribute("r", "6");
		const l = document.createElementNS(ns, "line");
		l.setAttribute("x1", "15");
		l.setAttribute("y1", "15");
		l.setAttribute("x2", "21");
		l.setAttribute("y2", "21");
		for (const n of [c, l]) {
			n.setAttribute("fill", "none");
			n.setAttribute("stroke", "currentColor");
			n.setAttribute("stroke-width", "2.2");
			n.setAttribute("stroke-linecap", "round");
		}
		svg.append(c, l);
		return svg;
	}

	function render(local, remote) {
		const typed = current.input.value.trim().toLowerCase();
		// Remember the highlighted row so late-arriving results don't wipe the selection.
		const keep = active >= 0 && rows[active] ? rows[active] : null;
		const same = (a, b) => a.kind === b.kind && (a.kind === "site" ? a.url === b.url : a.text === b.text);
		rows = [...local, ...remote.filter((s) => s.toLowerCase() !== typed).map((text) => ({ kind: "search", text }))];
		active = keep ? rows.findIndex((r) => same(r, keep)) : -1;
		box.textContent = "";
		if (!rows.length) return hide();

		rows.forEach((row, i) => {
			const li = document.createElement("li");
			li.id = "sug-" + i;
			li.setAttribute("role", "option");
			li.setAttribute("aria-selected", "false");
			const label = document.createElement("span");
			label.className = "sug-text";
			if (row.kind === "site") {
				label.textContent = row.title;
				const sub = document.createElement("span");
				sub.className = "sug-sub";
				sub.textContent = ctx.hostOf(row.url);
				label.append(sub);
				li.append(ctx.makeIcon(row.url, true), label);
			} else {
				label.textContent = row.text;
				li.append(magnifier(), label);
			}
			li.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
			li.addEventListener("click", () => choose(row));
			box.append(li);
		});
		box.hidden = false;
		current.input.setAttribute("aria-expanded", "true");
		position();
		highlight(active);
	}

	function position() {
		if (box.hidden || !current) return;
		const r = current.input.getBoundingClientRect();
		box.style.left = r.left + "px";
		box.style.top = r.bottom + 4 + "px";
		box.style.width = r.width + "px";
	}

	function hide() {
		clearTimeout(timer);
		if (aborter) aborter.abort();
		seq++;
		box.hidden = true;
		rows = [];
		active = -1;
		if (current) {
			current.input.setAttribute("aria-expanded", "false");
			current.input.removeAttribute("aria-activedescendant");
		}
	}

	function highlight(i) {
		active = i;
		[...box.children].forEach((li, idx) => li.setAttribute("aria-selected", String(idx === i)));
		if (i >= 0) {
			current.input.setAttribute("aria-activedescendant", "sug-" + i);
			box.children[i].scrollIntoView({ block: "nearest" });
		} else {
			current.input.removeAttribute("aria-activedescendant");
		}
	}

	function choose(row) {
		const pick = current.pick;
		current.input.value = row.kind === "site" ? row.url : row.text;
		hide();
		pick(row.kind === "site" ? row.url : row.text);
	}

	function keydown(e, input) {
		if (box.hidden || !current || current.input !== input) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			highlight((active + 1) % rows.length);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlight(active <= 0 ? rows.length - 1 : active - 1);
		} else if (e.key === "Enter" && active >= 0) {
			e.preventDefault();
			choose(rows[active]);
		} else if (e.key === "Escape") {
			hide();
		} else if (e.key === "Tab") {
			hide();
		}
	}

	return { init, attach, hide };
})();
