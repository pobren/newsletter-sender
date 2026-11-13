// Domain warm up (Settings, Sending): a new sending domain starts with a small number of emails a day, and the number
// grows each day, so Gmail, Yahoo and Microsoft get to trust it. When a campaign reaches the day's number it pauses, and
// carries on by itself the next day (UTC). Once the daily number passes FULL, warm up switches itself off.
//
// Each queue worker reserves its emails before sending (reserve: a compare and swap on one meta row a day), so 20
// workers at once can't go over the day's number between them.

import { getMeta, iso, logEvent, setMeta, type CampaignRow, type Env } from "./db.ts";

export interface Warmup {
	on: boolean;
	/** The first day, YYYY-MM-DD (UTC). */
	start: string;
	/** Emails on the first day. */
	first: number;
	/** Campaigns paused for the day, to carry on tomorrow. */
	waiting: string[];
	/** It reached FULL and switched itself off. */
	done?: boolean;
}

/** Each day sends this much more than the day before. */
export const GROWTH = 1.5;
/** Past this many a day, the domain is warmed up. */
export const FULL = 50_000;
export const FIRSTS = [50, 200, 1000];

const key = (brand: string) => `warmup:${brand}`;
export const today = (now = new Date()) => now.toISOString().slice(0, 10);
const dayNumber = (start: string, day: string) => Math.max(0, Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000));

/** A tidy number: two significant figures. */
const tidy = (n: number) => {
	const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
	return Math.round(n / p) * p;
};

/** The day's number of emails, or null once warm up is finished. */
export function dailyLimit(w: Pick<Warmup, "start" | "first">, day: string): number | null {
	const raw = w.first * GROWTH ** dayNumber(w.start, day);
	if (!Number.isFinite(raw) || raw > FULL) return null;
	const n = tidy(raw);
	return n > FULL ? null : n;
}

/** The whole plan, day by day, for Settings. */
export function plan(first: number): number[] {
	const out: number[] = [];
	for (let d = 0; d < 60; d++) {
		const n = dailyLimit({ start: "2026-01-01", first }, today(new Date(Date.parse("2026-01-01T00:00:00Z") + d * 86_400_000)));
		if (n === null) break;
		out.push(n);
	}
	return out;
}

export async function getWarmup(db: D1Database, brand: string): Promise<Warmup | null> {
	try {
		const v = JSON.parse((await getMeta(db, key(brand))) ?? "null");
		return v && typeof v.start === "string" ? { on: Boolean(v.on), start: v.start, first: Number(v.first) || 50, waiting: Array.isArray(v.waiting) ? v.waiting : [], done: Boolean(v.done) } : null;
	} catch {
		return null;
	}
}
export const saveWarmup = (db: D1Database, brand: string, w: Warmup | null) => setMeta(db, key(brand), w ? JSON.stringify(w) : null);

const usedKey = (brand: string, day: string) => `wu:${brand}:${day}`;
export async function usedToday(db: D1Database, brand: string, day = today()): Promise<number> {
	return Number(await getMeta(db, usedKey(brand, day))) || 0;
}

/** Takes up to `want` of the day's emails. Says how many it got (0 when the day's number is used up). */
export async function reserve(db: D1Database, brand: string, want: number, limit: number, day = today()): Promise<number> {
	const k = usedKey(brand, day);
	await db.prepare("INSERT INTO meta (key, value) VALUES (?, '0') ON CONFLICT (key) DO NOTHING").bind(k).run();
	for (let i = 0; i < 8; i++) {
		const old = Number(await getMeta(db, k)) || 0;
		const got = Math.max(0, Math.min(want, limit - old));
		if (!got) return 0;
		const r = await db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").bind(String(old + got), k, String(old)).run();
		if (r.meta.changes) return got;
	}
	return 0;
}

/** For the sending queue: how many of these rows may go now, or null when there's no warm up. */
export async function allowance(db: D1Database, brand: string, rows: number): Promise<number | null> {
	const w = await getWarmup(db, brand);
	if (!w?.on) return null;
	const limit = dailyLimit(w, today());
	if (limit === null) {
		await saveWarmup(db, brand, { ...w, on: false, done: true });
		await logEvent(db, brand, "warmup.finished", null, null, "Domain warm up finished").run();
		return null;
	}
	return reserve(db, brand, rows, limit);
}

/** A campaign reached the day's number: pause it, and remember to carry on tomorrow. */
export async function waitForTomorrow(db: D1Database, c: CampaignRow): Promise<void> {
	const w = await getWarmup(db, c.brand_id);
	if (!w) return;
	const limit = dailyLimit(w, today());
	const paused = await db.prepare("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'sending' RETURNING id").bind(iso(), c.id).first();
	if (!paused) return;
	await logEvent(db, c.brand_id, "campaign.paused", null, c.id, `Domain warm up: today's ${limit?.toLocaleString("en-GB") ?? ""} emails have gone. The rest carry on by themselves tomorrow.`).run();
	if (!w.waiting.includes(c.id)) await saveWarmup(db, c.brand_id, { ...w, waiting: [...w.waiting, c.id] });
}

/** Every minute (cron): on a new day, carries on the campaigns that warm up paused. */
export async function carryOnTomorrow(env: Env, resume: (env: Env, c: CampaignRow) => Promise<unknown>, now = new Date()): Promise<void> {
	const { results } = await env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'warmup:%'").all<{ key: string; value: string }>();
	for (const r of results) {
		const brand = r.key.slice("warmup:".length);
		const w = await getWarmup(env.DB, brand);
		if (!w?.waiting.length) continue;
		const day = today(now);
		// Only once the day has turned: the paused day's emails are all used.
		const limit = w.on ? dailyLimit(w, day) : null;
		if (limit !== null && (await usedToday(env.DB, brand, day)) >= limit) continue;
		await saveWarmup(env.DB, brand, { ...w, waiting: [] });
		for (const id of w.waiting) {
			const c = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ? AND status = 'paused'").bind(id).first<CampaignRow>();
			if (c) await resume(env, c);
		}
	}
	// Tidy the day counts from before yesterday.
	await env.DB.prepare("DELETE FROM meta WHERE key LIKE 'wu:%' AND substr(key, -10) < ?").bind(today(new Date(now.getTime() - 2 * 86_400_000))).run();
}

/** What Settings, Sending shows. */
export async function warmupStatus(db: D1Database, brand: string) {
	const w = await getWarmup(db, brand);
	const day = today();
	const limit = w?.on ? dailyLimit(w, day) : null;
	return {
		on: Boolean(w?.on && limit !== null),
		finished: Boolean(w?.done),
		first: w?.first ?? 50,
		start: w?.start ?? null,
		day: w ? dayNumber(w.start, day) + 1 : null,
		limit,
		used: w?.on ? await usedToday(db, brand, day) : 0,
		waiting: w?.waiting.length ?? 0,
		plan: plan(w?.first ?? 50),
	};
}
