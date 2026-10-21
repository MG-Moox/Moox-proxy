"use strict";

/**
 * Turn whatever the user typed into a full URL: a real web address is used
 * as-is, something like "wikipedia.org" gets https://, and anything else
 * becomes a search with the engine chosen in Settings.
 */
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
	const template = typeof Settings !== "undefined" ? Settings.searchTemplate() : "https://duckduckgo.com/?q=%s";
	return template.replace("%s", encodeURIComponent(text));
}
