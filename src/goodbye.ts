// The goodbye email (Settings, Lists): when someone unsubscribes, an optional short note to say it's done, with a
// one click way back in case they pressed it by accident. Off unless the owner switches it on.
//
// The way back restores exactly the lists they just left, for 30 days. The link opens a page that presses its own
// button, so link checkers in mail apps (which follow links but don't run scripts) can't resubscribe anyone.

import { getMeta, iso, logEvent, setMeta, type BrandRow, type Env, type SubscriberRow } from "./db.ts";

export interface Goodbye {
	on: boolean;
	/** The note, in the owner's words. Paragraphs split by blank lines. */
	text: string;
}

export const DEFAULT_TEXT = "You've unsubscribed, so you won't get any more emails from us.\n\nIf that was a mistake, press the button below and we'll put you straight back on.";
/** How long the way back works. */
export const BACK_DAYS = 30;

const key = (brand: string) => `goodbye:${brand}`;
const backKey = (sub: string) => `back:${sub}`;

export async function getGoodbye(db: D1Database, brand: string): Promise<Goodbye> {
	try {
		const v = JSON.parse((await getMeta(db, key(brand))) ?? "null");
		return { on: Boolean(v?.on), text: typeof v?.text === "string" && v.text.trim() ? v.text : DEFAULT_TEXT };
	} catch {
		return { on: false, text: DEFAULT_TEXT };
	}
}

export function cleanGoodbye(v: any): Goodbye {
	const text = typeof v?.text === "string" ? v.text.replace(/\r/g, "").trim().slice(0, 2000) : "";
	return { on: v?.on === true, text: text || DEFAULT_TEXT };
}
export const saveGoodbye = (db: D1Database, brand: string, g: Goodbye) => setMeta(db, key(brand), JSON.stringify(g));

interface Back {
	lists: string[];
	until: string;
}

/** After an unsubscribe: send the goodbye (once a month at most) and remember the way back. */
export async function sayGoodbye(env: Env, b: BrandRow, s: SubscriberRow, lists: string[], what: string, send: (to: string, subject: string, paras: string[], button: { label: string; href: string }) => Promise<boolean>, base: string): Promise<boolean> {
	if (!lists.length || s.suppressed) return false;
	const g = await getGoodbye(env.DB, b.id);
	if (!g.on) return false;
	const old = await getBack(env.DB, s.id);
	await setMeta(env.DB, backKey(s.id), JSON.stringify({ lists: [...new Set([...(old?.lists ?? []), ...lists])], until: iso(new Date(Date.now() + BACK_DAYS * 86_400_000)) } satisfies Back));
	// Someone who unsubscribes again within the month doesn't get a second goodbye.
	if (old) return false;
	return send(s.email, `You've unsubscribed from ${what}`, g.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean), { label: "Put me back on", href: `${base}/u/${s.token}/back` });
}

export async function getBack(db: D1Database, sub: string): Promise<Back | null> {
	try {
		const v = JSON.parse((await getMeta(db, backKey(sub))) ?? "null");
		return v && Array.isArray(v.lists) && typeof v.until === "string" && v.until > iso() ? v : null;
	} catch {
		return null;
	}
}

/** The way back: the lists they left go back on. Returns the list ids, or null when the link has expired. */
export async function comeBack(db: D1Database, b: BrandRow, s: SubscriberRow): Promise<string[] | null> {
	const back = await getBack(db, s.id);
	if (!back || s.suppressed) return null;
	const { results } = await db.prepare("SELECT m.list_id FROM memberships m JOIN lists l ON l.id = m.list_id WHERE m.subscriber_id = ? AND l.brand_id = ? AND m.status = 'unsubscribed' AND m.list_id IN (SELECT value FROM json_each(?))").bind(s.id, b.id, JSON.stringify(back.lists)).all<{ list_id: string }>();
	const ids = results.map((r) => r.list_id);
	const stmts = ids.map((id) => db.prepare("UPDATE memberships SET status = 'active', left_at = NULL WHERE subscriber_id = ? AND list_id = ?").bind(s.id, id));
	stmts.push(db.prepare("DELETE FROM meta WHERE key = ?").bind(backKey(s.id)));
	if (ids.length) stmts.push(logEvent(db, b.id, "subscribed", s.id, null, "came back from the goodbye email"));
	await db.batch(stmts);
	return ids;
}

/** Tidy the ways back that have run out (nightly is plenty; the cron calls it every minute but it's one query). */
export async function tidyBacks(db: D1Database): Promise<void> {
	await db.prepare("DELETE FROM meta WHERE key LIKE 'back:%' AND json_extract(value, '$.until') < ?").bind(iso()).run();
}
