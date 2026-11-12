// Cold contact clean up (Settings, Lists): find people who haven't opened or clicked anything in a long while, tag
// them "cold" so you can send them a "still want these?" email, and (if you choose) take them off your lists a month
// later if they still haven't. Fewer emails to people who never read them helps the rest land in the inbox, and costs
// less to send.
//
// Only campaigns we could track count: one where nobody opened or clicked anything (because tracking was off then)
// says nothing about anyone, so switching tracking on doesn't suddenly make everyone look cold.

import { getMeta, iso, setMeta } from "./db.ts";

export const COLD_TAG = "cold";
export const WINDOWS = [90, 180, 365] as const;
/** How long someone stays tagged cold before the automatic clean up takes them off the lists. */
export const GRACE_DAYS = 30;

export interface ColdPolicy {
	/** Check every day and tag new cold contacts (and untag anyone who's read something since). */
	on: boolean;
	/** No opens or clicks in this many days... */
	days: (typeof WINDOWS)[number];
	/** ...from at least this many emails. */
	min: number;
	/** After GRACE_DAYS tagged cold and still nothing, take them off every list. */
	remove: boolean;
}

export const DEFAULT_POLICY: ColdPolicy = { on: false, days: 180, min: 5, remove: false };

const key = (brand: string) => `cold:${brand}`;
const runKey = (brand: string) => `coldrun:${brand}`;
const DAY = 86_400_000;

export async function getCold(db: D1Database, brand: string): Promise<ColdPolicy> {
	try {
		return cleanCold(JSON.parse((await getMeta(db, key(brand))) ?? "null") ?? DEFAULT_POLICY);
	} catch {
		return DEFAULT_POLICY;
	}
}

export function cleanCold(v: any): ColdPolicy {
	const days = (WINDOWS as readonly number[]).includes(Number(v?.days)) ? (Number(v.days) as ColdPolicy["days"]) : DEFAULT_POLICY.days;
	const min = Math.min(20, Math.max(1, Math.round(Number(v?.min)) || DEFAULT_POLICY.min));
	return { on: v?.on === true, days, min, remove: v?.on === true && v?.remove === true };
}
export const saveCold = (db: D1Database, brand: string, p: ColdPolicy) => setMeta(db, key(brand), JSON.stringify(p));

/** The brand's campaigns in the window that someone opened or clicked, so tracking was working for them. */
async function trackedCampaigns(db: D1Database, brand: string, since: string): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT c.id FROM campaigns c WHERE c.brand_id = ? AND c.started_at >= ? AND EXISTS (SELECT 1 FROM sends x WHERE x.campaign_id = c.id AND (x.opened_at IS NOT NULL OR x.clicked_at IS NOT NULL))")
		.bind(brand, since)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** WHERE (for subscribers s) that picks the cold: on a list, here before the window, got enough tracked emails in it, read none. */
async function coldWhere(db: D1Database, brand: string, p: Pick<ColdPolicy, "days" | "min">, now: number): Promise<{ sql: string; binds: unknown[]; campaigns: number }> {
	const since = iso(new Date(now - p.days * DAY));
	const ids = JSON.stringify(await trackedCampaigns(db, brand, since));
	const sql = `s.brand_id = ? AND s.suppressed IS NULL AND s.created_at < ?
		AND EXISTS (SELECT 1 FROM memberships m JOIN lists l ON l.id = m.list_id WHERE m.subscriber_id = s.id AND l.brand_id = ? AND m.status = 'active')
		AND (SELECT COUNT(*) FROM sends x WHERE x.subscriber_id = s.id AND x.status = 'sent' AND x.campaign_id IN (SELECT value FROM json_each(?))) >= ?
		AND NOT EXISTS (SELECT 1 FROM sends x WHERE x.subscriber_id = s.id AND x.sent_at >= ? AND (x.opened_at IS NOT NULL OR x.clicked_at IS NOT NULL))`;
	return { sql, binds: [brand, since, brand, ids, p.min, since], campaigns: JSON.parse(ids).length };
}

const hasTag = `EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE t.value = '${COLD_TAG}')`;

export interface ColdLook {
	/** People who are cold right now. */
	count: number;
	/** A few of their addresses, to see who we mean. */
	sample: string[];
	/** People tagged cold at the moment. */
	tagged: number;
	/** Tracked campaigns in the window: with none, nobody can be called cold. */
	campaigns: number;
}

export async function lookCold(db: D1Database, brand: string, p: Pick<ColdPolicy, "days" | "min">, now = Date.now()): Promise<ColdLook> {
	const w = await coldWhere(db, brand, p, now);
	const count = (await db.prepare(`SELECT COUNT(*) AS n FROM subscribers s WHERE ${w.sql}`).bind(...w.binds).first<{ n: number }>())?.n ?? 0;
	const sample = count ? (await db.prepare(`SELECT s.email FROM subscribers s WHERE ${w.sql} ORDER BY s.created_at LIMIT 5`).bind(...w.binds).all<{ email: string }>()).results.map((r) => r.email) : [];
	const tagged = (await db.prepare(`SELECT COUNT(*) AS n FROM subscribers s WHERE s.brand_id = ? AND ${hasTag}`).bind(brand).first<{ n: number }>())?.n ?? 0;
	return { count, sample, tagged, campaigns: w.campaigns };
}

/** Tag everyone cold who isn't already, and untag anyone tagged cold who has opened or clicked since. Returns how many of each. */
export async function tagCold(db: D1Database, brand: string, p: Pick<ColdPolicy, "days" | "min">, now = Date.now()): Promise<{ tagged: number; warmed: number }> {
	const w = await coldWhere(db, brand, p, now);
	const at = iso(new Date(now));
	const newly = `SELECT s.id FROM subscribers s WHERE ${w.sql} AND NOT ${hasTag}`;
	// Note when each was tagged (the automatic clean up waits a month from then), then tag them.
	const logged = await db.prepare(`INSERT INTO events (brand_id, at, kind, subscriber_id, campaign_id, detail) SELECT ?, ?, 'cold', id, NULL, ? FROM (${newly})`).bind(brand, at, `No opens or clicks in ${p.days} days, so tagged ${COLD_TAG}`, ...w.binds).run();
	await db.prepare(`UPDATE subscribers SET tags = json_insert(tags, '$[#]', '${COLD_TAG}') WHERE id IN (${newly})`).bind(...w.binds).run();
	// Anyone tagged cold who has read something since they were tagged is warm again.
	const warm = `SELECT s.id FROM subscribers s WHERE s.brand_id = ? AND ${hasTag} AND EXISTS (SELECT 1 FROM sends x WHERE x.subscriber_id = s.id AND (x.opened_at >= COALESCE((SELECT MAX(e.at) FROM events e WHERE e.brand_id = s.brand_id AND e.subscriber_id = s.id AND e.kind = 'cold'), '') OR x.clicked_at >= COALESCE((SELECT MAX(e.at) FROM events e WHERE e.brand_id = s.brand_id AND e.subscriber_id = s.id AND e.kind = 'cold'), '')))`;
	const warmed = await db.prepare(`UPDATE subscribers SET tags = (SELECT json_group_array(value) FROM json_each(subscribers.tags) WHERE value != '${COLD_TAG}') WHERE id IN (${warm})`).bind(brand).run();
	return { tagged: logged.meta.changes ?? 0, warmed: warmed.meta.changes ?? 0 };
}

/** Take cold people off every list. All of them now (by hand), or only those tagged cold for a month already (automatic). */
export async function removeCold(db: D1Database, brand: string, p: Pick<ColdPolicy, "days" | "min">, opts: { afterGrace: boolean }, now = Date.now()): Promise<number> {
	const w = await coldWhere(db, brand, p, now);
	const at = iso(new Date(now));
	const grace = iso(new Date(now - GRACE_DAYS * DAY));
	const who = opts.afterGrace ? `SELECT s.id FROM subscribers s WHERE ${w.sql} AND ${hasTag} AND (SELECT MAX(e.at) FROM events e WHERE e.brand_id = s.brand_id AND e.subscriber_id = s.id AND e.kind = 'cold') <= ?` : `SELECT s.id FROM subscribers s WHERE ${w.sql}`;
	const binds = opts.afterGrace ? [...w.binds, grace] : w.binds;
	const detail = opts.afterGrace ? `Cold contact clean up: still no opens or clicks ${GRACE_DAYS} days after being tagged ${COLD_TAG}` : `Cold contact clean up: no opens or clicks in ${p.days} days`;
	await db.prepare(`INSERT INTO events (brand_id, at, kind, subscriber_id, campaign_id, detail) SELECT ?, ?, 'unsubscribed', id, NULL, ? FROM (${who})`).bind(brand, at, detail, ...binds).run();
	const r = await db.prepare(`UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE status = 'active' AND list_id IN (SELECT id FROM lists WHERE brand_id = ?) AND subscriber_id IN (${who})`).bind(at, brand, ...binds).run();
	return r.meta.changes ?? 0;
}

/** Once a day for each newsletter with the policy on (the cron calls this every minute; it's one query when nothing's due). */
export async function coldDue(db: D1Database, now = Date.now()): Promise<void> {
	const { results } = await db.prepare("SELECT key FROM meta WHERE key LIKE 'cold:%'").all<{ key: string }>();
	const today = iso(new Date(now)).slice(0, 10);
	for (const r of results) {
		const brand = r.key.slice("cold:".length);
		const p = await getCold(db, brand);
		if (!p.on || (await getMeta(db, runKey(brand))) === today) continue;
		await setMeta(db, runKey(brand), today);
		if (p.remove) await removeCold(db, brand, p, { afterGrace: true }, now);
		await tagCold(db, brand, p, now);
	}
}
