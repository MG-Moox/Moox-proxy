"use strict";

// Favorites and history, saved in this browser (localStorage). They survive
// server sleeps and redeploys, but they are per-browser and don't sync.
const Store = (() => {
	const KEY_FAV = "moox:favorites";
	const KEY_HIST = "moox:history";
	const MAX_HIST = 300;

	function read(key) {
		try {
			const v = JSON.parse(localStorage.getItem(key));
			return Array.isArray(v) ? v : [];
		} catch {
			return [];
		}
	}
	function write(key, val) {
		try {
			localStorage.setItem(key, JSON.stringify(val));
		} catch {}
	}

	return {
		favorites: () => read(KEY_FAV),
		history: () => read(KEY_HIST),
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
	};
})();
