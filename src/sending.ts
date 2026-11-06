// Sending a campaign as fast as the sending service allows, and never faster.
//
// 1. start(): one row per reader goes into `sends` in a single statement (the audience, minus anyone who bounced,
//    complained or left), then the rows are cut into batches of BATCH and put on the queue.
// 2. The queue hands batches to up to CONCURRENCY workers at once (wrangler.jsonc). Each one sends its batch at its
//    share of the brand's rate: for Amazon SES that's the account's own maximum send rate, read when the send starts.
//    If the service says slow down, the batch goes back on the queue for a moment and carries on where it stopped.
// 3. When no row is left queued, the campaign is marked sent.
//
// A send row is only ever sent once: it's marked the moment the service accepts it, so a retried batch skips it.

import { sesAccount } from "./aws.ts";
import { BLOCKED_SQL, iso, linkBase, logEvent, newId, origin, type BrandRow, type CampaignRow, type Env, type SendBatch } from "./db.ts";
import { sendOne, sesKeys, type OutEmail, type ProviderConfig, type Sent } from "./providers.ts";
import { cleanBlocks, foreignTags, hasContent, listHeaders, renderEmail, type Content, type Look, type Reader } from "./render.ts";
import { canSendFrom, loadProvider, sealSecret } from "./settings.ts";
import { checkCampaign } from "./health.ts";
import { loadTestFor, pretendReplies, pretendSend } from "./loadtest.ts";
import { abSplit, parseAb, pickWinners, sendableTo, subjectFor } from "./abtest.ts";

/** Send rows in one queue message. Bigger batches spend less of each second waiting on the queue between
 * messages: the 100k load test on Cloudflare reached about 65 a second (of 100) with 10 workers, as each message
 * costs a second or two on top of its sending time. */
export const BATCH = 200;
/** Queue workers at once: keep the same as max_concurrency in wrangler.jsonc. */
export const CONCURRENCY = 20;
/** Requests one worker may have open at once (Cloudflare allows six). */
const OPEN = 6;
/** Tries before a batch's unsent rows are marked failed. */
export const MAX_TRIES = 10;

/** Default emails a second for services that don't tell us their limit. The owner can change it. */
export const DEFAULT_RATE: Record<string, number> = { ses: 1, postmark: 20, mailgun: 20, brevo: 10, resend: 2 };

/** One worker's share of the brand's rate, in emails a second. */
export const shareOfRate = (rate: number, workers = CONCURRENCY) => Math.max(0.2, rate / workers);

/** The queue batches for send rows from `min` to `max`: [from, to] pairs of BATCH rows each. */
export function batches(min: number, max: number, size = BATCH): [number, number][] {
	const out: [number, number][] = [];
	for (let a = min; a <= max; a += size) out.push([a, Math.min(max, a + size - 1)]);
	return out;
}

/** How long a list takes at a rate: "about 8 minutes". */
export function sendTime(count: number, rate: number): string {
	const s = Math.ceil(count / Math.max(rate, 0.1));
	if (s < 2) return "about a second";
	if (s < 90) return `about ${s} seconds`;
	if (s < 5400) return `about ${Math.round(s / 60)} minutes`;
	return `about ${Math.round(s / 360) / 10} hours`;
}

export interface Audience {
	lists: string[];
	tags: string[];
	/** Only people who did (or didn't do) something lately, such as opened an email in the last 90 days. */
	activity?: Activity | null;
	/** Sending again: only people who got this campaign and didn't open it. */
	resend?: { campaign: string } | null;
}

export const ACTIVITY_KINDS = ["opened", "not_opened", "clicked", "not_clicked", "joined"] as const;
export interface Activity {
	kind: (typeof ACTIVITY_KINDS)[number];
	days: number;
}

export function parseAudience(x: unknown): Audience {
	const a = (typeof x === "string" ? safeJson(x) : x) as any;
	const ids = (v: unknown) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && /^[0-9a-f]{8,40}$/.test(s)).slice(0, 50) : []);
	const tags = Array.isArray(a?.tags) ? a.tags.filter((t: unknown) => typeof t === "string" && /^[a-z0-9_-]{1,40}$/.test(t)).slice(0, 20) : [];
	const act = a?.activity;
	const activity = act && (ACTIVITY_KINDS as readonly string[]).includes(act.kind) && [7, 14, 30, 60, 90, 180, 365].includes(Number(act.days)) ? { kind: act.kind, days: Number(act.days) } : null;
	const resend = typeof a?.resend?.campaign === "string" && /^[0-9a-f]{8,40}$/.test(a.resend.campaign) ? { campaign: a.resend.campaign } : null;
	return { lists: ids(a?.lists), tags, ...(activity ? { activity } : {}), ...(resend ? { resend } : {}) };
}

export function safeJson(s: string | null | undefined): any {
	try {
		return s ? JSON.parse(s) : null;
	} catch {
		return null;
	}
}

/** The WHERE part (and its values) that picks a campaign's readers: in any chosen list, with any chosen tag. */
function audienceSql(brandId: string, a: Audience): { sql: string; binds: unknown[] } {
	const lists = a.lists.map(() => "?").join(", ");
	let sql = `s.brand_id = ? AND s.suppressed IS NULL AND NOT ${BLOCKED_SQL} AND EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.status = 'active' AND m.list_id IN (${lists}))`;
	const binds: unknown[] = [brandId, brandId, brandId, ...a.lists];
	if (a.tags.length) {
		sql += ` AND EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE t.value IN (${a.tags.map(() => "?").join(", ")}))`;
		binds.push(...a.tags);
	}
	if (a.activity) {
		const since = new Date(Date.now() - a.activity.days * 86_400_000).toISOString();
		const did = (col: string) => `EXISTS (SELECT 1 FROM sends x WHERE x.subscriber_id = s.id AND x.sent_at >= ? AND x.${col} IS NOT NULL)`;
		const got = "EXISTS (SELECT 1 FROM sends x WHERE x.subscriber_id = s.id AND x.status = 'sent' AND x.sent_at >= ?)";
		const k = a.activity.kind;
		if (k === "joined") (sql += " AND s.created_at >= ?"), binds.push(since);
		else if (k === "opened" || k === "clicked") (sql += ` AND ${did(k === "opened" ? "opened_at" : "clicked_at")}`), binds.push(since);
		// "Didn't open" only counts people we actually emailed in that time, not people who just joined.
		else (sql += ` AND ${got} AND NOT ${did(k === "not_opened" ? "opened_at" : "clicked_at")}`), binds.push(since, since);
	}
	if (a.resend) {
		// Still on the lists and still fine to email (above), got the first one, and never opened it.
		sql += " AND EXISTS (SELECT 1 FROM sends x WHERE x.campaign_id = ? AND x.subscriber_id = s.id AND x.status = 'sent' AND x.opened_at IS NULL)";
		binds.push(a.resend.campaign);
	}
	return { sql, binds };
}

/** How many people a campaign would go to right now. */
export async function audienceCount(db: D1Database, brandId: string, a: Audience): Promise<number> {
	if (!a.lists.length) return 0;
	const { sql, binds } = audienceSql(brandId, a);
	return (await db.prepare(`SELECT COUNT(*) AS n FROM subscribers s WHERE ${sql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
}

/** Signs a send row id, so open and click addresses can't be guessed. */
/** The signature on a campaign's share page link, so people can't guess other campaigns. */
export async function shareSig(secret: string, id: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ns-share:${secret}:${id}`));
	return [...new Uint8Array(d).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sendSig(secret: string, id: number): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ns-send:${secret}:${id}`));
	return [...new Uint8Array(d).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a campaign's email is made of: its HTML, or blocks for emails written before the visual editor. */
export function campaignContent(c: Pick<CampaignRow, "html" | "blocks">): Content {
	return c.html ?? cleanBlocks(safeJson(c.blocks));
}

/** Where every link in an email points: the brand's own domain for links when it has one, otherwise this app's address. */
export const trackBase = linkBase;

/** Starts sending a campaign now. Returns what's wrong instead, when it can't. */
export async function start(env: Env, c: CampaignRow, request?: Request): Promise<{ ok: true; total: number } | { error: string }> {
	const db = env.DB;
	const brand = await db.prepare("SELECT * FROM brands WHERE id = ?").bind(c.brand_id).first<BrandRow>();
	if (!brand) return { error: "This campaign's brand has gone." };
	const provider = await loadProvider(db, brand);
	if (!provider) return { error: "Please choose how to send first, under Settings, Sending." };
	const audience = parseAudience(c.audience);
	if (!audience.lists.length) return { error: "Please choose at least one list to send to." };
	if (!hasContent(campaignContent(c))) return { error: "This email is empty. Please write something first." };
	const from = senderOf(brand, c);
	const allowed = await canSendFrom(provider, from.email);
	if (allowed.ok === false) return { error: allowed.message };

	// Amazon SES: send at the account's current rate, and don't start what the day's allowance can't finish.
	if (provider.provider === "ses") {
		const acct = await sesAccount(sesKeys(provider));
		if ("error" in acct) return { error: acct.error };
		await db.prepare("UPDATE brands SET rate = ? WHERE id = ?").bind(acct.rate, brand.id).run();
		const count = await audienceCount(db, brand.id, audience);
		if (!acct.production) return { error: "Your Amazon SES account is still in the sandbox, so it can only send to addresses you've verified. Ask Amazon for production access first (SES, Account dashboard, Request production access)." };
		if (count > acct.max24 - acct.sent24) return { error: `This goes to ${count.toLocaleString("en-GB")} people, but Amazon SES lets you send ${Math.max(0, acct.max24 - acct.sent24).toLocaleString("en-GB")} more in the next 24 hours. Ask Amazon to raise your daily limit, or send to fewer people.` };
	}

	const claim = await db.prepare("UPDATE campaigns SET status = 'sending', started_at = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'scheduled') RETURNING id").bind(iso(), iso(), c.id).first();
	if (!claim) return { error: "This campaign has already been sent or is sending." };

	const { sql, binds } = audienceSql(brand.id, audience);
	// Testing two subject lines: random order, so the test groups are a fair sample.
	let ab = parseAb(c.ab);
	await db.prepare(`INSERT OR IGNORE INTO sends (campaign_id, subscriber_id) SELECT ?, s.id FROM subscribers s WHERE ${sql} ORDER BY ${ab ? "RANDOM()" : "s.created_at"}`).bind(c.id, ...binds).run();
	const range = await db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS n FROM sends WHERE campaign_id = ?").bind(c.id).first<{ lo: number | null; hi: number | null; n: number }>();
	const total = range?.n ?? 0;
	const slug = c.slug ?? `${c.id.slice(0, 6)}`;
	const split = ab && range?.lo != null ? abSplit(range.lo, total, ab.pct) : null;
	ab = ab && split ? { ...ab, ...split, at: iso(new Date(Date.now() + ab.hours * 3600_000)) } : null;
	await db.prepare("UPDATE campaigns SET total = ?, slug = ?, ab = ? WHERE id = ?").bind(total, slug, ab ? JSON.stringify(ab) : null, c.id).run();

	// Keep every link so clicks can be counted against it (only used when opens and clicks are on).
	if (brand.track_clicks) {
		const look = await lookFor(env, brand, c, "", null);
		const { links } = renderEmail(c.subject, campaignContent(c), { ...look, track: null }, { email: "" });
		if (links.length) await db.batch(links.slice(0, 200).map((url, i) => db.prepare("INSERT OR REPLACE INTO links (campaign_id, n, url) VALUES (?, ?, ?)").bind(c.id, i + 1, url)));
	}

	if (!total || range?.lo == null || range.hi == null) {
		await db.prepare("UPDATE campaigns SET status = 'sent', finished_at = ? WHERE id = ?").bind(iso(), c.id).run();
		return { ok: true, total: 0 };
	}
	await enqueue(env, c.id, range.lo, sendableTo(ab, range.hi));
	await logEvent(db, brand.id, "campaign.started", null, c.id, `${total} people`).run();
	if (request) await origin(db, request);
	return { ok: true, total };
}

/** Puts batches for send rows lo..hi on the queue, 100 messages a call. */
export async function enqueue(env: Env, campaign: string, lo: number, hi: number, run = 0): Promise<void> {
	const all = batches(lo, hi).map(([from, to]) => ({ body: { campaign, from, to, run } satisfies SendBatch }));
	for (let i = 0; i < all.length; i += 100) await env.SENDS.sendBatch(all.slice(i, i + 100));
}

/** Carries on a paused campaign: the rows still queued go back on the queue. */
export async function resume(env: Env, c: CampaignRow): Promise<{ ok: true } | { error: string }> {
	const claim = await env.DB.prepare("UPDATE campaigns SET status = 'sending', run = run + 1, health = CASE WHEN health = 1 THEN 2 ELSE health END, updated_at = ? WHERE id = ? AND status = 'paused' RETURNING run").bind(iso(), c.id).first<{ run: number }>();
	if (!claim) return { error: "Only a paused campaign can carry on." };
	const r = await env.DB.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM sends WHERE campaign_id = ? AND status = 'queued'").bind(c.id).first<{ lo: number | null; hi: number | null }>();
	const to = r?.hi != null ? sendableTo(parseAb(c.ab), r.hi) : null;
	if (r?.lo != null && to != null) {
		if (r.lo <= to) await enqueue(env, c.id, r.lo, to, claim.run);
	} else await finishIfDone(env.DB, c.id);
	return { ok: true };
}

/** What each email for a campaign looks like, apart from the reader. */
async function lookFor(env: Env, brand: BrandRow, c: CampaignRow, unsubscribeUrl: string, track: Look["track"]): Promise<Look> {
	const base = linkBase(brand, await origin(env.DB));
	return {
		brandName: brand.name,
		colour: brand.colour,
		logo: brand.logo,
		footer: brand.footer,
		preheader: c.preheader,
		unsubscribeUrl,
		webUrl: brand.archive && c.public && c.slug ? `${base}/archive/${c.slug}` : null,
		track,
	};
}

interface Row {
	id: number;
	sub: string;
	email: string;
	name: string | null;
	fields: string;
	token: string;
}

/** The queue: sends each batch at this worker's share of the brand's rate. */
export async function consume(batch: MessageBatch<SendBatch>, env: Env): Promise<void> {
	for (const msg of batch.messages) {
		try {
			const again = await sendBatch(env, msg.body, msg.attempts);
			if (again) msg.retry({ delaySeconds: again });
			else msg.ack();
		} catch (e) {
			console.error("send batch failed", e);
			msg.retry({ delaySeconds: 30 });
		}
	}
}

/** Sends one batch. Returns seconds to wait before trying the rest again, or 0 when it's done. */
export async function sendBatch(env: Env, b: SendBatch, attempts: number, fetcher: typeof fetch = fetch): Promise<number> {
	const db = env.DB;
	const c = await db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(b.campaign).first<CampaignRow>();
	if (!c || c.status !== "sending") return 0; // cancelled or paused: leave the rows as they are
	if ((b.run ?? 0) !== (c.run ?? 0)) return 0; // from before a pause: the carry on queued these rows again
	const brand = await db.prepare("SELECT * FROM brands WHERE id = ?").bind(c.brand_id).first<BrandRow>();
	const test = await loadTestFor(db, c.id);
	const provider = brand ? (test ? ({ provider: "ses", key: "" } as ProviderConfig) : await loadProvider(db, brand)) : null;
	if (!brand || !provider) {
		await pause(db, c, "The sending service was removed, so sending stopped. Add it again under Settings, Sending, then carry on.");
		return 0;
	}
	// Anyone who bounced, complained or left this email's lists since the send started is skipped.
	await db.prepare(`UPDATE sends SET status = 'skipped' WHERE campaign_id = ? AND id BETWEEN ? AND ? AND status = 'queued' AND (subscriber_id IN (SELECT id FROM subscribers WHERE suppressed IS NOT NULL)
		OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = sends.subscriber_id AND m.status = 'active' AND m.list_id IN (SELECT value FROM json_each(?)))
		OR EXISTS (SELECT 1 FROM subscribers s WHERE s.id = sends.subscriber_id AND ${BLOCKED_SQL}))`)
		.bind(c.id, b.from, b.to, JSON.stringify(parseAudience(c.audience).lists), c.brand_id, c.brand_id).run();
	const { results: rows } = await db
		.prepare(`SELECT x.id, s.id AS sub, s.email, s.name, s.fields, s.token FROM sends x JOIN subscribers s ON s.id = x.subscriber_id
			WHERE x.campaign_id = ? AND x.id BETWEEN ? AND ? AND x.status = 'queued' AND s.suppressed IS NULL ORDER BY x.id`)
		.bind(c.id, b.from, b.to)
		.all<Row>();
	if (!rows.length) return (await finishIfDone(db, c.id), 0);

	const base = linkBase(brand, await origin(db));
	const secret = await sealSecret(db);
	const content = campaignContent(c);
	const ab = parseAb(c.ab);
	const tb = trackBase(brand, base);
	const share = `${base}/f/${c.id}.${await shareSig(secret, c.id)}`;
	const from = senderOf(brand, c);
	// What happened is saved every ten emails, so if a worker is stopped part way, only those last few could go twice.
	const pending: D1PreparedStatement[] = [];
	// Every 50 emails we look again, so pressing Pause (or Stop) takes effect within seconds, not at the end of the batch.
	let stopped = false, flushes = 0;
	const flush = async () => {
		if (pending.length) await db.batch(pending.splice(0));
		if (++flushes % 5 === 0) {
			const now = await db.prepare("SELECT status, run FROM campaigns WHERE id = ?").bind(c.id).first<{ status: string; run: number }>();
			if (!now || now.status !== "sending" || (now.run ?? 0) !== (c.run ?? 0)) stopped = true;
		}
	};
	const record = (id: number, s: Sent) => {
		if (s.ok) pending.push(db.prepare("UPDATE sends SET status = 'sent', sent_at = ? WHERE id = ?").bind(iso(), id));
		else if (!s.throttled) pending.push(db.prepare("UPDATE sends SET status = 'failed', error = ? WHERE id = ?").bind((s.error ?? "Failed").slice(0, 240), id));
	};
	const outcome = await paced(rows, shareOfRate(test?.rate ?? brand.rate), async (r) => {
		const sig = brand.track_opens || brand.track_clicks ? await sendSig(secret, r.id) : "";
		const unsub = `${base}/u/${r.token}?c=${c.id}`;
		const track: Look["track"] = { link: brand.track_clicks ? (_url, n) => `${tb}/l/${r.id}.${sig}/${n}` : null, pixel: brand.track_opens ? `${tb}/o/${r.id}.${sig}` : null };
		const look = { ...(await lookFor(env, brand, c, unsub, track)), manageUrl: `${base}/p/${r.token}`, forwardUrl: share, footerLinks: brand.footer_links };
		const reader: Reader = { email: r.email, name: r.name, fields: safeJson(r.fields) ?? {} };
		const subject = subjectFor(c, ab, r.id);
		const out = renderEmail(subject, content, look, reader);
		const email: OutEmail = {
			to: r.email,
			subject: mergeSubject(subject, reader),
			text: out.text,
			html: out.html,
			headers: listHeaders(unsub, `${brand.id}.${new URL(base || "https://example.com").hostname}`),
			replyTo: from.replyTo,
			tags: { ns_campaign: c.id, ns_sub: r.sub },
		};
		const sent = test ? await pretendSend(test, r.email) : await sendOne(provider, from.name, from.email, email, fetcher);
		record(r.id, sent);
		if (pending.length >= 10) await flush();
		return sent;
	}, realClock, () => stopped);
	await flush();
	if (stopped) return 0; // paused or stopped part way: what's left stays queued for Carry on sending
	if (test) {
		const replies = pretendReplies(db, brand.id, c.id, test, outcome.done.filter(([, s]) => s.ok).map(([r]) => r));
		if (replies.length) {
			await db.batch(replies);
			await checkCampaign(db, c.id, true);
		}
	}

	if (outcome.done.some(([, s]) => s.quota)) {
		await pause(db, c, "Paused: you've used up today's sending limit with your sending service. The rest are still waiting. Press Carry on sending once the limit frees up (Amazon SES counts the last 24 hours), or ask for a higher limit.");
		return 0;
	}
	// Every email failing the same way (an unverified domain, a revoked key) means stop and tell the owner.
	const failed = outcome.done.filter(([, s]) => !s.ok && !s.throttled && !s.permanent);
	if (failed.length >= 5 && failed.length === outcome.done.length) {
		await pause(db, c, `Sending stopped because the sending service turned every email down: ${failed[0][1].error}`);
		return 0;
	}
	if (outcome.throttled || outcome.done.length < rows.length) {
		if (attempts >= MAX_TRIES) {
			await db.prepare("UPDATE sends SET status = 'failed', error = 'The sending service kept asking us to slow down, so we gave up on this one.' WHERE campaign_id = ? AND id BETWEEN ? AND ? AND status = 'queued'").bind(c.id, b.from, b.to).run();
			await finishIfDone(db, c.id);
			return 0;
		}
		return Math.min(60, 5 * attempts);
	}
	await finishIfDone(db, c.id);
	return 0;
}

const mergeSubject = (subject: string, r: Reader) => foreignTags(subject).replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|([^}]*))?\}\}/gi, (_a, k: string, fb = "") => {
	const name = (r.name ?? "").trim();
	const v = k.toLowerCase() === "first_name" ? name.split(/\s+/)[0] ?? "" : k.toLowerCase() === "name" ? name : k.toLowerCase() === "email" ? r.email : r.fields?.[k.toLowerCase()] ?? "";
	return v.trim() || fb.trim();
});
export { mergeSubject };

/**
 * Runs `send` for each row, starting the nth no sooner than n / rate seconds in, with up to OPEN at once. Stops
 * starting new ones as soon as the service says slow down.
 */
export async function paced<R, T extends Sent>(rows: R[], rate: number, send: (r: R) => Promise<T>, clock: { now(): number; sleep(ms: number): Promise<void> } = realClock, halt: () => boolean = () => false): Promise<{ done: [R, T][]; throttled: boolean }> {
	const t0 = clock.now();
	const gap = 1000 / rate;
	const done: [R, T][] = [];
	let next = 0;
	let throttled = false;
	const worker = async () => {
		while (!throttled && !halt() && next < rows.length) {
			const i = next++;
			const wait = t0 + i * gap - clock.now();
			if (wait > 0) await clock.sleep(wait);
			if (throttled || halt()) {
				next = Math.min(next, i);
				return;
			}
			const s = await send(rows[i]);
			if (s.throttled) throttled = true;
			done.push([rows[i], s]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(OPEN, rows.length) }, worker));
	return { done, throttled };
}

const realClock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

export async function pause(db: D1Database, c: CampaignRow, why: string): Promise<void> {
	await db.prepare("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'sending'").bind(iso(), c.id).run();
	await logEvent(db, c.brand_id, "campaign.paused", null, c.id, why).run();
}

/** Marks a campaign sent once nothing of it is left queued. */
export async function finishIfDone(db: D1Database, id: string): Promise<void> {
	const done = await db
		.prepare("UPDATE campaigns SET status = 'sent', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND NOT EXISTS (SELECT 1 FROM sends WHERE campaign_id = ? AND status = 'queued') RETURNING brand_id")
		.bind(iso(), iso(), id, id)
		.first<{ brand_id: string }>();
	if (done) {
		await logEvent(db, done.brand_id, "campaign.sent", null, id).run();
		await doneEmail(db, id).catch((e) => console.error("finished email", e));
	}
}

/** Tells the owner a campaign has finished: how it went in a few lines, and a link to the full report. */
export async function doneEmail(db: D1Database, id: string, fetcher: typeof fetch = fetch): Promise<void> {
	const c = await db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
	const b = c && (await db.prepare("SELECT * FROM brands WHERE id = ?").bind(c.brand_id).first<BrandRow>());
	if (!c || !b || !(b.done_email ?? 1) || (await loadTestFor(db, id))) return;
	const owner = await db.prepare("SELECT email FROM accounts ORDER BY created_at LIMIT 1").first<{ email: string }>();
	const provider = await loadProvider(db, b);
	if (!owner || !provider) return;
	const [st, ev, en] = await db.batch([
		db.prepare("SELECT status, COUNT(*) AS n FROM sends WHERE campaign_id = ? GROUP BY status").bind(id),
		db.prepare("SELECT kind, COUNT(DISTINCT subscriber_id) AS n FROM events WHERE campaign_id = ? AND kind IN ('bounced', 'complained', 'unsubscribed') GROUP BY kind").bind(id),
		db.prepare("SELECT COUNT(opened_at) AS opens, COUNT(clicked_at) AS clicks FROM sends WHERE campaign_id = ?").bind(id),
	]);
	const s = Object.fromEntries((st.results as any[]).map((r) => [r.status, r.n]));
	const e = Object.fromEntries((ev.results as any[]).map((r) => [r.kind, r.n]));
	const g = (en.results[0] as any) ?? {};
	const sent = s.sent ?? 0;
	const pct = (n: number) => (sent ? `${((n / sent) * 100).toFixed(n && n / sent < 0.01 ? 2 : 1)}%` : "0%");
	const n = (v: number) => v.toLocaleString("en-GB");
	const mins = c.started_at && c.finished_at ? Math.max(1, Math.round((Date.parse(c.finished_at) - Date.parse(c.started_at)) / 60000)) : 0;
	const name = c.name || c.subject.replace(/\{\{[^}]*\}\}/g, "").trim();
	const lines: [string, string][] = [
		["Sent", `${n(sent)}${mins ? ` in ${mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${Math.floor(mins / 60)} hour${mins >= 120 ? "s" : ""} ${mins % 60} minutes`}` : ""}`],
		...(s.failed ? ([["Failed", n(s.failed)]] as [string, string][]) : []),
		["Bounced", `${n(e.bounced ?? 0)} (${pct(e.bounced ?? 0)})`],
		["Marked as spam", `${n(e.complained ?? 0)} (${pct(e.complained ?? 0)})`],
		["Unsubscribed so far", n(e.unsubscribed ?? 0)],
		...(b.track_opens ? ([["Opened so far", `${n(g.opens ?? 0)} (${pct(g.opens ?? 0)})`]] as [string, string][]) : []),
		...(b.track_clicks ? ([["Clicked so far", `${n(g.clicks ?? 0)} (${pct(g.clicks ?? 0)})`]] as [string, string][]) : []),
		...(parseAb(c.ab)?.winner ? ([["Winning subject line", parseAb(c.ab)!.winner === "b" ? parseAb(c.ab)!.b : c.subject]] as [string, string][]) : []),
	];
	const link = `${await origin(db)}/#email/${c.id}`;
	const x = (v: string) => v.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
	const body = `<p>Your campaign <b>${x(name)}</b> has finished sending.</p><table cellpadding="6" style="border-collapse:collapse;margin:12px 0">${lines.map(([k, v]) => `<tr><td style="color:#6b5a73">${k}</td><td><b>${x(v)}</b></td></tr>`).join("")}</table><p><a href="${x(link)}" style="display:inline-block;background:${x(b.colour)};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">See the full report</a></p>`;
	const text = `Your campaign "${name}" has finished sending.\n\n${lines.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nSee the full report: ${link}`;
	const out = renderEmail(`Finished sending: ${name}`, body, { brandName: b.name, colour: b.colour, logo: b.logo, unsubscribeUrl: `${await origin(db)}/#settings`, track: null }, { email: owner.email });
	await sendOne(provider, b.from_name, b.from_email, { to: owner.email, subject: `Finished sending: ${name}`, text, html: out.html.replace(/You're getting this because[^<]*<br>/, "").replace(/<a [^>]*>Unsubscribe<\/a>/, `<a href="${x(`${await origin(db)}/#settings`)}">Turn these emails off</a>`), headers: {} }, fetcher);
}

/** Every minute: starts campaigns whose time has come. */
export async function startDue(env: Env, now = new Date()): Promise<void> {
	await pickWinners(env, enqueue, now).catch((e) => console.error("subject line test", e));
	const { results } = await env.DB.prepare("SELECT * FROM campaigns WHERE status = 'scheduled' AND send_at <= ? LIMIT 5").bind(iso(now)).all<CampaignRow>();
	for (const c of results) {
		const r = await start(env, c);
		if ("error" in r) {
			await env.DB.prepare("UPDATE campaigns SET status = 'draft', updated_at = ? WHERE id = ?").bind(iso(), c.id).run();
			await logEvent(env.DB, c.brand_id, "campaign.not_sent", null, c.id, r.error).run();
		}
	}
	// A send that's made no progress for an hour (its queue message was lost) gets its remaining rows queued again.
	const hourAgo = iso(new Date(now.getTime() - 3600_000));
	const { results: stuck } = await env.DB.prepare(`SELECT c.id, c.run, c.ab FROM campaigns c WHERE c.status = 'sending' AND c.updated_at < ?1
		AND EXISTS (SELECT 1 FROM sends WHERE campaign_id = c.id AND status = 'queued')
		AND COALESCE((SELECT MAX(sent_at) FROM sends WHERE campaign_id = c.id), c.started_at) < ?1 LIMIT 5`).bind(hourAgo).all<{ id: string; run: number; ab: string | null }>();
	for (const c of stuck) {
		await env.DB.prepare("UPDATE campaigns SET updated_at = ? WHERE id = ?").bind(iso(now), c.id).run();
		const r = await env.DB.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM sends WHERE campaign_id = ? AND status = 'queued'").bind(c.id).first<{ lo: number | null; hi: number | null }>();
		// While a subject line test waits for its winner, only the test groups count as stuck.
		const to = r?.hi != null ? sendableTo(parseAb(c.ab), r.hi) : null;
		if (r?.lo != null && to != null && r.lo <= to) await enqueue(env, c.id, r.lo, to, c.run);
	}
}

/** A test of a campaign to a few addresses, straight away (not through the queue). */
/** Who a campaign comes from: its own From name, address and Reply to, or the brand's from Settings. */
export function senderOf(brand: BrandRow, c: Pick<CampaignRow, "from_name" | "from_email" | "reply_to">): { name: string; email: string; replyTo: string | null } {
	return { name: c.from_name || brand.from_name, email: c.from_email || brand.from_email, replyTo: c.reply_to || brand.reply_to || null };
}

export async function sendTest(env: Env, brand: BrandRow, provider: ProviderConfig, c: { subject: string; preheader: string | null; content: Content; from_name?: string | null; from_email?: string | null; reply_to?: string | null }, to: string[], sample: Reader): Promise<Sent[]> {
	const base = linkBase(brand, await origin(env.DB));
	const look: Look = { brandName: brand.name, colour: brand.colour, logo: brand.logo, footer: brand.footer, preheader: c.preheader, unsubscribeUrl: `${base}/u/test`, webUrl: null, track: null };
	const out = renderEmail(c.subject, c.content, look, sample);
	const subject = `[Test] ${mergeSubject(c.subject, sample)}`;
	const from = senderOf(brand, c);
	return Promise.all(to.map((addr) => sendOne(provider, from.name, from.email, { to: addr, subject, text: out.text, html: out.html, headers: listHeaders(`${base}/u/test`, `${brand.id}.test`), replyTo: from.replyTo }, fetch)));
}

export const newCampaignId = () => newId(8);
