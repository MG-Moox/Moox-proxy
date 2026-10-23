"use strict";

// Favorites and history, saved in this browser (localStorage). They survive
// server sleeps and redeploys, but they are per-browser and don't sync.
const Store = (() => {
	const KEY_FAV = "moox:favorites";
	const KEY_HIST = "moox:history";
	const KEY_NOTES = "moox:notes";
	const MAX_HIST = 300;

	function read(key) {
		try {
			const v = JSON.parse(localStorage.getItem(key));
			return Array.isArray(v) ? v : [];
		} catch {
			return [];
		}
	}
	const subs = [];
	function write(key, val) {
		try {
			localStorage.setItem(key, JSON.stringify(val));
		} catch {}
		for (const fn of subs) {
			try {
				fn();
			} catch {}
		}
	}

	// Only plain web links with short text are accepted from the server.
	const isWebUrl = (u) => {
		if (typeof u !== "string" || u.length > 2048) return false;
		try {
			return /^https?:$/.test(new URL(u).protocol);
		} catch {
			return false;
		}
	};

	return {
		// Called after any change (used by account.js to sync to the server).
		onChange: (fn) => subs.push(fn),
		// Replace everything with data from the server (validated).
		setAll(data) {
			const favs = (Array.isArray(data && data.favorites) ? data.favorites : [])
				.filter((f) => f && isWebUrl(f.url))
				.slice(0, 500)
				.map((f) => ({ url: f.url, title: String(f.title || f.url).slice(0, 300), added: Number(f.added) || Date.now() }));
			const hist = (Array.isArray(data && data.history) ? data.history : [])
				.filter((h) => h && isWebUrl(h.url))
				.slice(0, MAX_HIST)
				.map((h) => ({
					id: typeof h.id === "string" && h.id.length <= 40 ? h.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
					url: h.url,
					title: String(h.title || h.url).slice(0, 300),
					time: Number(h.time) || Date.now(),
				}));
			write(KEY_FAV, favs);
			write(KEY_HIST, hist);
			if (data && typeof data.notes === "string") {
				try {
					localStorage.setItem(KEY_NOTES, data.notes.slice(0, 8000));
				} catch {}
			}
		},
		favorites: () => read(KEY_FAV),
		history: () => read(KEY_HIST),
		notes() {
			try {
				return localStorage.getItem(KEY_NOTES) || "";
			} catch {
				return "";
			}
		},
		setNotes(text) {
			const t = String(text || "").slice(0, 8000);
			try {
				if (t === (localStorage.getItem(KEY_NOTES) || "")) return;
				localStorage.setItem(KEY_NOTES, t);
			} catch {}
			for (const fn of subs) {
				try {
					fn();
				} catch {}
			}
		},
		isFavorite: (url) => read(KEY_FAV).some((f) => f.url === url),

		// Returns true if the page is now a favorite, false if it was removed.
		toggleFavorite(url, title) {
			const list = read(KEY_FAV);
			const i = list.findIndex((f) => f.url === url);
			if (i >= 0) list.splice(i, 1);
			else list.unshift({ url, title: title || url, added: Date.now() });
			write(KEY_FAV, list);
			return i < 0;
		},
		// Adds a favorite if it isn't there already (never removes).
		addFavorite(url, title) {
			const list = read(KEY_FAV);
			if (list.some((f) => f.url === url)) return false;
			list.push({ url, title: title || url, added: Date.now() });
			write(KEY_FAV, list);
			return true;
		},
		renameFavorite(url, title) {
			const list = read(KEY_FAV);
			const f = list.find((x) => x.url === url);
			const name = String(title || "").trim().slice(0, 300);
			if (!f || !name) return false;
			f.title = name;
			write(KEY_FAV, list);
			return true;
		},
		// Moves a favorite so it ends up at position toIndex (0 = first).
		moveFavorite(url, toIndex) {
			const list = read(KEY_FAV);
			const from = list.findIndex((x) => x.url === url);
			if (from < 0) return false;
			const [item] = list.splice(from, 1);
			list.splice(Math.max(0, Math.min(list.length, Number(toIndex) || 0)), 0, item);
			write(KEY_FAV, list);
			return true;
		},
		removeFavorite(url) {
			write(KEY_FAV, read(KEY_FAV).filter((f) => f.url !== url));
		},

		addHistory(url, title) {
			const list = read(KEY_HIST);
			if (list[0] && list[0].url === url) {
				if (title) list[0].title = title;
			} else {
				list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), url, title: title || url, time: Date.now() });
			}
			write(KEY_HIST, list.slice(0, MAX_HIST));
		},
		// Called once a page has loaded and its real title is known.
		updateTitle(url, title) {
			if (!title) return;
			const hist = read(KEY_HIST);
			if (hist[0] && hist[0].url === url) {
				hist[0].title = title;
				write(KEY_HIST, hist);
			}
			const favs = read(KEY_FAV);
			let changed = false;
			for (const f of favs) {
				if (f.url === url && f.title !== title) {
					f.title = title;
					changed = true;
				}
			}
			if (changed) write(KEY_FAV, favs);
		},
		removeHistory(id) {
			write(KEY_HIST, read(KEY_HIST).filter((h) => h.id !== id));
		},
		clearHistory() {
			write(KEY_HIST, []);
		},
		clearAll() {
			try {
				localStorage.removeItem(KEY_NOTES);
			} catch {}
			write(KEY_FAV, []);
			write(KEY_HIST, []);
		},

		// ----- Backup / restore -----
		exportData() {
			return { favorites: read(KEY_FAV), history: read(KEY_HIST), notes: this.notes() };
		},

		// Merges a backup into what's already saved. Everything is validated, so
		// a damaged or hand-edited file can't break the app. Returns counts added.
		importData(data) {
			const isWeb = (u) => {
				if (typeof u !== "string" || u.length > 2048) return false;
				try {
					return /^https?:$/.test(new URL(u).protocol);
				} catch {
					return false;
				}
			};
			const text = (v, fallback) => String(v == null || v === "" ? fallback : v).slice(0, 300);
			let addedFavs = 0;
			let addedHist = 0;
			if (!data || typeof data !== "object") return { favorites: 0, history: 0 };

			const favs = read(KEY_FAV);
			for (const f of Array.isArray(data.favorites) ? data.favorites.slice(0, 500) : []) {
				if (!f || !isWeb(f.url) || favs.some((x) => x.url === f.url)) continue;
				favs.push({ url: f.url, title: text(f.title, f.url), added: Number(f.added) || Date.now() });
				addedFavs++;
			}
			write(KEY_FAV, favs);

			const hist = read(KEY_HIST);
			const seen = new Set(hist.map((h) => h.id));
			for (const h of Array.isArray(data.history) ? data.history.slice(0, MAX_HIST) : []) {
				if (!h || !isWeb(h.url)) continue;
				const id = typeof h.id === "string" && h.id.length <= 40 ? h.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
				if (seen.has(id)) continue;
				seen.add(id);
				hist.push({ id, url: h.url, title: text(h.title, h.url), time: Number(h.time) || Date.now() });
				addedHist++;
			}
			hist.sort((a, b) => b.time - a.time);
			write(KEY_HIST, hist.slice(0, MAX_HIST));
			if (typeof data.notes === "string" && data.notes && !this.notes()) {
				try {
					localStorage.setItem(KEY_NOTES, data.notes.slice(0, 8000));
				} catch {}
			}

			return { favorites: addedFavs, history: addedHist };
		},
	};
})();
