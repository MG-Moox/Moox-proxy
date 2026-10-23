"use strict";

// Accounts: usage meter, "time's up" screen, redeeming codes, and syncing your
// favorites/history/settings to your account. Does nothing when the server is
// running without accounts (the old single-password mode).
const Account = (() => {
	const banner = document.getElementById("limit-banner");
	const overlay = document.getElementById("limit-overlay");
	const subs = [];
	let enabled = false;
	let me = null;
	let ctx = { onDataChange() {} };
	let applying = false;
	let syncTimer = 0;
	let pollTimer = 0;
	let fetchedAt = 0;

	const api = async (path, opt) => {
		const res = await fetch(path, { credentials: "same-origin", ...opt });
		let body = null;
		try {
			body = await res.json();
		} catch {}
		if (res.status === 401 && enabled) location.href = "/login?next=" + encodeURIComponent(location.pathname);
		return { ok: res.ok, status: res.status, body };
	};
	const post = (path, data, method = "POST") =>
		api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

	function el(tag, attrs = {}, ...kids) {
		const n = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k === "class") n.className = v;
			else if (k === "text") n.textContent = v;
			else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
			else n.setAttribute(k, v === true ? "" : v);
		}
		for (const kid of kids.flat()) if (kid != null) n.append(kid);
		return n;
	}

	function dur(s) {
		s = Math.max(0, Math.round(s));
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		if (h) return `${h}h ${m}m`;
		if (m) return `${m} min`;
		return `${s}s`;
	}

	// Seconds left / until reset, adjusted for time since we last asked the server.
	const sinceFetch = () => Math.round((Date.now() - fetchedAt) / 1000);
	const resetIn = () => (me ? Math.max(0, me.resetInSeconds - sinceFetch()) : 0);

	// ---------- sync ----------
	function snapshot() {
		return { favorites: Store.favorites(), history: Store.history(), settings: Settings.exportSettings(), notes: Store.notes() };
	}
	function scheduleSync() {
		if (!enabled || applying) return;
		clearTimeout(syncTimer);
		syncTimer = setTimeout(push, 1500);
	}
	async function push() {
		syncTimer = 0;
		try {
			await post("/api/data", { data: snapshot() }, "PUT");
		} catch {}
	}
	async function pull() {
		const r = await api("/api/data");
		if (!r.ok) return;
		if (r.body && r.body.data) {
			applying = true;
			try {
				Store.setAll(r.body.data);
				Settings.importSettings(r.body.data.settings);
			} finally {
				applying = false;
			}
			ctx.onDataChange();
		} else {
			await push(); // first time on this account: upload what's already here
		}
	}

	// ---------- usage ----------
	function notify() {
		for (const fn of subs) {
			try {
				fn(me);
			} catch {}
		}
	}

	async function refresh() {
		const r = await api("/api/me");
		if (!r.ok || !r.body) return;
		me = r.body;
		fetchedAt = Date.now();
		draw();
		notify();
	}

	function drawAnnouncement() {
		const box = document.getElementById("announce-banner");
		const text = me && me.announcement ? me.announcement : "";
		let dismissed = "";
		try {
			dismissed = localStorage.getItem("moox:announce-dismissed") || "";
		} catch {}
		if (!text || dismissed === text) {
			box.hidden = true;
			return;
		}
		box.replaceChildren(
			el("span", { text }),
			el("button", {
				type: "button",
				"aria-label": "Dismiss message",
				text: "\u00d7",
				onclick: () => {
					try {
						localStorage.setItem("moox:announce-dismissed", text);
					} catch {}
					box.hidden = true;
				},
			})
		);
		box.hidden = false;
	}

	function draw() {
		if (!me) return;
		drawAnnouncement();
		// Low-time banner
		const left = me.remainingSeconds;
		if (!me.premium && !me.limited && left != null && left <= 600) {
			banner.textContent = me.guest
				? `${dur(left)} of guest time left. Sign up for more, free.`
				: `${dur(left)} of free time left today. It resets at midnight Sydney time.`;
			banner.hidden = false;
		} else banner.hidden = true;
		// "Used up" screen
		if (me.limited) showLimit();
		else if (!overlay.hidden) overlay.hidden = true;
	}

	function showLimit() {
		if (!overlay.hidden) return;
		const msg = el("p", { role: "status", "aria-live": "polite" });
		const code = el("input", { type: "text", placeholder: "XXXX-XXXX-XXXX-XXXX", maxlength: "25", autocomplete: "off", "aria-label": "Unlock code" });
		const countdown = el("strong");
		const tick = () => (countdown.textContent = dur(resetIn()));
		tick();
		const timer = setInterval(() => {
			if (overlay.hidden) return clearInterval(timer);
			tick();
			if (resetIn() <= 0) refresh();
		}, 1000);
		if (me.guest) {
			overlay.replaceChildren(
				el(
					"div",
					{ class: "limit-card" },
					el("h2", { id: "limit-title", text: "Your guest time is up" }),
					el("p", { text: "Log in or sign up to keep browsing. It's free." }),
					el(
						"div",
						{ class: "btn-row center" },
						el("a", { class: "btn primary", href: "/login", text: "Log in" }),
						el("a", { class: "btn", href: "/login#signup", text: "Sign up" })
					),
					el("p", { class: "muted" }, "Guest time comes back at midnight Sydney time, in ", countdown, ".")
				)
			);
			overlay.hidden = false;
			overlay.querySelector("a").focus();
			return;
		}
		overlay.replaceChildren(
			el(
				"div",
				{ class: "limit-card" },
				el("h2", { id: "limit-title", text: "You've used your free time today" }),
				el("p", {}, "Your free time comes back at midnight Sydney time, in ", countdown, "."),
				el("p", { class: "muted", text: "Have an unlock code? Enter it for unlimited time." }),
				el(
					"form",
					{
						class: "limit-form",
						onsubmit: async (e) => {
							e.preventDefault();
							const r = await post("/api/redeem", { code: code.value });
							if (r.ok) {
								me = r.body.me;
								fetchedAt = Date.now();
								draw();
								notify();
							} else msg.textContent = (r.body && r.body.error) || "Something went wrong.";
						},
					},
					code,
					el("button", { type: "submit", class: "btn primary", text: "Unlock" })
				),
				msg,
				el("button", { type: "button", class: "btn", text: "Log out", onclick: () => (location.href = "/logout") })
			)
		);
		overlay.hidden = false;
		code.focus();
	}

	// ---------- the Account tab (drawn by menu.js) ----------
	function renderTab(body, say) {
		if (!me) return body.append(el("p", { class: "hint", text: "Loading…" }));
		if (me.guest) {
			const gm = el("div", { class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(me.limitSeconds), "aria-valuenow": String(me.usedSeconds) });
			gm.append(el("div", { class: "meter-fill", style: `width:${Math.min(100, (me.usedSeconds / me.limitSeconds) * 100)}%` }));
			return body.append(
				el(
					"fieldset",
					{ class: "group" },
					el("h3", { text: "Guest" }),
					el("p", { text: "You're browsing as a guest. Nothing is saved to an account." }),
					gm,
					el("p", { class: "hint", text: `${dur(me.usedSeconds)} used of ${dur(me.limitSeconds)} today. Resets in ${dur(resetIn())} (midnight Sydney time).` }),
					el("div", { class: "btn-row" }, el("a", { class: "btn primary", href: "/login", text: "Log in" }), el("a", { class: "btn", href: "/login#signup", text: "Sign up" })),
					el("p", { class: "hint", text: "A free account gets more time every day and saves your favorites, notes and settings." })
				)
			);
		}
		const used = me.usedSeconds;
		const meter = el("div", { class: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(me.limitSeconds || 0) });
		if (me.premium) {
			meter.hidden = true;
		} else {
			meter.setAttribute("aria-valuenow", String(used));
			meter.append(el("div", { class: "meter-fill", style: `width:${Math.min(100, (used / me.limitSeconds) * 100)}%` }));
		}
		const plan = me.premium
			? me.premiumUntil === "never"
				? "Unlimited"
				: "Unlimited until " + new Date(me.premiumUntil).toLocaleDateString()
			: "Free";

		const code = el("input", { type: "text", placeholder: "XXXX-XXXX-XXXX-XXXX", maxlength: "25", autocomplete: "off", "aria-label": "Unlock code" });
		const oldPw = el("input", { type: "password", autocomplete: "current-password", placeholder: "Current password", "aria-label": "Current password" });
		const newPw = el("input", { type: "password", autocomplete: "new-password", placeholder: "New password (8+ characters)", "aria-label": "New password" });

		body.append(
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Your account" }),
				el("p", {}, el("strong", { text: me.username }), " · " + plan),
				meter,
				me.premium
					? null
					: el("p", {
							class: "hint",
							text: `${dur(me.usedSeconds)} used of ${dur(me.limitSeconds)} today. Resets in ${dur(resetIn())} (midnight Sydney time).`,
					  })
			),
			me.premium && me.premiumUntil === "never"
				? null
				: el(
						"fieldset",
						{ class: "group" },
						el("h3", { text: "Unlock code" }),
						el("p", { class: "hint", text: "A code gives unlimited time. Each code works once." }),
						el(
							"form",
							{
								class: "btn-row",
								onsubmit: async (e) => {
									e.preventDefault();
									const r = await post("/api/redeem", { code: code.value });
									if (r.ok) {
										me = r.body.me;
										fetchedAt = Date.now();
										draw();
										notify();
										say("Code accepted. You now have unlimited time.");
									} else say((r.body && r.body.error) || "Something went wrong.");
								},
							},
							code,
							el("button", { type: "submit", class: "btn primary", text: "Unlock" })
						)
				  ),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Change password" }),
				el(
					"form",
					{
						class: "stack",
						onsubmit: async (e) => {
							e.preventDefault();
							const r = await post("/api/password", { old: oldPw.value, next: newPw.value });
							if (r.ok) {
								oldPw.value = newPw.value = "";
								say("Password changed. Other devices were logged out.");
							} else say((r.body && r.body.error) || "Something went wrong.");
						},
					},
					oldPw,
					newPw,
					el("button", { type: "submit", class: "btn", text: "Change password" })
				),
				el("p", { class: "hint", text: "There is no password reset, so keep your password safe." })
			),
			el(
				"fieldset",
				{ class: "group" },
				el("h3", { text: "Devices and data" }),
				el(
					"div",
					{ class: "btn-row" },
					el("button", {
						type: "button",
						class: "btn",
						text: "Log out my other devices",
						onclick: async () => {
							const r = await post("/api/logout-others", {});
							say(r.ok ? "Done. Every other device was logged out." : "Something went wrong.");
						},
					}),
					el("button", {
						type: "button",
						class: "btn danger",
						text: "Delete my account",
						onclick: async () => {
							if (!confirm("Delete your account and everything saved in it? This can't be undone.")) return;
							const pw = prompt("Type your password to confirm:");
							if (!pw) return;
							const r = await post("/api/delete-account", { password: pw });
							if (r.ok) location.href = "/login";
							else say((r.body && r.body.error) || "Something went wrong.");
						},
					})
				)
			),
			el("p", { class: "hint", text: "Your favorites, history and settings are saved to your account automatically." })
		);
	}

	function startPolling() {
		pollTimer = setInterval(refresh, 30000);
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) refresh();
		});
	}

	// A guest: no saved data and no syncing, just the time meter and the limit screen.
	function startGuest() {
		startPolling();
	}

	// ---------- start ----------
	async function init(context) {
		ctx = context || ctx;
		let r;
		try {
			r = await api("/api/me");
		} catch {
			return;
		}
		// No accounts on this server (single-password mode): stay out of the way.
		if (!r.ok || !r.body || typeof r.body.username !== "string") return;
		enabled = true;
		me = r.body;
		fetchedAt = Date.now();
		document.getElementById("tab-account").hidden = false;
		draw();
		notify();
		if (me.guest) return startGuest();
		Store.onChange(scheduleSync);
		Settings.onChange(scheduleSync);
		await pull();
		startPolling();
		window.addEventListener("pagehide", () => {
			if (syncTimer) {
				clearTimeout(syncTimer);
				syncTimer = 0;
				try {
					fetch("/api/data", { method: "PUT", keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: snapshot() }) });
				} catch {}
			}
		});
	}

	return {
		init,
		enabled: () => enabled,
		isGuest: () => Boolean(me && me.guest),
		username: () => (me && !me.guest ? me.username : ""),
		renderTab,
		onChange: (fn) => subs.push(fn),
		refresh,
	};
})();
