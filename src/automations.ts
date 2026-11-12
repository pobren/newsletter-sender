// Automations: "when someone does this, then do that", with waits in between. A trigger (joining a list, opening or
// clicking an email, unsubscribing) starts a run for that person; the minute cron carries each run on when its next
// step is due. Each person goes through an automation once, except yearly ones (like a birthday), which start again
// each year, and profile updates, which start again each time someone changes their details (once the last run is over). Date triggers are checked once a day, from the hour chosen (UK time).
import { iso, linkBase, logEvent, newId, origin, type BrandRow, type Env, type SubscriberRow } from "./db.ts";
import { sendOne } from "./providers.ts";
import { listHeaders, renderEmail } from "./render.ts";
import { mergeSubject } from "./sending.ts";
import { loadProvider } from "./settings.ts";

export const TRIGGERS = ["joined", "opened", "clicked", "unsubscribed", "yearly", "date", "updated"] as const;
export const ACTIONS = ["email", "add_list", "remove_list", "tag", "notify", "webhook"] as const;

export interface Trigger {
	kind: (typeof TRIGGERS)[number];
	/** joined / unsubscribed: this list ("" for any). updated: only people on this list ("" for anyone). */
	list?: string;
	/** updated (the event only): the lists the person is on now. */
	lists?: string[];
	/** updated (the event only): what changed, such as "name" or "lists". */
	changed?: string[];
	/** opened / clicked: this campaign ("" for any). */
	campaign?: string;
	/** clicked: this link number in the campaign (0 for any). */
	link?: number;
	/** yearly: the custom field holding each person's date, like birthday. */
	field?: string;
	/** date: the day it runs, YYYY-MM-DD. */
	date?: string;
	/** yearly / date: the hour (UK time) it starts, 0 to 23. */
	hour?: number;
}

export interface Step {
	/** Hours to wait before this step. */
	wait: number;
	do: (typeof ACTIONS)[number];
	template?: string;
	subject?: string;
	list?: string;
	tag?: string;
	url?: string;
}

const hex = (v: unknown, n = 16) => (typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v) ? v : "");

/** Keeps only what makes sense in a trigger. */
export function cleanTrigger(t: any): Trigger | null {
	if (!t || !(TRIGGERS as readonly string[]).includes(t.kind)) return null;
	if (t.kind === "joined" || t.kind === "unsubscribed" || t.kind === "updated") return { kind: t.kind, list: hex(t.list) };
	const hour = Math.max(0, Math.min(23, Math.floor(Number(t.hour ?? 9)) || 0));
	if (t.kind === "yearly") return { kind: t.kind, list: hex(t.list), field: typeof t.field === "string" ? t.field.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40) : "", hour };
	if (t.kind === "date") return { kind: t.kind, list: hex(t.list), date: typeof t.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : "", hour };
	return { kind: t.kind, campaign: hex(t.campaign), ...(t.kind === "clicked" ? { link: Math.max(0, Math.min(500, Math.floor(Number(t.link) || 0))) } : {}) };
}

/** Keeps only steps that can run: up to 20, each waiting up to a year. */
export function cleanSteps(v: unknown): Step[] {
	if (!Array.isArray(v)) return [];
	const out: Step[] = [];
	for (const s of v.slice(0, 20)) {
		if (!s || !(ACTIONS as readonly string[]).includes(s.do)) continue;
		const wait = Math.max(0, Math.min(8760, Math.round(Number(s.wait) || 0)));
		const step: Step = { wait, do: s.do };
		if (s.do === "email") {
			step.template = hex(s.template);
			step.subject = typeof s.subject === "string" ? s.subject.replace(/\s+/g, " ").trim().slice(0, 200) : "";
			if (!step.template || !step.subject) continue;
		}
		if (s.do === "add_list" || s.do === "remove_list") {
			step.list = hex(s.list);
			if (!step.list) continue;
		}
		if (s.do === "tag") {
			step.tag = typeof s.tag === "string" ? s.tag.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40) : "";
			if (!step.tag) continue;
		}
		if (s.do === "webhook") {
			step.url = typeof s.url === "string" && /^https:\/\/\S{3,500}$/.test(s.url.trim()) ? s.url.trim() : "";
			if (!step.url) continue;
		}
		out.push(step);
	}
	return out;
}

/** Does this trigger match what just happened? */
export function matches(t: Trigger, e: Trigger): boolean {
	if (t.kind !== e.kind) return false;
	if (t.kind === "joined" || t.kind === "unsubscribed") return !t.list || t.list === e.list;
	if (t.kind === "updated") return !t.list || (e.lists ?? []).includes(t.list);
	if (t.campaign && t.campaign !== e.campaign) return false;
	return t.kind !== "clicked" || !t.link || t.link === e.link;
}

interface AutomationRow {
	id: string;
	brand_id: string;
	name: string;
	trigger: string;
	steps: string;
	enabled: number;
}

const parse = (s: string) => {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
};

/** Something happened to a person: start any automations it triggers (once per person per automation). */
export async function fire(db: D1Database, brandId: string, subscriberId: string, e: Trigger): Promise<void> {
	const { results } = await db.prepare("SELECT id, trigger, steps FROM automations WHERE brand_id = ? AND enabled = 1").bind(brandId).all<AutomationRow>();
	if (!results.length) return;
	const now = Date.now();
	const stmts: D1PreparedStatement[] = [];
	for (const a of results) {
		const t = cleanTrigger(parse(a.trigger));
		const steps = cleanSteps(parse(a.steps));
		if (!t || !steps.length || !matches(t, e)) continue;
		// A profile update starts again each time, once the last run has finished; anything else runs once a person.
		const again = t.kind === "updated" ? "DO UPDATE SET step = 0, due_at = excluded.due_at, status = 'waiting', created_at = excluded.created_at WHERE automation_runs.status != 'waiting'" : "DO NOTHING";
		stmts.push(db.prepare(`INSERT INTO automation_runs (automation_id, subscriber_id, step, due_at, status, created_at) VALUES (?, ?, 0, ?, 'waiting', ?) ON CONFLICT (automation_id, subscriber_id) ${again}`)
			.bind(a.id, subscriberId, iso(new Date(now + steps[0].wait * 3_600_000)), iso(new Date(now))));
	}
	if (stmts.length) await db.batch(stmts);
}

/** Fires without ever breaking what triggered it (a sign up, a click). */
export async function fireSafely(db: D1Database, brandId: string, subscriberId: string, e: Trigger): Promise<void> {
	try {
		await fire(db, brandId, subscriberId, e);
	} catch (err) {
		console.error("automation trigger failed", err);
	}
}

/** The day of the year in a date someone typed: 1990-03-05, 05/03/1990, 5.3.90 or 05/03 all give "03-05". */
export function monthDay(v: unknown): string | null {
	const s = String(v ?? "").trim();
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
	let mo: number, d: number;
	if (m) [mo, d] = [Number(m[2]), Number(m[3])];
	else if ((m = /^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-]\d{2,4})?$/.exec(s))) [d, mo] = [Number(m[1]), Number(m[2])];
	else return null;
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	return `${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Today in the UK, and the hour there. */
export function ukNow(now: Date): { day: string; hour: number } {
	const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
	return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Is a date trigger due today (and not yet run today)? */
export function dateDue(t: Trigger, lastDay: string | null, uk: { day: string; hour: number }): boolean {
	if (lastDay && lastDay >= uk.day) return false;
	if (uk.hour < (t.hour ?? 9)) return false;
	if (t.kind === "date") return Boolean(t.date) && t.date === uk.day;
	return t.kind === "yearly" && Boolean(t.field);
}

/** Once a day: start date automations for everyone whose day it is. People already part way through are left be. */
export async function runDates(db: D1Database, now = new Date()): Promise<number> {
	const { results } = await db.prepare("SELECT * FROM automations WHERE enabled = 1 AND json_extract(trigger, '$.kind') IN ('yearly', 'date')").all<AutomationRow & { last_day: string | null }>();
	const uk = ukNow(now);
	let started = 0;
	for (const a of results) {
		const t = cleanTrigger(parse(a.trigger));
		const steps = cleanSteps(parse(a.steps));
		if (!t || !steps.length || !dateDue(t, a.last_day, uk)) continue;
		// Mark the day first, so a slow run can't start twice.
		const claim = await db.prepare("UPDATE automations SET last_day = ? WHERE id = ? AND (last_day IS NULL OR last_day < ?) RETURNING id").bind(uk.day, a.id, uk.day).first();
		if (!claim) continue;
		const who = `FROM subscribers s WHERE s.brand_id = ?1 AND s.suppressed IS NULL AND EXISTS (SELECT 1 FROM memberships m JOIN lists l ON l.id = m.list_id WHERE m.subscriber_id = s.id AND m.status = 'active' AND l.brand_id = ?1 AND (?2 = '' OR m.list_id = ?2))`;
		let ids: string[];
		if (t.kind === "yearly") {
			const md = uk.day.slice(5);
			const rows = (await db.prepare(`SELECT s.id, json_extract(s.fields, '$.' || ?3) AS v ${who} AND json_extract(s.fields, '$.' || ?3) IS NOT NULL`).bind(a.brand_id, t.list ?? "", t.field).all<{ id: string; v: string }>()).results;
			// 29 February birthdays come round on 28 February in other years.
			const leap = md === "02-28" && !isLeap(Number(uk.day.slice(0, 4)));
			ids = rows.filter((r) => { const x = monthDay(r.v); return x === md || (leap && x === "02-29"); }).map((r) => r.id);
		} else {
			ids = (await db.prepare(`SELECT s.id ${who}`).bind(a.brand_id, t.list ?? "").all<{ id: string }>()).results.map((r) => r.id);
		}
		const due = iso(new Date(now.getTime() + steps[0].wait * 3_600_000));
		const stmts = ids.map((id) => db.prepare(`INSERT INTO automation_runs (automation_id, subscriber_id, step, due_at, status, created_at) VALUES (?, ?, 0, ?, 'waiting', ?)
			ON CONFLICT (automation_id, subscriber_id) DO UPDATE SET step = 0, due_at = excluded.due_at, status = 'waiting', created_at = excluded.created_at WHERE automation_runs.status != 'waiting'`).bind(a.id, id, due, iso(now)));
		for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
		started += ids.length;
	}
	return started;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The minute cron: carry on every run whose next step is due. */
export async function runDue(env: Env, fetcher: typeof fetch = fetch, now = new Date()): Promise<number> {
	const db = env.DB;
	await runDates(db, now).catch((e) => console.error("date automations", e));
	const { results: runs } = await db.prepare("SELECT id, automation_id, subscriber_id, step FROM automation_runs WHERE status = 'waiting' AND due_at <= ? ORDER BY due_at LIMIT 100").bind(iso(now)).all<{ id: number; automation_id: string; subscriber_id: string; step: number }>();
	if (!runs.length) return 0;
	const autos = new Map<string, AutomationRow | null>();
	const brands = new Map<string, BrandRow | null>();
	for (const run of runs) {
		if (!autos.has(run.automation_id)) autos.set(run.automation_id, await db.prepare("SELECT * FROM automations WHERE id = ?").bind(run.automation_id).first<AutomationRow>());
		const a = autos.get(run.automation_id);
		const steps = a ? cleanSteps(parse(a.steps)) : [];
		const step = steps[run.step];
		if (!a || !a.enabled || !step) {
			await db.prepare("UPDATE automation_runs SET status = ? WHERE id = ?").bind(a && !step ? "done" : "stopped", run.id).run();
			continue;
		}
		if (!brands.has(a.brand_id)) brands.set(a.brand_id, await db.prepare("SELECT * FROM brands WHERE id = ?").bind(a.brand_id).first<BrandRow>());
		const brand = brands.get(a.brand_id)!;
		const s = await db.prepare("SELECT * FROM subscribers WHERE id = ? AND brand_id = ?").bind(run.subscriber_id, a.brand_id).first<SubscriberRow>();
		let outcome: "next" | "stop" = "next";
		try {
			outcome = s && brand ? await doStep(env, brand, a, step, s, fetcher) : "stop";
		} catch (err) {
			console.error("automation step failed", err);
			// Try again in ten minutes, rather than lose the step.
			await db.prepare("UPDATE automation_runs SET due_at = ? WHERE id = ?").bind(iso(new Date(now.getTime() + 600_000)), run.id).run();
			continue;
		}
		const next = steps[run.step + 1];
		if (outcome === "stop") await db.prepare("UPDATE automation_runs SET status = 'stopped' WHERE id = ?").bind(run.id).run();
		else if (!next) await db.prepare("UPDATE automation_runs SET status = 'done', step = ? WHERE id = ?").bind(run.step + 1, run.id).run();
		else await db.prepare("UPDATE automation_runs SET step = ?, due_at = ? WHERE id = ?").bind(run.step + 1, iso(new Date(now.getTime() + next.wait * 3_600_000)), run.id).run();
	}
	return runs.length;
}

/** One step for one person. "stop" ends their run (they left, or can't be emailed). */
async function doStep(env: Env, b: BrandRow, a: AutomationRow, step: Step, s: SubscriberRow, fetcher: typeof fetch): Promise<"next" | "stop"> {
	const db = env.DB;
	const now = iso();
	if (step.do === "email") {
		// Only people who can still be emailed: not suppressed, and still on at least one list.
		if (s.suppressed) return "stop";
		const on = await db.prepare("SELECT 1 FROM memberships WHERE subscriber_id = ? AND status = 'active' LIMIT 1").bind(s.id).first();
		if (!on) return "stop";
		const t = await db.prepare("SELECT html FROM templates WHERE id = ? AND brand_id = ?").bind(step.template, b.id).first<{ html: string }>();
		const provider = await loadProvider(db, b);
		if (!t || !provider) throw new Error(t ? "No sending service" : "That template has gone");
		const base = linkBase(b, await origin(db));
		const unsub = `${base}/u/${s.token}`;
		const reader = { email: s.email, name: s.name, fields: parse(s.fields) ?? {} };
		const out = renderEmail(step.subject!, t.html, { brandName: b.name, colour: b.colour, logo: b.logo, footer: b.footer, unsubscribeUrl: unsub, manageUrl: `${base}/p/${s.token}`, footerLinks: b.footer_links & 1, track: null }, reader);
		const sent = await sendOne(provider, b.from_name, b.from_email, { to: s.email, subject: mergeSubject(step.subject!, reader), text: out.text, html: out.html, headers: listHeaders(unsub, `${b.id}.${new URL(base || "https://example.com").hostname}`), replyTo: b.reply_to, tags: { ns_auto: a.id, ns_sub: s.id } }, fetcher);
		if (!sent.ok) {
			if (sent.permanent) return "stop";
			throw new Error(sent.error ?? "Sending failed");
		}
		await logEvent(db, b.id, "automation.sent", s.id, null, `${a.name}: ${step.subject}`).run();
		return "next";
	}
	if (step.do === "add_list") {
		if (s.suppressed) return "next";
		// The same rules as an import: never put back someone who unsubscribed.
		const left = await db.prepare("SELECT 1 FROM memberships WHERE subscriber_id = ? AND status = 'unsubscribed' AND (? = 'all' OR list_id = ?) LIMIT 1").bind(s.id, b.unsub_scope, step.list).first();
		if (!left) await db.prepare("INSERT INTO memberships (list_id, subscriber_id, status, source, created_at, confirmed_at) SELECT ?, ?, 'active', 'automation', ?, ? WHERE EXISTS (SELECT 1 FROM lists WHERE id = ? AND brand_id = ?) ON CONFLICT (list_id, subscriber_id) DO NOTHING").bind(step.list, s.id, now, now, step.list, b.id).run();
		return "next";
	}
	if (step.do === "remove_list") {
		await db.prepare("UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE list_id = ? AND subscriber_id = ? AND status != 'unsubscribed'").bind(now, step.list, s.id).run();
		return "next";
	}
	if (step.do === "tag") {
		await db.prepare("UPDATE subscribers SET tags = json_insert(tags, '$[#]', ?) WHERE id = ? AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)").bind(step.tag, s.id, step.tag).run();
		return "next";
	}
	if (step.do === "notify") {
		const owner = await db.prepare("SELECT email FROM accounts ORDER BY created_at LIMIT 1").first<{ email: string }>();
		const provider = await loadProvider(db, b);
		if (!owner || !provider) return "next";
		const line = `${s.name ? `${s.name} (${s.email})` : s.email} reached "${a.name}".`;
		const out = renderEmail(`Automation: ${a.name}`, `<p>${line.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`, { brandName: b.name, colour: b.colour, unsubscribeUrl: `${await origin(db)}/#automations`, track: null }, { email: owner.email });
		await sendOne(provider, b.from_name, b.from_email, { to: owner.email, subject: `${b.name}: ${a.name}`, text: line, html: out.html, headers: {} }, fetcher);
		return "next";
	}
	if (step.do === "webhook") {
		await fetcher(step.url!, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Newsletter Sender" }, body: JSON.stringify({ event: "automation", automation: a.name, email: s.email, name: s.name, at: now }) }).catch(() => null);
		return "next";
	}
	return "next";
}

export const newAutomationId = () => newId(8);
