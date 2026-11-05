// Sending health: stop a send before Amazon (or any other service) gets worried, and show how the account is doing.
import { iso, logEvent } from "./db.ts";

/** Amazon reviews an account at a 5% bounce rate or a 0.1% complaint rate, and can stop it at 10% or 0.5%. */
export const LIMITS = { minSent: 100, bounce: 0.05, bounceMin: 10, complaint: 0.002, complaintMin: 3 };

const pc = (n: number, of: number) => `${(Math.round((n / of) * 1000) / 10).toLocaleString("en-GB")}%`;

/** Why a send should stop for safety, or null when it looks fine. */
export function troubleWhy(r: { sent: number; bounced: number; complained: number }): string | null {
	if (r.sent < LIMITS.minSent) return null;
	if (r.bounced >= LIMITS.bounceMin && r.bounced / r.sent > LIMITS.bounce)
		return `Paused for safety: ${pc(r.bounced, r.sent)} of this email bounced (${r.bounced.toLocaleString("en-GB")} of ${r.sent.toLocaleString("en-GB")}). Amazon starts to worry at 5% and can stop your account at 10%, so we stopped first. An old or bought list is the usual cause. If you're happy the list is good, press Carry on sending.`;
	if (r.complained >= LIMITS.complaintMin && r.complained / r.sent > LIMITS.complaint)
		return `Paused for safety: ${r.complained.toLocaleString("en-GB")} people marked this email as spam (${pc(r.complained, r.sent)}). Amazon starts to worry at 0.1% and can stop your account at 0.5%, so we stopped first. Check everyone on the list asked to hear from you. If you're happy, press Carry on sending.`;
	return null;
}

/** After a bounce or complaint: pause the campaign if too many of its emails are bouncing or being marked as spam. */
export async function checkCampaign(db: D1Database, id: string, force = false): Promise<boolean> {
	const c = await db.prepare("SELECT id, brand_id, status, health FROM campaigns WHERE id = ?").bind(id).first<{ id: string; brand_id: string; status: string; health: number }>();
	if (!c || c.status !== "sending" || c.health) return false; // health 2: the owner chose to carry on
	const ev = await db.prepare("SELECT COUNT(DISTINCT CASE WHEN kind = 'bounced' THEN subscriber_id END) AS bounced, COUNT(DISTINCT CASE WHEN kind = 'complained' THEN subscriber_id END) AS complained FROM events WHERE campaign_id = ? AND kind IN ('bounced', 'complained')").bind(id).first<{ bounced: number; complained: number }>();
	if (!ev) return false;
	// Counting the sent emails reads every row, so only do it when the bounces or complaints could tip it over.
	if (!force && ev.complained < LIMITS.complaintMin && (ev.bounced < LIMITS.bounceMin || ev.bounced % 5)) return false;
	const sent = await db.prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ? AND status = 'sent'").bind(id).first<{ n: number }>();
	const why = troubleWhy({ sent: sent?.n ?? 0, bounced: ev.bounced, complained: ev.complained });
	if (!why) return false;
	const done = await db.prepare("UPDATE campaigns SET status = 'paused', health = 1, updated_at = ? WHERE id = ? AND status = 'sending' RETURNING id").bind(iso(), id).first();
	if (done) await logEvent(db, c.brand_id, "campaign.paused", null, id, why).run();
	return Boolean(done);
}

/** How a rate compares with what sending services expect: good, ok (keep an eye on it) or bad. */
export function level(kind: "bounce" | "complaint", n: number, sent: number): "good" | "ok" | "bad" | "few" {
	if (sent < LIMITS.minSent) return "few";
	const r = n / sent;
	if (kind === "bounce") return r < 0.02 ? "good" : r < 0.05 ? "ok" : "bad";
	return r < 0.0005 ? "good" : r < 0.001 ? "ok" : "bad";
}

/** The last 30 days for a brand: emails sent, and how many bounced or were marked as spam. */
export async function brandHealth(db: D1Database, brandId: string, now = Date.now()) {
	const since = iso(new Date(now - 30 * 86_400_000));
	const r = await db.prepare(`SELECT (SELECT COUNT(*) FROM sends x JOIN campaigns c ON c.id = x.campaign_id WHERE c.brand_id = ?1 AND x.status = 'sent' AND x.sent_at >= ?2) AS sent,
		(SELECT COUNT(DISTINCT subscriber_id) FROM events WHERE brand_id = ?1 AND kind = 'bounced' AND at >= ?2) AS bounced,
		(SELECT COUNT(DISTINCT subscriber_id) FROM events WHERE brand_id = ?1 AND kind = 'complained' AND at >= ?2) AS complained`).bind(brandId, since).first<{ sent: number; bounced: number; complained: number }>();
	const sent = r?.sent ?? 0, bounced = r?.bounced ?? 0, complained = r?.complained ?? 0;
	const paused = (await db.prepare("SELECT c.id, COALESCE(c.name, c.subject) AS name, (SELECT detail FROM events e WHERE e.campaign_id = c.id AND e.kind = 'campaign.paused' ORDER BY e.id DESC LIMIT 1) AS why FROM campaigns c WHERE c.brand_id = ? AND c.status = 'paused' ORDER BY c.updated_at DESC LIMIT 5").bind(brandId).all<{ id: string; name: string; why: string | null }>()).results;
	return { sent, bounced, complained, bounceLevel: level("bounce", bounced, sent), complaintLevel: level("complaint", complained, sent), paused };
}
