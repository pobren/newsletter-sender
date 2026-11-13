// Blog posts to newsletter drafts (Settings, Blog posts): we read the brand's blog feed (RSS or Atom) once an hour, and
// each new post becomes a draft campaign: the title as the subject, the picture, a short summary and a Read the full
// post button, to the lists the owner chose. Nothing is ever sent by itself; the owner checks the draft and sends it.
//
// The first check only remembers the posts already there, so an old blog doesn't turn into dozens of drafts.

import { getMeta, iso, logEvent, newId, setMeta } from "./db.ts";
import { sanitise } from "./render.ts";
import { VERSION } from "./update.ts";

export interface BlogFeed {
	url: string;
	on: boolean;
	/** Lists new drafts go to. */
	lists: string[];
	/** Post ids already seen (newest first, up to SEEN). */
	seen: string[];
	checked_at: string | null;
	error: string | null;
	/** Drafts made so far. */
	made: number;
}

export interface Post {
	id: string;
	title: string;
	link: string;
	summary: string;
	image: string | null;
	date: string | null;
}

const SEEN = 100;
const EVERY_MS = 60 * 60_000;
const key = (brand: string) => `blogfeed:${brand}`;

export async function getFeed(db: D1Database, brand: string): Promise<BlogFeed | null> {
	try {
		const v = JSON.parse((await getMeta(db, key(brand))) ?? "null");
		return v && typeof v.url === "string" ? { on: Boolean(v.on), url: v.url, lists: Array.isArray(v.lists) ? v.lists : [], seen: Array.isArray(v.seen) ? v.seen : [], checked_at: v.checked_at ?? null, error: v.error ?? null, made: Number(v.made) || 0 } : null;
	} catch {
		return null;
	}
}
export const saveFeed = (db: D1Database, brand: string, f: BlogFeed | null) => setMeta(db, key(brand), f ? JSON.stringify(f) : null);

// -- Reading a feed ----------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", pound: "£", euro: "€" };
export function decode(s: string): string {
	return s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
			if (e[0] === "#") {
				const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
			}
			return ENTITIES[e.toLowerCase()] ?? m;
		});
}
/** Plain text from a bit of HTML. */
export const textOf = (html: string) => decode(decode(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/ ([.,;:!?])/g, "$1").trim();
const tagText = (xml: string, tag: string) => {
	const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
	return m ? m[1].trim() : "";
};
const attr = (tag: string, name: string) => decode(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(2).find((x) => x !== undefined) ?? "");
const https = (u: string, base: string) => {
	try {
		const x = new URL(decode(u).trim(), base);
		return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : "";
	} catch {
		return "";
	}
};

/** Up to 50 words. */
export function shorten(text: string, words = 50): string {
	const w = text.split(/\s+/).filter(Boolean);
	return w.length <= words ? w.join(" ") : `${w.slice(0, words).join(" ").replace(/[,;:.!?]+$/, "")}…`;
}

/** The posts in an RSS or Atom feed, newest first as the feed lists them. */
export function parseFeed(xml: string, base: string): Post[] {
	const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
	const items = [...xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]).slice(0, 50);
	return items.map((it) => {
		const title = textOf(tagText(it, "title")) || "New post";
		let link = "";
		if (atom) {
			const links = [...it.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
			const alt = links.find((l) => !/rel\s*=/.test(l) || /rel\s*=\s*["']alternate["']/i.test(l)) ?? links[0] ?? "";
			link = https(attr(alt, "href"), base);
		} else link = https(textOf(tagText(it, "link")), base) || https(textOf(tagText(it, "guid")), base);
		const id = textOf(tagText(it, atom ? "id" : "guid")) || link || title;
		const body = tagText(it, "content:encoded") || tagText(it, "content") || tagText(it, "description") || tagText(it, "summary");
		const summaryHtml = tagText(it, "description") || tagText(it, "summary") || body;
		const media = /<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi;
		let image: string | null = null;
		for (const m of it.matchAll(media)) {
			const u = attr(m[0], "url");
			const type = attr(m[0], "type") || attr(m[0], "medium");
			if (u && (!type || /image/i.test(type))) {
				image = https(u, base) || null;
				if (image) break;
			}
		}
		if (!image) {
			const img = /<img\b[^>]*>/i.exec(decode(body))?.[0];
			if (img) image = https(attr(img, "src"), base) || null;
		}
		return { id: id.slice(0, 300), title: title.slice(0, 200), link, summary: shorten(textOf(summaryHtml)), image, date: textOf(tagText(it, atom ? "updated" : "pubDate")) || null };
	});
}

/** Fetches and reads a feed. Never throws: says what went wrong instead. */
export async function readFeed(url: string, fetcher: typeof fetch = fetch): Promise<{ posts: Post[]; feedUrl: string } | { error: string }> {
	try {
		const res = await fetcher(url, { headers: { "user-agent": `NewsletterSender/${VERSION} (+https://newslettersender.com)`, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, redirect: "follow", signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return { error: `The blog answered ${res.status}.` };
		const xml = (await res.text()).slice(0, 3_000_000);
		if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) {
			// A blog's home page: look for the feed it links to.
			const alt = /<link\b[^>]*type\s*=\s*["']application\/(rss|atom)\+xml["'][^>]*>/i.exec(xml)?.[0];
			const href = alt ? https(attr(alt, "href"), res.url || url) : "";
			if (href && href !== url) return readFeed(href, fetcher);
			return { error: "That address isn't a blog feed. Try your blog's RSS or Atom feed, often ending /feed or /rss.xml." };
		}
		return { posts: parseFeed(xml, res.url || url), feedUrl: url };
	} catch (e) {
		return { error: `Couldn't reach the blog: ${(e as Error).message}` };
	}
}

// -- Making drafts -------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The draft's email: a hello, the title, the picture, the summary and a button to the post. */
export function draftHtml(p: Post, colour: string): string {
	const pic = p.image ? `<p><a href="${esc(p.link)}"><img src="${esc(p.image)}" alt="${esc(p.title)}" style="max-width:100%;height:auto;border-radius:8px"></a></p>\n` : "";
	return sanitise(`<p>Hello {{first_name|there}},</p>\n<p>We've just published a new post on the blog.</p>\n<h2>${esc(p.title)}</h2>\n${pic}${p.summary ? `<p>${esc(p.summary)}</p>\n` : ""}<p><a href="${esc(p.link)}" style="display:inline-block;background:${esc(colour)};color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Read the full post</a></p>`);
}

/** Makes a draft campaign for one post. */
export async function makeDraft(db: D1Database, brand: { id: string; colour: string }, f: BlogFeed, p: Post): Promise<string> {
	const id = newId(8);
	await db.prepare("INSERT INTO campaigns (id, brand_id, name, subject, preheader, blocks, html, audience, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)")
		.bind(id, brand.id, `Blog: ${p.title}`.slice(0, 120), p.title.slice(0, 200), shorten(p.summary, 18).slice(0, 150) || null, draftHtml(p, brand.colour), JSON.stringify({ lists: f.lists, tags: [] }), iso(), iso()).run();
	await logEvent(db, brand.id, "blog.draft", null, id, p.title.slice(0, 200)).run();
	return id;
}

/** Checks one brand's feed now. The first check only remembers the posts already there. */
export async function checkFeed(db: D1Database, brand: { id: string; colour: string }, fetcher: typeof fetch = fetch): Promise<{ made: string[]; error: string | null }> {
	const f = await getFeed(db, brand.id);
	if (!f?.on) return { made: [], error: null };
	const r = await readFeed(f.url, fetcher);
	if ("error" in r) {
		await saveFeed(db, brand.id, { ...f, checked_at: iso(), error: r.error });
		return { made: [], error: r.error };
	}
	const first = f.checked_at === null && f.seen.length === 0;
	const fresh = first ? [] : r.posts.filter((p) => p.link && !f.seen.includes(p.id)).slice(0, 5);
	const made: string[] = [];
	// Oldest first, so the drafts list reads in order.
	for (const p of fresh.reverse()) made.push(await makeDraft(db, brand, f, p));
	const seen = [...new Set([...r.posts.map((p) => p.id), ...f.seen])].slice(0, SEEN);
	await saveFeed(db, brand.id, { ...f, seen, checked_at: iso(), error: null, made: f.made + made.length });
	return { made, error: null };
}

/** Every minute (cron): checks each feed that's due, once an hour. */
export async function checkFeedsDue(db: D1Database, now = Date.now(), fetcher: typeof fetch = fetch): Promise<void> {
	const { results } = await db.prepare("SELECT m.key, b.colour FROM meta m JOIN brands b ON b.id = substr(m.key, 10) WHERE m.key LIKE 'blogfeed:%'").all<{ key: string; colour: string }>();
	for (const r of results) {
		const id = r.key.slice("blogfeed:".length);
		const f = await getFeed(db, id);
		if (!f?.on || (f.checked_at && now - Date.parse(f.checked_at) < EVERY_MS)) continue;
		await checkFeed(db, { id, colour: r.colour }, fetcher);
	}
}
