// Testing two subject lines. A share of the audience (picked at random) is split in half: one half gets subject A,
// the other subject B. After the wait, whichever got more opens (or clicks) goes to everyone else.
//
// No extra column on `sends`: the rows are added in random order, so their ids alone say who got what.
// Ids up to aTo got A, up to bTo got B, and the rest wait for the winner.

import { iso, logEvent, type CampaignRow, type Env } from "./db.ts";

export interface Ab {
	/** The second subject line. */
	b: string;
	/** Share of the audience in the test, 10 to 50 (half get each subject). */
	pct: number;
	/** Hours to wait before picking the winner. */
	hours: number;
	by: "opens" | "clicks";
	/** Set when sending starts. */
	aTo?: number;
	bTo?: number;
	at?: string;
	winner?: "a" | "b";
}

export const PCTS = [10, 20, 30, 40, 50];
export const HOURS = [1, 2, 4, 8, 12, 24];
/** Fewer people than this and there's no test: everyone gets subject A. */
export const MIN_PEOPLE = 20;

export function parseAb(s: string | null | undefined): Ab | null {
	if (!s) return null;
	try {
		const a = JSON.parse(s);
		return a && typeof a.b === "string" && a.b.trim() ? a : null;
	} catch {
		return null;
	}
}

/** What the editor sends, made safe. Null when the test is off. */
export function cleanAb(x: any, tracking: { opens: boolean; clicks: boolean }): Ab | null {
	if (!x?.on) return null;
	const b = String(x.subject ?? "").trim().slice(0, 200);
	if (!b) return null;
	const by = x.by === "clicks" && tracking.clicks ? "clicks" : tracking.opens ? "opens" : tracking.clicks ? "clicks" : null;
	if (!by) return null;
	const pct = PCTS.includes(Number(x.pct)) ? Number(x.pct) : 20;
	const hours = HOURS.includes(Number(x.hours)) ? Number(x.hours) : 4;
	return { b, pct, hours, by };
}

/** The test groups for send rows lo..lo+total-1. Null when there are too few people to test. */
export function abSplit(lo: number, total: number, pct: number): { aTo: number; bTo: number } | null {
	if (total < MIN_PEOPLE) return null;
	const each = Math.max(1, Math.floor(Math.round((total * pct) / 100) / 2));
	return { aTo: lo + each - 1, bTo: lo + each * 2 - 1 };
}

/** Which subject a send row gets. */
export function subjectFor(c: Pick<CampaignRow, "subject">, ab: Ab | null, id: number): string {
	if (!ab || ab.aTo == null || ab.bTo == null) return c.subject;
	if (id <= ab.aTo) return c.subject;
	if (id <= ab.bTo) return ab.b;
	return ab.winner === "b" ? ab.b : c.subject;
}

/** The highest send row that may go now: the test groups only, until there's a winner. */
export function sendableTo(ab: Ab | null, hi: number): number {
	return ab && ab.bTo != null && !ab.winner ? Math.min(hi, ab.bTo) : hi;
}

export interface AbGroup {
	sent: number;
	opens: number;
	clicks: number;
}

export async function abResults(db: D1Database, c: Pick<CampaignRow, "id">, ab: Ab): Promise<{ a: AbGroup; b: AbGroup }> {
	const { results } = await db
		.prepare(`SELECT CASE WHEN id <= ?2 THEN 'a' ELSE 'b' END AS g, COUNT(*) AS sent, COUNT(opened_at) AS opens, COUNT(clicked_at) AS clicks
			FROM sends WHERE campaign_id = ?1 AND id <= ?3 AND status = 'sent' GROUP BY g`)
		.bind(c.id, ab.aTo, ab.bTo)
		.all<AbGroup & { g: string }>();
	const zero = { sent: 0, opens: 0, clicks: 0 };
	const pick = (g: string) => {
		const r = results.find((x) => x.g === g);
		return r ? { sent: r.sent, opens: r.opens, clicks: r.clicks } : zero;
	};
	return { a: pick("a"), b: pick("b") };
}

/** B wins only when it did better; a tie goes to A, the subject you wrote first. */
export function winnerOf(r: { a: AbGroup; b: AbGroup }, by: Ab["by"]): "a" | "b" {
	const rate = (g: AbGroup) => (g.sent ? g[by] / g.sent : 0);
	return rate(r.b) > rate(r.a) ? "b" : "a";
}

/** Every minute: picks the winner for tests whose wait is over, and sends it to everyone else. */
export async function pickWinners(env: Env, enqueue: (env: Env, campaign: string, lo: number, hi: number, run?: number) => Promise<void>, now = new Date()): Promise<void> {
	const db = env.DB;
	const { results } = await db
		.prepare("SELECT * FROM campaigns WHERE ab IS NOT NULL AND json_extract(ab, '$.at') <= ? AND json_extract(ab, '$.winner') IS NULL AND status IN ('sending', 'paused', 'sent') LIMIT 5")
		.bind(iso(now))
		.all<CampaignRow>();
	for (const c of results) {
		const ab = parseAb(c.ab);
		if (!ab || ab.bTo == null) continue;
		const r = await abResults(db, c, ab);
		ab.winner = winnerOf(r, ab.by);
		const claimed = await db.prepare("UPDATE campaigns SET ab = ?, updated_at = ? WHERE id = ? AND json_extract(ab, '$.winner') IS NULL RETURNING id").bind(JSON.stringify(ab), iso(now), c.id).first();
		if (!claimed) continue;
		await logEvent(db, c.brand_id, "campaign.ab_winner", null, c.id, ab.winner === "b" ? ab.b : c.subject).run();
		if (c.status !== "sending") continue; // a paused send picks up the rest when you carry on
		const rest = await db.prepare("SELECT MIN(id) AS lo, MAX(id) AS hi FROM sends WHERE campaign_id = ? AND status = 'queued' AND id > ?").bind(c.id, ab.bTo).first<{ lo: number | null; hi: number | null }>();
		if (rest?.lo != null && rest.hi != null) await enqueue(env, c.id, rest.lo, rest.hi, c.run);
	}
}
