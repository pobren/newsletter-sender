// Open and click log retention (Settings, Tracking): how long to keep who opened and clicked each campaign.
//
// Each campaign keeps a row per reader (were they sent it, did they open it, which links they clicked). Those rows are
// most of the database. Once a campaign is older than the owner's choice, we save its totals (sent, opens, clicks,
// bounces, links, countries) and then clear the rows, so the report still shows the numbers but not who did what.
//
// Forever is the default. The shortest choice is a year, because "only people who opened in the last year", cold
// contacts and sending again to people who didn't open all look back up to a year.

import { getMeta, iso, setMeta } from "./db.ts";

export const KEEP_CHOICES = [0, 365, 730, 1095] as const; // 0 = forever
export type Keep = (typeof KEEP_CHOICES)[number];

/** Rows cleared a go: small enough for one D1 query, and the cron comes back in a minute for the rest. */
const CHUNK = 5000;
const DAY = 86_400_000;

const key = (brand: string) => `retain:${brand}`;
const keptKey = (campaign: string) => `kept:${campaign}`;

export async function getKeep(db: D1Database, brand: string): Promise<Keep> {
	const v = Number(await getMeta(db, key(brand)));
	return (KEEP_CHOICES as readonly number[]).includes(v) ? (v as Keep) : 0;
}
export const cleanKeep = (v: unknown): Keep => ((KEEP_CHOICES as readonly number[]).includes(Number(v)) ? (Number(v) as Keep) : 0);
export const saveKeep = (db: D1Database, brand: string, days: Keep) => setMeta(db, key(brand), String(days));

export interface Kept {
	stats: Record<string, number>;
	links: { n: number; url: string; clicks: number; people: number }[];
	countries: { country: string; n: number }[];
	/** When the per-person detail was cleared (set once it's all gone). */
	cleared_at: string | null;
}

export async function keptOne(db: D1Database, campaign: string): Promise<Kept | null> {
	try {
		return JSON.parse((await getMeta(db, keptKey(campaign))) ?? "null");
	} catch {
		return null;
	}
}

/** Saved totals for any of these campaigns that have them, by campaign id. */
export async function keptFor(db: D1Database, ids: string[]): Promise<Map<string, Kept>> {
	const out = new Map<string, Kept>();
	if (!ids.length) return out;
	const { results } = await db.prepare("SELECT key, value FROM meta WHERE key IN (SELECT 'kept:' || value FROM json_each(?))").bind(JSON.stringify(ids)).all<{ key: string; value: string }>();
	for (const r of results) {
		try {
			out.set(r.key.slice(5), JSON.parse(r.value));
		} catch {}
	}
	return out;
}

/** Campaign list rows (with sent, opens and clicks counted from the rows) get their saved totals instead, once cleared. */
export async function withKept<T extends { id: string; sent?: number; opens?: number; clicks?: number; bounced?: number; complained?: number; unsubscribed?: number }>(db: D1Database, rows: T[]): Promise<T[]> {
	const k = await keptFor(db, rows.map((r) => r.id));
	if (!k.size) return rows;
	return rows.map((r) => {
		const s = k.get(r.id)?.stats;
		if (!s) return r;
		const o: any = { ...r };
		for (const f of ["sent", "opens", "clicks"] as const) if (f in r) o[f] = s[f] ?? 0;
		return o;
	});
}

/** How many campaigns, and per-person rows, are older than this choice (for the Settings page). */
export async function olderThan(db: D1Database, brand: string, days: number, now = Date.now()): Promise<{ campaigns: number; rows: number }> {
	if (!days) return { campaigns: 0, rows: 0 };
	const r = await db
		.prepare("SELECT COUNT(*) AS campaigns, COALESCE(SUM((SELECT COUNT(*) FROM sends x WHERE x.campaign_id = c.id)), 0) AS rows FROM campaigns c WHERE c.brand_id = ? AND c.finished_at IS NOT NULL AND c.finished_at < ?")
		.bind(brand, iso(new Date(now - days * DAY)))
		.first<{ campaigns: number; rows: number }>();
	return { campaigns: r?.campaigns ?? 0, rows: r?.rows ?? 0 };
}

/**
 * Clear old campaigns' per-person rows for every newsletter with a retention set. Saves each campaign's totals first,
 * then clears a chunk at a time, up to `budget` rows a run. The cron calls this every minute.
 * `snapshot` makes the totals (campaignStats and the report's links and countries).
 */
export async function clearOld(db: D1Database, snapshot: (id: string) => Promise<Omit<Kept, "cleared_at">>, now = Date.now(), budget = 20_000, chunk = CHUNK): Promise<number> {
	const { results: brands } = await db.prepare("SELECT key, value FROM meta WHERE key LIKE 'retain:%' AND value != '0'").all<{ key: string; value: string }>();
	let cleared = 0;
	for (const b of brands) {
		const days = cleanKeep(b.value);
		if (!days) continue;
		const brand = b.key.slice("retain:".length);
		const cutoff = iso(new Date(now - days * DAY));
		// Old campaigns not yet fully cleared.
		const { results: due } = await db
			.prepare(`SELECT c.id FROM campaigns c WHERE c.brand_id = ? AND c.finished_at IS NOT NULL AND c.finished_at < ?
				AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'kept:' || c.id AND json_extract(m.value, '$.cleared_at') IS NOT NULL) ORDER BY c.finished_at LIMIT 10`)
			.bind(brand, cutoff)
			.all<{ id: string }>();
		for (const { id } of due) {
			let k = await keptOne(db, id);
			if (!k) {
				k = { ...(await snapshot(id)), cleared_at: null };
				await setMeta(db, keptKey(id), JSON.stringify(k));
			}
			while (cleared < budget) {
				const lc = (await db.prepare("DELETE FROM link_clicks WHERE rowid IN (SELECT rowid FROM link_clicks WHERE campaign_id = ? LIMIT ?)").bind(id, chunk).run()).meta.changes ?? 0;
				cleared += lc;
				if (lc >= chunk) continue;
				const r =await db.prepare("DELETE FROM sends WHERE id IN (SELECT id FROM sends WHERE campaign_id = ? LIMIT ?)").bind(id, chunk).run();
				const n = r.meta.changes ?? 0;
				cleared += n;
				if (n < chunk) {
					await setMeta(db, keptKey(id), JSON.stringify({ ...k, cleared_at: iso(new Date(now)) }));
					break;
				}
			}
			if (cleared >= budget) return cleared;
		}
	}
	return cleared;
}

/** A deleted campaign takes its saved totals with it. */
export const forgetKept = (db: D1Database, campaign: string) => db.prepare("DELETE FROM meta WHERE key = ?").bind(keptKey(campaign));
