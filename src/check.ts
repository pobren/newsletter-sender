// Check before you send: the things that most often go wrong with a newsletter, found before it goes out.
// Links and pictures are fetched to see they work (at most MAX_FETCHES, so a big email stays within a Worker's limits).

import { renderEmail, type Content } from "./render.ts";

export interface CheckItem {
	/** ok: all good. warn: worth a look. bad: almost certainly a mistake. */
	level: "ok" | "warn" | "bad";
	title: string;
	detail?: string;
	/** The links, pictures or words concerned. */
	list?: string[];
}

export const MAX_FETCHES = 40;
const TIMEOUT = 6000;

/** Words and phrases spam filters (and readers) are wary of. Kept short: only the ones that really count against you. */
const SPAMMY = ["100% free", "act now", "apply now", "buy now", "cash bonus", "click here", "congratulations", "double your", "earn money", "eliminate debt", "extra cash", "free gift", "free money", "guaranteed", "increase sales", "limited time", "lowest price", "make money", "no catch", "no cost", "once in a lifetime", "risk free", "risk-free", "special promotion", "urgent", "winner", "you have been selected", "while supplies last", "this isn't spam", "not spam"];

const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** Is this address worth fetching? Only public web addresses. */
const fetchable = (u: string) => /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(u) && !/^https?:\/\/(localhost|127\.|10\.|192\.168\.|\[)/i.test(u);

async function works(url: string, fetcher: typeof fetch): Promise<{ ok: boolean; status: number }> {
	const go = async (method: string) => {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), TIMEOUT);
		try {
			const res = await fetcher(url, { method, redirect: "follow", signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; NewsletterSender link check)" } });
			await res.body?.cancel().catch(() => {});
			return res.status;
		} catch {
			return 0;
		} finally {
			clearTimeout(t);
		}
	};
	let status = await go("HEAD");
	// Plenty of sites turn HEAD away, or block anything that isn't a browser: try a GET before calling it broken.
	if (status === 0 || status === 405 || status === 403 || status === 404 || status >= 500) status = await go("GET");
	// 401, 403 and 429 mean "not for robots" far more often than "broken".
	return { ok: status > 0 && (status < 400 || status === 401 || status === 403 || status === 429), status };
}

/** Runs `fn` over `items`, six at a time. */
async function pool<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	}));
	return out;
}

export async function checkEmail(e: { subject: string; preheader: string | null; content: Content; colour: string; brandName: string }, fetcher: typeof fetch = fetch): Promise<CheckItem[]> {
	const items: CheckItem[] = [];
	const out = renderEmail(e.subject, e.content, { brandName: e.brandName, colour: e.colour, unsubscribeUrl: "https://example.com/u", preheader: e.preheader, track: null }, { email: "reader@example.com", name: "Reader" });
	const body = typeof e.content === "string" ? e.content : out.html;
	const subject = e.subject.trim();

	// -- The subject line and preview text -------------------------------------------------------
	if (!subject || subject === "Untitled email") items.push({ level: "bad", title: "There's no subject line", detail: "Add one at the top, under About this campaign." });
	else {
		const problems: string[] = [];
		if (subject.length > 70) problems.push(`It's ${subject.length} characters long, so phones will cut it off. Around 50 or fewer shows in full.`);
		if ((subject.match(/!/g) ?? []).length >= 3 || /[!?]{2,}/.test(subject)) problems.push("Lots of ! or ? marks look like spam to filters.");
		const words = subject.replace(/\{\{[^}]*\}\}/g, "").match(/[A-Za-z]{3,}/g) ?? [];
		if (words.length >= 2 && words.filter((w) => w === w.toUpperCase()).length / words.length > 0.5) problems.push("Mostly capital letters reads as shouting, and spam filters notice.");
		const bare = [...subject.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]);
		if (bare.length) problems.push(`{{${bare[0]}}} has no fallback, so anyone without one sees a gap. Use {{${bare[0]}|there}} instead.`);
		items.push(problems.length ? { level: "warn", title: "The subject line could be better", list: problems } : { level: "ok", title: "Subject line looks good" });
	}
	if (!e.preheader?.trim()) items.push({ level: "warn", title: "There's no preview text", detail: "Inboxes show the first words of the email instead. A line of your own gets more people to open it." });
	else items.push({ level: "ok", title: "Preview text is set" });

	// -- Merge tags without a fallback in the body ----------------------------------------------
	const bareBody = [...new Set([...body.matchAll(/\{\{\s*(first_name|name)\s*\}\}/gi)].map((m) => m[0]))];
	if (bareBody.length) items.push({ level: "warn", title: "A name tag has no fallback", detail: "People we don't have a name for would see a gap. Add a fallback, such as {{first_name|there}}.", list: bareBody });

	// -- Pictures ------------------------------------------------------------------------------
	const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
	const src = (tag: string) => /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.replace(/&amp;/g, "&") ?? "";
	const noAlt = imgs.filter((t) => !/\balt\s*=\s*["'][^"']*\S[^"']*["']/i.test(t) && !/\bwidth\s*=\s*["']?1["'\s>]/i.test(t)).map(src).filter(Boolean);
	if (noAlt.length) items.push({ level: "warn", title: `${noAlt.length === 1 ? "A picture has" : `${noAlt.length} pictures have`} no description`, detail: "People using screen readers, and anyone whose email app hides pictures, see nothing. Click the picture in the editor to describe it, or set alt in the HTML.", list: noAlt.slice(0, 10) });
	const plain = [...new Set(imgs.map(src).filter((u) => /^http:\/\//i.test(u)))];
	if (plain.length) items.push({ level: "warn", title: "Some pictures use http, not https", detail: "Some email apps won't show them.", list: plain.slice(0, 10) });

	// -- Links and pictures that don't work ------------------------------------------------------
	const links = [...new Set(out.links)];
	const empty = [...body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']\s*(#?)\s*["']/gi)].length;
	if (empty) items.push({ level: "warn", title: `${empty === 1 ? "A link goes" : `${empty} links go`} nowhere`, detail: "Its address is empty or just #." });
	const pics = [...new Set(imgs.map(src).filter(fetchable))];
	const toFetch = [...links.filter(fetchable).map((u) => ({ u, pic: false })), ...pics.map((u) => ({ u, pic: true }))].slice(0, MAX_FETCHES);
	const results = await pool(toFetch, async (x) => ({ ...x, ...(await works(x.u, fetcher)) }));
	const brokenLinks = results.filter((r) => !r.ok && !r.pic), brokenPics = results.filter((r) => !r.ok && r.pic);
	if (brokenLinks.length) items.push({ level: "bad", title: `${brokenLinks.length === 1 ? "A link doesn't" : `${brokenLinks.length} links don't`} work`, detail: "These didn't open when we tried them just now.", list: brokenLinks.map((r) => `${r.u}${r.status ? ` (${r.status})` : " (no answer)"}`) });
	else if (links.length) items.push({ level: "ok", title: `${links.length === 1 ? "The link works" : `All ${links.length > MAX_FETCHES ? `${MAX_FETCHES} links we checked` : `${links.length} links`} work`}` });
	if (brokenPics.length) items.push({ level: "bad", title: `${brokenPics.length === 1 ? "A picture doesn't" : `${brokenPics.length} pictures don't`} load`, list: brokenPics.map((r) => `${r.u}${r.status ? ` (${r.status})` : " (no answer)"}`) });

	// -- Words, size and the unsubscribe link -------------------------------------------------------
	const all = `${subject} ${text(body)}`.toLowerCase();
	const spammy = SPAMMY.filter((w) => all.includes(w));
	if (spammy.length) items.push({ level: "warn", title: "Some words can trip spam filters", detail: "Fine now and then, but better rewritten where you can.", list: spammy });
	const kb = Math.round(new TextEncoder().encode(out.html).length / 1024);
	if (kb > 100) items.push({ level: "warn", title: `The email is ${kb} KB`, detail: "Gmail cuts off emails over about 100 KB behind a View entire message link, which also hides the unsubscribe link and the open count. Trim the HTML or split it up." });
	items.push({ level: "ok", title: /\{\{\s*unsubscribe_url\s*\}\}/i.test(body) ? "Your own unsubscribe link is in" : "An unsubscribe link is added at the bottom" });

	const order = { bad: 0, warn: 1, ok: 2 };
	return items.sort((a, b) => order[a.level] - order[b.level]);
}
