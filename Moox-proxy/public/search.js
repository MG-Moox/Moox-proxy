"use strict";

const SEARCH_TEMPLATE = "https://duckduckgo.com/?q=%s";

/**
 * Turn whatever the user typed into a full URL: a real URL is used as-is,
 * something like "wikipedia.org" gets https://, anything else becomes a search.
 */
function toUrl(input) {
	const text = input.trim();
	try {
		return new URL(text).toString();
	} catch {}
	if (!/\s/.test(text) && text.includes(".")) {
		try {
			return new URL("https://" + text).toString();
		} catch {}
	}
	return SEARCH_TEMPLATE.replace("%s", encodeURIComponent(text));
}
