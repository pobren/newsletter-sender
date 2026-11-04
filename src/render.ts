// Turns an email made of blocks into the HTML and plain text versions that go out, and fills in each reader's name
// and their own unsubscribe link. Pure functions, so the tests (and the editor's preview) use exactly what's sent.
//
// Blocks: heading, text (paragraphs with **bold**, *italic* and [links](https://...)), image, button and divider.

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
export function merge(text: string, r: Reader): string {
	return text.replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi, (_all, key: string, fallback = "") => {
		const k = key.toLowerCase();
		const name = (r.name ?? "").trim();
		let v = "";
		if (k === "email") v = r.email;
		else if (k === "name") v = name;
		else if (k === "first_name") v = name.split(/\s+/)[0] ?? "";
		else v = r.fields?.[k] ?? "";
		return v.trim() || fallback.trim();
	});
}

/** Inline formatting inside a paragraph: escapes everything, then **bold**, *italic* and [text](url). */
function inline(s: string, link: (url: string) => string, colour: string): string {
	let out = esc(s);
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${esc(link(safeUrl(url.replace(/&amp;/g, "&"))))}" style="color:${colour};text-decoration:underline">${label}</a>`);
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
	return out.replace(/\n/g, "<br>");
}

const plainInline = (s: string) => s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2");

export interface Look {
	brandName: string;
	colour: string;
	logo?: string | null;
	footer?: string | null;
	preheader?: string | null;
	unsubscribeUrl: string;
	/** The web version, when the archive is on. */
	webUrl?: string | null;
	/** Opens and clicks, when switched on: wraps each link, and an invisible picture. */
	track?: { link: (url: string, n: number) => string; pixel: string } | null;
}

export interface Rendered {
	html: string;
	text: string;
	/** Every link in the email, in order (what click counts are kept against). */
	links: string[];
}

/** The email for one reader. Pass a reader of { email: "" } with no tracking for the archive and previews. */
export function renderEmail(subject: string, blocks: Block[], look: Look, reader: Reader): Rendered {
	const colour = /^#[0-9a-f]{6}$/i.test(look.colour) ? look.colour : "#a3195b";
	const links: string[] = [];
	const link = (url: string) => {
		if (url === "#" || url.startsWith("mailto:") || url.includes("{{")) return url;
		links.push(url);
		return look.track ? look.track.link(url, links.length) : url;
	};
	const m = (s: string) => merge(s, reader);
	const parts: string[] = [];
	const text: string[] = [];
	for (const b of blocks) {
		if (b.type === "heading") {
			parts.push(`<h2 style="margin:28px 0 12px;font:700 24px/1.3 Helvetica,Arial,sans-serif;color:#1d1424">${esc(m(b.text))}</h2>`);
			text.push(m(b.text).toUpperCase(), "");
		} else if (b.type === "text") {
			for (const p of m(b.text).split(/\n{2,}/)) {
				if (!p.trim()) continue;
				parts.push(`<p style="margin:0 0 16px;font:16px/1.6 Helvetica,Arial,sans-serif;color:#3d2f45">${inline(p.trim(), link, colour)}</p>`);
				text.push(plainInline(p.trim()), "");
			}
		} else if (b.type === "image") {
			const img = `<img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt ?? "")}" width="560" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:8px">`;
			parts.push(`<div style="margin:8px 0 20px">${b.href ? `<a href="${esc(link(safeUrl(b.href)))}">${img}</a>` : img}</div>`);
			if (b.alt) text.push(`[${b.alt}]`, "");
		} else if (b.type === "button") {
			parts.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="background:${colour};border-radius:8px"><a href="${esc(link(safeUrl(b.href)))}" style="display:inline-block;padding:14px 24px;font:600 16px Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none">${esc(m(b.label))}</a></td></tr></table>`);
			text.push(`${m(b.label)}: ${b.href}`, "");
		} else if (b.type === "divider") {
			parts.push(`<hr style="border:0;border-top:1px solid #eadfe5;margin:28px 0">`);
			text.push("----------", "");
		}
	}
	const pre = look.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(m(look.preheader))}${"&#8204;&nbsp;".repeat(40)}</div>` : "";
	const head = look.logo
		? `<img src="${esc(look.logo)}" alt="${esc(look.brandName)}" height="40" style="display:block;height:40px;width:auto;border:0">`
		: `<div style="font:800 20px Helvetica,Arial,sans-serif;color:${colour}">${esc(look.brandName)}</div>`;
	const foot = [
		look.footer ? esc(look.footer) : "",
		`You're getting this because you signed up to ${esc(look.brandName)}.`,
		`<a href="${esc(look.unsubscribeUrl)}" style="color:#6b5a73">Unsubscribe</a>${look.webUrl ? ` · <a href="${esc(look.webUrl)}" style="color:#6b5a73">View in your browser</a>` : ""}`,
	].filter(Boolean).join("<br>");
	const pixel = look.track ? `<img src="${esc(look.track.pixel)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : "";
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m(subject))}</title></head><body style="margin:0;padding:0;background:#f7f2f5">${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2f5"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px"><tr><td style="padding:28px 28px 8px">${head}</td></tr><tr><td style="padding:8px 28px 20px">${parts.join("")}</td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr><td style="padding:20px 28px;font:13px/1.6 Helvetica,Arial,sans-serif;color:#6b5a73;text-align:center">${foot}</td></tr></table>${pixel}</td></tr></table></body></html>`;
	const plain = [...text, "--", look.footer ?? "", `Unsubscribe: ${look.unsubscribeUrl}`, look.webUrl ? `View in your browser: ${look.webUrl}` : ""].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim() + "\n";
	return { html, text: plain, links };
}

/** The headers every newsletter carries: one click unsubscribe (RFC 8058), which Gmail and Yahoo ask bulk senders for. */
export function listHeaders(unsubscribeUrl: string, listId: string): Record<string, string> {
	return { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "List-Id": `<${listId}>` };
}

/** A web address part from a subject: "Spring news!" becomes "spring-news". */
export function slugify(s: string): string {
	return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "issue";
}
