// Import from URL: a web page keeps its look in an email only if its style sheets come with it.
// Email apps can't load linked style sheets, so each one is fetched and put in the page as a <style> block,
// with its own picture and font addresses made full. Pictures are also kept inside the email's width.

const MAX_SHEETS = 4;
const MAX_SHEET_BYTES = 300_000;
const FIT = "<style>img{max-width:100%;height:auto}</style>";

type Fetcher = (url: string) => Promise<Response>;

/** Make the url(...) addresses inside a style sheet full, relative to where the sheet came from. */
export function fullCssUrls(css: string, base: URL): string {
	return css.replace(/url\(\s*(["']?)(?!data:|https?:|#)([^"')]+)\1\s*\)/gi, (m, q: string, v: string) => {
		try {
			return `url(${q}${new URL(v.trim(), base).toString()}${q})`;
		} catch {
			return m;
		}
	});
}

/** Swap the page's linked style sheets for the sheets themselves, and keep pictures inside the email. */
export async function inlineStyleSheets(html: string, page: URL, get: Fetcher = (u) => fetch(u)): Promise<string> {
	const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => /\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag));
	let out = html;
	let n = 0;
	for (const tag of links) {
		const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
		if (!href) continue;
		let at: URL;
		try {
			at = new URL(href.replace(/&amp;/g, "&"), page);
		} catch {
			continue;
		}
		if (at.protocol !== "https:" && at.protocol !== "http:") continue;
		if (n >= MAX_SHEETS) {
			out = out.replace(tag, "");
			continue;
		}
		n++;
		const r = await get(at.toString()).catch(() => null);
		const css = r && r.ok && /css|text\/plain/i.test(r.headers.get("content-type") ?? "text/css") ? (await r.text()).slice(0, MAX_SHEET_BYTES) : "";
		// A sheet we couldn't get is dropped: email apps would only show a broken link.
		out = out.replace(tag, css ? `<style>${fullCssUrls(css, at).replace(/<\/style/gi, "<\\/style")}</style>` : "");
	}
	return /<head\b[^>]*>/i.test(out) ? out.replace(/<head\b[^>]*>/i, (h) => h + FIT) : FIT + out;
}
