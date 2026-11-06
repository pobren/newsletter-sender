// Load testing: a campaign named in the "loadtest" meta row is "sent" by a pretend sender that answers like Amazon SES
// would (after a short wait) but never sends anything. Only addresses at example.test are accepted, so a real reader can
// never be reached by mistake. Set it up with SQL in D1, then remove the meta row and the test data afterwards.
import { getMeta, iso, logEvent } from "./db.ts";
import type { Sent } from "./providers.ts";

export interface LoadTest {
	campaign: string;
	/** Percent of emails that "bounce" (recorded as if Amazon told us). */
	bounce?: number;
	/** Percent marked as spam. */
	complaint?: number;
	/** Emails a second, instead of the brand's own rate. */
	rate?: number;
	/** Milliseconds each pretend send takes. */
	ms?: number;
}

export async function loadTestFor(db: D1Database, campaign: string): Promise<LoadTest | null> {
	const raw = await getMeta(db, "loadtest");
	if (!raw) return null;
	try {
		const t = JSON.parse(raw) as LoadTest;
		return t.campaign === campaign ? t : null;
	} catch {
		return null;
	}
}

/** The same address always gets the same result in a campaign, so a run can be checked afterwards. Each campaign mixes
 * in its own id, so a second test campaign doesn't pick the very people the first one already suppressed. */
export function pick(email: string, campaign = ""): number {
	let h = 0;
	for (const ch of campaign + email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return h % 10000;
}

export async function pretendSend(t: LoadTest, to: string): Promise<Sent> {
	if (!/@example\.test$/i.test(to)) return { ok: false, error: "Load tests only send to example.test addresses." };
	await new Promise((r) => setTimeout(r, t.ms ?? 80));
	return { ok: true, id: `loadtest-${crypto.randomUUID()}` };
}

/** After a batch: record the pretend bounces and complaints, as Amazon would report them. */
export function pretendReplies(db: D1Database, brandId: string, campaign: string, t: LoadTest, rows: { sub: string; email: string }[]): D1PreparedStatement[] {
	const out: D1PreparedStatement[] = [];
	for (const r of rows) {
		const p = pick(r.email, campaign);
		const kind = p < (t.bounce ?? 0) * 100 ? "bounced" : p < ((t.bounce ?? 0) + (t.complaint ?? 0)) * 100 ? "complained" : null;
		if (!kind) continue;
		out.push(logEvent(db, brandId, kind, r.sub, campaign, "load test"));
		out.push(db.prepare("UPDATE subscribers SET suppressed = ?, suppressed_at = ? WHERE id = ? AND suppressed IS NULL").bind(kind, iso(), r.sub));
	}
	return out;
}
