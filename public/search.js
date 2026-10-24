"use strict";

/**
 * Turn whatever the user typed into a full URL: a real web address is used
 * as-is, something like "wikipedia.org" gets https://, and anything else
 * becomes a search with the engine chosen in Settings.
 */
const SHORTCUTS = {
	yt: "https://www.youtube.com/results?search_query=%s",
	w: "https://en.wikipedia.org/w/index.php?search=%s",
	gh: "https://github.com/search?q=%s",
	r: "https://www.reddit.com/search/?q=%s",
	maps: "https://www.google.com/maps/search/%s",
	img: "https://duckduckgo.com/?iax=images&ia=images&q=%s",
	imdb: "https://www.imdb.com/find/?q=%s",
	so: "https://stackoverflow.com/search?q=%s",
	tw: "https://www.twitch.tv/search?term=%s",
	sp: "https://open.spotify.com/search/%s",
};

function toUrl(input) {
	const text = input.trim();
	try {
		const u = new URL(text);
		if (/^https?:$/.test(u.protocol)) return u.toString();
	} catch {}
	if (!/\s/.test(text) && text.includes(".")) {
		try {
			return new URL("https://" + text).toString();
		} catch {}
	}
	// Shortcuts: "yt cats", "w moon", "gh react", "maps hobart" ...
	const m = /^(\S+)\s+(.+)$/.exec(text);
	if (m && SHORTCUTS[m[1].toLowerCase()]) return SHORTCUTS[m[1].toLowerCase()].replace("%s", encodeURIComponent(m[2]));
	const template = typeof Settings !== "undefined" ? Settings.searchTemplate() : "https://duckduckgo.com/?q=%s";
	return template.replace("%s", encodeURIComponent(text));
}
