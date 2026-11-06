// Turns an email into the HTML and plain text versions that go out, and fills in each reader's name and their own
// unsubscribe link. Pure functions, so the tests (and the editor's preview) use exactly what's sent.
//
// An email is HTML: from the visual editor (a piece our template goes round), or a whole designed email someone
// pasted or uploaded (which keeps its own look). Emails from before the visual editor are blocks, turned into HTML.

import { POLL_TAG } from "./polls.ts";

export type Block =
	| { type: "heading"; text: string }
	| { type: "text"; text: string }
	| { type: "image"; src: string; alt?: string; href?: string }
	| { type: "button"; label: string; href: string }
	| { type: "divider" };

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const safeUrl = (u: string) => (/^(https?:|mailto:)/i.test(u.trim()) ? u.trim() : /^\{\{\s*\w+\s*\}\}$/.test(u.trim()) ? u.trim() : "#");

/** The blocks from the editor, tidied: unknown kinds and empty blocks dropped, sizes capped. */
export function cleanBlocks(x: unknown): Block[] {
	if (!Array.isArray(x)) return [];
	const out: Block[] = [];
	const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
	for (const b of x.slice(0, 200)) {
		const t = (b as any)?.type;
		if (t === "heading" && str((b as any).text, 300).trim()) out.push({ type: "heading", text: str((b as any).text, 300) });
		else if (t === "text" && str((b as any).text, 20000).trim()) out.push({ type: "text", text: str((b as any).text, 20000) });
		else if (t === "image" && str((b as any).src, 2000).trim()) out.push({ type: "image", src: str((b as any).src, 2000).trim(), alt: str((b as any).alt, 300), href: str((b as any).href, 2000).trim() || undefined });
		else if (t === "button" && str((b as any).label, 120).trim() && str((b as any).href, 2000).trim()) out.push({ type: "button", label: str((b as any).label, 120), href: str((b as any).href, 2000).trim() });
		else if (t === "divider") out.push({ type: "divider" });
	}
	return out;
}

export interface Reader {
	email: string;
	name?: string | null;
	fields?: Record<string, string>;
}

/** {{name}}, {{first_name}}, {{email}} and {{any_field}}, each with an optional fallback: {{first_name|there}}. */
export function merge(text: string, r: Reader, out: (s: string) => string = (s) => s): string {
	return text.replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi, (_all, key: string, fallback = "") => {
		const k = key.toLowerCase();
		const name = (r.name ?? "").trim();
		let v = "";
		if (k === "email") v = r.email;
		else if (k === "name") v = name;
		else if (k === "first_name") v = name.split(/\s+/)[0] ?? "";
		else v = r.fields?.[k] ?? "";
		return out(v.trim() || fallback.trim());
	});
}

/** Inline formatting inside a paragraph: escapes everything, then **bold**, *italic* and [text](url). */
function inline(s: string, colour: string): string {
	let out = esc(s);
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${esc(safeUrl(url.replace(/&amp;/g, "&")))}" style="color:${colour};text-decoration:underline">${label}</a>`);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
	return out.replace(/\n/g, "<br>");
}

export interface Look {
	brandName: string;
	colour: string;
	logo?: string | null;
	footer?: string | null;
	preheader?: string | null;
	unsubscribeUrl: string;
	/** The web version, when the archive is on. */
	webUrl?: string | null;
	/** The reader's own page to change their name and lists. */
	manageUrl?: string | null;
	/** A page to share this email with a friend (it signs them up, never emails them). */
	forwardUrl?: string | null;
	/** Which of those links the footer shows: 1 = manage, 2 = forward. */
	footerLinks?: number;
	/** Opens and clicks, each only when switched on: links go through `link`, and `pixel` is an invisible picture. */
	track?: { link?: ((url: string, n: number) => string) | null; pixel?: string | null } | null;
	/** Each reader's own address for a poll answer (polls.ts). Without it, poll answers link to the web version. */
	poll?: ((id: string, n: number) => string) | null;
}

export interface Rendered {
	html: string;
	text: string;
	/** Every web link in the email, in order (what click counts are kept against). */
	links: string[];
}

/** What an email is made of: blocks (emails from before the visual editor) or HTML. */
export type Content = Block[] | string;

/** Blocks as HTML, the way the visual editor starts them off. Merge tags are left in. */
export function blocksToHtml(blocks: Block[], colour = "#a3195b"): string {
	const parts: string[] = [];
	for (const b of blocks) {
		if (b.type === "heading") parts.push(`<h2>${esc(b.text)}</h2>`);
		else if (b.type === "text") for (const p of b.text.split(/\n{2,}/)) p.trim() && parts.push(`<p>${inline(p.trim(), colour)}</p>`);
		else if (b.type === "image") {
			const img = `<img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt ?? "")}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:8px">`;
			parts.push(`<div style="margin:8px 0 20px">${b.href ? `<a href="${esc(safeUrl(b.href))}">${img}</a>` : img}</div>`);
		} else if (b.type === "button") parts.push(buttonHtml(b.label, b.href, colour));
		else if (b.type === "divider") parts.push(`<hr>`);
	}
	return parts.join("\n");
}

/** A button that works in every email app (a table cell, not CSS). */
export function buttonHtml(label: string, href: string, colour: string): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="background:${colour};border-radius:8px"><a href="${esc(safeUrl(href))}" style="display:inline-block;padding:14px 24px;font:600 16px Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none">${esc(label)}</a></td></tr></table>`;
}

/** Is this a whole designed email (its own <html> and <body>), not a piece the template goes round? */
export const isDocument = (html: string) => /<html[\s>]|<body[\s>]/i.test(html);

/** Takes out anything that could run code: scripts, frames, forms, on... handlers and javascript: links. */
export function sanitise(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
		.replace(/<\/?(script|iframe|frame|frameset|object|embed|applet|form|base)\b[^>]*>/gi, "")
		.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
		.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\b(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(?:javascript|vbscript|data:text\/html)[^"'>\s]*\2/gi, '$1="#"');
}

/** Merge tags inside HTML: each reader's details go in escaped. */
function mergeHtml(html: string, r: Reader): string {
	return merge(html.replace(/\{\{([^}]*)\}\}/g, (m) => m.replace(/&amp;/g, "&").replace(/&quot;/g, '"')), r, esc);
}

const DEFAULT_STYLES: Record<string, (c: string) => string> = {
	p: () => "margin:0 0 16px;font:16px/1.6 Helvetica,Arial,sans-serif;color:#3d2f45",
	h1: () => "margin:28px 0 12px;font:800 28px/1.25 Helvetica,Arial,sans-serif;color:#1d1424",
	h2: () => "margin:28px 0 12px;font:700 24px/1.3 Helvetica,Arial,sans-serif;color:#1d1424",
	h3: () => "margin:24px 0 10px;font:700 19px/1.3 Helvetica,Arial,sans-serif;color:#1d1424",
	ul: () => "margin:0 0 16px;padding-left:24px;font:16px/1.6 Helvetica,Arial,sans-serif;color:#3d2f45",
	ol: () => "margin:0 0 16px;padding-left:24px;font:16px/1.6 Helvetica,Arial,sans-serif;color:#3d2f45",
	li: () => "margin:0 0 6px",
	a: (c) => `color:${c};text-decoration:underline`,
	img: () => "max-width:100%;height:auto;border:0",
	hr: () => "border:0;border-top:1px solid #eadfe5;margin:28px 0",
	blockquote: () => "margin:0 0 16px;padding:4px 0 4px 16px;border-left:4px solid #eadfe5;color:#4a3b52",
};

/** Email apps ignore most style sheets, so plain tags from the editor get their look written onto them. */
function styleTags(html: string, colour: string): string {
	return html.replace(/<(p|h1|h2|h3|ul|ol|li|a|img|hr|blockquote)\b(?![^>]*\bstyle\s*=)([^>]*)>/gi, (_m, tag: string, rest: string) => `<${tag} style="${DEFAULT_STYLES[tag.toLowerCase()](colour)}"${rest}>`);
}

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

/** The plain text version of an HTML email. */
export function htmlToText(html: string): string {
	let s = html.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "");
	s = s.replace(/<div[^>]*display:\s*none[\s\S]*?<\/div>/gi, "");
	s = s.replace(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href: string, inner: string) => {
		const label = decode(inner.replace(/<[^>]+>/g, "")).trim();
		const url = decode(href);
		if (!/^https?:/i.test(url)) return label;
		return !label || label === url ? url : `${label} (${url})`;
	});
	s = s.replace(/<img\b[^>]*alt\s*=\s*(["'])([^"']+)\1[^>]*>/gi, "[$2]");
	s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n- ").replace(/<hr\b[^>]*>/gi, "\n----------\n");
	s = s.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, t: string) => `${t.toUpperCase()}\n\n`).replace(/<\/(p|div|tr|table|ul|ol|blockquote)>/gi, "\n\n");
	s = decode(s.replace(/<[^>]+>/g, ""));
	return s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Merge tags from Sendy and Mailchimp, turned into ours, so a design brought over from either works as it is. */
export function foreignTags(h: string): string {
	return h
		.replace(/\[Name,\s*fallback=([^\]]*)\]/gi, "{{first_name|$1}}").replace(/\[Name\]/gi, "{{first_name}}").replace(/\[Email\]/gi, "{{email}}")
		.replace(/\[unsubscribe\]/gi, "{{unsubscribe_url}}").replace(/\[webversion\]/gi, "{{web_url}}")
		.replace(/\*\|FNAME\|\*/g, "{{first_name}}").replace(/\*\|EMAIL\|\*/g, "{{email}}").replace(/\*\|UNSUB\|\*/g, "{{unsubscribe_url}}").replace(/\*\|ARCHIVE\|\*/g, "{{web_url}}");
}

/** The email for one reader. Pass a reader of { email: "" } with no tracking for the archive and previews. */
export function renderEmail(subject: string, content: Content, look: Look, reader: Reader): Rendered {
	const colour = /^#[0-9a-f]{6}$/i.test(look.colour) ? look.colour : "#a3195b";
	let body = foreignTags(sanitise(typeof content === "string" ? content : blocksToHtml(content, colour)));
	const whole = isDocument(body);
	const specials = (h: string) => h.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, esc(look.unsubscribeUrl)).replace(/\{\{\s*web_url\s*\}\}/gi, esc(look.webUrl ?? "")).replace(/\{\{\s*manage_url\s*\}\}/gi, esc(look.manageUrl ?? look.unsubscribeUrl)).replace(/\{\{\s*forward_url\s*\}\}/gi, esc(look.forwardUrl ?? look.webUrl ?? "")).replace(POLL_TAG, (_m, id: string, n: string) => esc(look.poll ? look.poll(id.toLowerCase(), Number(n)) : look.webUrl ?? "#"));
	// The plain text version shows the real links, not the click counting ones.
	const bodyText = htmlToText(mergeHtml(specials(body), reader));
	// Every web link, counted when clicks are on. Links with merge tags in them stay as they are.
	const links: string[] = [];
	body = body.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi, (all, pre: string, q: string, raw: string) => {
		const url = decode(raw).trim();
		if (!/^https?:\/\//i.test(url) || url.includes("{{")) return all;
		links.push(url);
		const out = look.track?.link ? look.track.link(url, links.length) : url;
		return `${pre}${q}${esc(out)}${q}`;
	});
	const ownUnsub = /\{\{\s*unsubscribe_url\s*\}\}/i.test(body);
	body = mergeHtml(specials(body), reader);
	const pre = look.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(merge(look.preheader, reader))}${"&#8204;&nbsp;".repeat(40)}</div>` : "";
	const foot = [
		look.footer ? esc(look.footer) : "",
		`You're getting this because you signed up to ${esc(look.brandName)}.`,
		[
			`<a href="${esc(look.unsubscribeUrl)}" style="color:#6b5a73">Unsubscribe</a>`,
			look.manageUrl && (look.footerLinks ?? 1) & 1 ? `<a href="${esc(look.manageUrl)}" style="color:#6b5a73">Manage your subscription</a>` : "",
			look.webUrl ? `<a href="${esc(look.webUrl)}" style="color:#6b5a73">View in your browser</a>` : "",
			look.forwardUrl && (look.footerLinks ?? 1) & 2 ? `<a href="${esc(look.forwardUrl)}" style="color:#6b5a73">Forward to a friend</a>` : "",
		].filter(Boolean).join(" · "),
	].filter(Boolean).join("<br>");
	const footHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto"><tr><td style="padding:20px 28px;font:13px/1.6 Helvetica,Arial,sans-serif;color:#6b5a73;text-align:center">${foot}</td></tr></table>`;
	const pixel = look.track?.pixel ? `<img src="${esc(look.track.pixel)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : "";
	let html: string;
	if (whole) {
		// A designed email keeps its own look. We add the preview text, and the unsubscribe footer unless it has its own link.
		html = /<body\b[^>]*>/i.test(body) ? body.replace(/<body\b[^>]*>/i, (b) => b + pre) : pre + body;
		const end = (ownUnsub ? "" : footHtml) + pixel;
		html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${end}</body>`) : html + end;
		if (!/^\s*<!doctype/i.test(html)) html = `<!doctype html>\n${html}`;
	} else {
		const head = look.logo
			? `<img src="${esc(look.logo)}" alt="${esc(look.brandName)}" height="40" style="display:block;height:40px;width:auto;border:0">`
			: `<div style="font:800 20px Helvetica,Arial,sans-serif;color:${colour}">${esc(look.brandName)}</div>`;
		html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(merge(subject, reader))}</title></head><body style="margin:0;padding:0;background:#f7f2f5">${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2f5"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px"><tr><td style="padding:28px 28px 8px">${head}</td></tr><tr><td style="padding:8px 28px 20px">${styleTags(body, colour)}</td></tr></table>${ownUnsub ? "" : footHtml}${pixel}</td></tr></table></body></html>`;
	}
	const plain = [bodyText, "", "--", look.footer ?? "", `Unsubscribe: ${look.unsubscribeUrl}`, look.webUrl ? `View in your browser: ${look.webUrl}` : ""].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim() + "\n";
	return { html, text: plain, links };
}

/** Is there anything in this email yet? */
export function hasContent(content: Content): boolean {
	return typeof content === "string" ? htmlToText(content).trim().length > 0 || /<img\b/i.test(content) : content.length > 0;
}

/** The headers every newsletter carries: one click unsubscribe (RFC 8058), which Gmail and Yahoo ask bulk senders for. */
export function listHeaders(unsubscribeUrl: string, listId: string): Record<string, string> {
	return { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "List-Id": `<${listId}>` };
}

/** A web address part from a subject: "Spring news!" becomes "spring-news". */
export function slugify(s: string): string {
	return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "campaign";
}
