// Client sign off: the agency writes a campaign, the client approves it in a read only view, and nothing can go out
// until they have.
//
// Switched on per brand (Settings, People). The agency presses Ask for sign off and picks who approves (client logins
// on that brand). The campaign is locked while it waits. Each approver gets an email with a link to the review page,
// where they can send themselves a test, then Approve or Ask for changes with a note. Any change after approval
// needs a fresh sign off: each decision is kept with a fingerprint of the exact version, so the server can tell.

import type { AddonContext } from "../addon.ts";
import type { AccountRow, BrandRow, CampaignRow, Env } from "../db.ts";
import { getMeta, iso, newId, setMeta } from "../db.ts";
import { bad, body, ok, str } from "../kit.ts";
import { oneOff } from "../public.ts";
import { appBase } from "./address.ts";
import { currentLook } from "./look.ts";

export type Kind = "asked" | "approved" | "changes" | "withdrawn";
export interface SignoffRow { id: string; campaign_id: string; brand_id: string; kind: Kind; account_id: string; note: string | null; version: string; approvers: string | null; send_at: string | null; at: string }

export const signoffOn = async (db: D1Database, brandId: string) => (await getMeta(db, `signoff:${brandId}`)) === "1";
export const setSignoff = (db: D1Database, brandId: string, on: boolean) => setMeta(db, `signoff:${brandId}`, on ? "1" : null);

/** A fingerprint of everything the client approves: who it's from, the subject lines, the email and who it goes to. */
export async function versionOf(c: Pick<CampaignRow, "subject" | "preheader" | "html" | "blocks" | "audience" | "from_name" | "from_email" | "reply_to" | "ab">): Promise<string> {
	const text = JSON.stringify([c.subject, c.preheader ?? null, c.html ?? c.blocks ?? null, c.audience, c.from_name ?? null, c.from_email ?? null, c.reply_to ?? null, c.ab ?? null]);
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where a campaign is up to, from its newest sign off row. */
export type State = "none" | "waiting" | "approved" | "changes" | "stale";
export function stateOf(last: Pick<SignoffRow, "kind" | "version"> | null, version: string): State {
	if (!last || last.kind === "withdrawn") return "none";
	if (last.kind === "asked") return "waiting";
	if (last.kind === "changes") return "changes";
	return last.version === version ? "approved" : "stale";
}

const latest = (db: D1Database, campaignId: string) => db.prepare("SELECT * FROM signoffs WHERE campaign_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").bind(campaignId).first<SignoffRow>();
const lastAsk = (db: D1Database, campaignId: string) => db.prepare("SELECT * FROM signoffs WHERE campaign_id = ? AND kind = 'asked' ORDER BY at DESC, rowid DESC LIMIT 1").bind(campaignId).first<SignoffRow>();

/** Why this campaign can't be sent or scheduled yet, or null. */
export async function needsSignoff(db: D1Database, brand: BrandRow, c: CampaignRow, action: string): Promise<string | null> {
	if (action === "resume" || !(await signoffOn(db, brand.id))) return null;
	const s = stateOf(await latest(db, c.id), await versionOf(c));
	if (s === "approved") return null;
	if (s === "waiting") return "This campaign is waiting for sign off. It can go once it's approved.";
	if (s === "stale") return "This campaign has changed since it was approved. Please ask for sign off again.";
	if (s === "changes") return "Changes were asked for. Make them, then ask for sign off again.";
	return "This brand needs the client's sign off before sending. Press Ask for sign off first.";
}

/** Why this campaign can't be changed now, or null. */
export async function lockedForEdit(db: D1Database, brand: BrandRow, c: CampaignRow): Promise<string | null> {
	if (!(await signoffOn(db, brand.id))) return null;
	const last = await latest(db, c.id);
	if (last?.kind === "asked") return "This campaign is waiting for sign off, so it's locked. Press Withdraw the request to change it.";
	if (c.status === "scheduled") return "Please unschedule it first. Changes need a fresh sign off.";
	return null;
}

/** Client logins that can approve this brand's campaigns. */
const approversFor = (db: D1Database, brandId: string) => db.prepare("SELECT id, email, name FROM accounts WHERE role = 'client' AND brand_id = ? AND password IS NOT NULL ORDER BY name, email").bind(brandId).all<{ id: string; email: string; name: string | null }>().then((r) => r.results);

async function tell(env: Env, brand: BrandRow, to: string, subject: string, paras: string[], button: { label: string; href: string }): Promise<boolean> {
	const look = await currentLook(env.DB);
	const from: BrandRow = look ? { ...brand, name: look.name, from_name: look.name, from_email: look.from_email || brand.from_email, colour: look.colour, logo: look.logo?.startsWith("/") ? new URL(look.logo, button.href).href : look.logo, footer: null } : brand;
	return oneOff(env, from, to, subject, paras, button).catch(() => false);
}

const who = (a: { name: string | null; email: string }) => a.name || a.email;

export async function signoffRoutes(x: AddonContext): Promise<Response | null> {
	const { request, env, url, path, method, me, brand } = x;
	const db = env.DB;

	// The brand's switch (the owner only: team.ts covers /api/signoff).
	if (path === "/api/signoff") {
		if (method === "POST") {
			const on = (await body(request)).on === true;
			await setSignoff(db, brand.id, on);
			return ok({ on });
		}
		return ok({ on: await signoffOn(db, brand.id), brand: brand.name, approvers: await approversFor(db, brand.id) });
	}
	// Everything waiting for this login's sign off (a client's list, and the owner's all brands view).
	if (path === "/api/signoffs/waiting" && method === "GET") {
		const { results } = await db.prepare(`SELECT s.campaign_id, s.approvers, s.at, c.name, c.subject, c.brand_id FROM signoffs s JOIN campaigns c ON c.id = s.campaign_id
			WHERE s.kind = 'asked' AND NOT EXISTS (SELECT 1 FROM signoffs t WHERE t.campaign_id = s.campaign_id AND (t.at > s.at OR (t.at = s.at AND t.rowid > s.rowid)))${me.role === "client" ? " AND c.brand_id = ?" : ""} ORDER BY s.at DESC LIMIT 100`)
			.bind(...(me.role === "client" ? [me.brand_id] : [])).all<any>();
		const mine = results.filter((r) => me.role !== "client" || JSON.parse(r.approvers || "[]").includes(me.id));
		return ok({ waiting: mine.map((r) => ({ id: r.campaign_id, name: r.name || r.subject, brand: r.brand_id, at: r.at })) });
	}

	const m = /^\/api\/campaigns\/([0-9a-f]{16})\/signoff(?:\/(ask|decide|withdraw))?$/.exec(path);
	if (!m) return null;
	const c = await db.prepare("SELECT * FROM campaigns WHERE id = ? AND brand_id = ?").bind(m[1], brand.id).first<CampaignRow>();
	if (!c) return bad("That email has gone.", 404);
	const version = await versionOf(c);
	const last = await latest(db, c.id);
	const state = stateOf(last, version);
	const ask = await lastAsk(db, c.id);
	const approverIds: string[] = ask ? JSON.parse(ask.approvers || "[]") : [];

	if (!m[2] && method === "GET") {
		const { results } = await db.prepare("SELECT s.kind, s.note, s.version, s.at, s.send_at, a.name, a.email FROM signoffs s LEFT JOIN accounts a ON a.id = s.account_id WHERE s.campaign_id = ? ORDER BY s.at DESC, s.rowid DESC LIMIT 50").bind(c.id).all<any>();
		const people = await approversFor(db, brand.id);
		return ok({
			on: await signoffOn(db, brand.id), state, version, sendAt: state === "waiting" ? last?.send_at ?? null : null,
			canDecide: state === "waiting" && approverIds.includes(me.id),
			approvers: people, waitingOn: state === "waiting" ? people.filter((p) => approverIds.includes(p.id)).map(who) : [],
			history: results.map((r) => ({ kind: r.kind, note: r.note, at: r.at, by: r.name || r.email || "Someone who's since been removed", version: r.version, sameVersion: r.version === version })),
		});
	}
	if (method !== "POST") return bad("Not found.", 404);
	const b = await body(request);

	if (m[2] === "ask") {
		if (!(await signoffOn(db, brand.id))) return bad("Sign off isn't switched on for this brand.");
		if (c.status !== "draft") return bad(c.status === "scheduled" ? "Please unschedule it first." : "This campaign has already gone.");
		if (state === "waiting") return bad("This campaign is already waiting for sign off.");
		const people = await approversFor(db, brand.id);
		const chosen = (Array.isArray(b.approvers) ? b.approvers : []).map(String).filter((id: string) => people.some((p) => p.id === id));
		if (!chosen.length) return bad(people.length ? "Please choose who approves it." : "Nobody can approve it yet. Invite your client under Settings, People first.");
		let sendAt: string | null = null;
		if (b.send_at) {
			const at = new Date(String(b.send_at));
			if (isNaN(at.getTime()) || at.getTime() < Date.now() + 5 * 60_000) return bad("Please choose a send time at least five minutes from now, or leave it empty.");
			sendAt = iso(at);
		}
		const note = str(b.note, 1000) || null;
		await db.prepare("INSERT INTO signoffs (id, campaign_id, brand_id, kind, account_id, note, version, approvers, send_at, at) VALUES (?, ?, ?, 'asked', ?, ?, ?, ?, ?, ?)")
			.bind(newId(8), c.id, brand.id, me.id, note, version, JSON.stringify(chosen), sendAt, iso()).run();
		const link = `${await appBase(db, url)}/#review/${c.id}`;
		let emailed = 0;
		for (const p of people.filter((p) => chosen.includes(p.id))) {
			if (await tell(env, brand, p.email, `Please approve: ${c.subject}`, [`Hello${p.name ? ` ${p.name}` : ""},`, `${who(me)} would like you to look at "${c.name || c.subject}" for ${brand.name} before it goes out.${note ? `\n\n${note}` : ""}`, "You can read it, send yourself a test, then approve it or ask for changes."], { label: "Review it", href: link })) emailed++;
		}
		return ok({ ok: true, emailed, link });
	}
	if (m[2] === "withdraw") {
		if (me.role === "client" && !(await canWrite(me))) return bad("Only the agency can withdraw a request.", 403);
		if (state !== "waiting") return bad("This campaign isn't waiting for sign off.");
		await db.prepare("INSERT INTO signoffs (id, campaign_id, brand_id, kind, account_id, note, version, approvers, send_at, at) VALUES (?, ?, ?, 'withdrawn', ?, NULL, ?, NULL, NULL, ?)").bind(newId(8), c.id, brand.id, me.id, version, iso()).run();
		return ok();
	}
	if (m[2] === "decide") {
		if (state !== "waiting") return bad("This campaign isn't waiting for sign off any more.");
		if (!approverIds.includes(me.id)) return bad("You weren't asked to approve this one.", 403);
		if (ask && ask.version !== version) return bad("This campaign changed after sign off was asked for. Please ask the agency to send it again.");
		const approve = b.approve === true;
		const note = str(b.note, 1000) || null;
		if (!approve && !note) return bad("Please say what you'd like changed.");
		const now = iso();
		await db.prepare("INSERT INTO signoffs (id, campaign_id, brand_id, kind, account_id, note, version, approvers, send_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)").bind(newId(8), c.id, brand.id, approve ? "approved" : "changes", me.id, note, version, now).run();
		// Approved with a send time already chosen: schedule it (if that time is still ahead).
		let scheduled: string | null = null;
		if (approve && ask?.send_at && Date.parse(ask.send_at) > Date.now() + 60_000) {
			await db.prepare("UPDATE campaigns SET status = 'scheduled', send_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'").bind(ask.send_at, now, c.id).run();
			scheduled = ask.send_at;
		}
		// Tell whoever asked (and the owner).
		const asker = ask ? await db.prepare("SELECT email, name FROM accounts WHERE id = ?").bind(ask.account_id).first<{ email: string; name: string | null }>() : null;
		const owners = (await db.prepare("SELECT email, name FROM accounts WHERE role = 'owner'").all<{ email: string; name: string | null }>()).results;
		const to = [...new Set([asker?.email, ...owners.map((o) => o.email)].filter((e): e is string => Boolean(e)))];
		const link = `${await appBase(db, url)}/#email/${c.id}`;
		const line = approve ? `${who(me)} approved "${c.name || c.subject}" for ${brand.name}.${scheduled ? ` It's scheduled for ${new Date(scheduled).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" })} (UK time).` : " You can send it now."}` : `${who(me)} asked for changes to "${c.name || c.subject}" for ${brand.name}.`;
		for (const e of to) await tell(env, brand, e, approve ? `Approved: ${c.subject}` : `Changes asked for: ${c.subject}`, [line, ...(note ? [`Their note: ${note}`] : [])], { label: "Open the campaign", href: link });
		return ok({ ok: true, scheduled });
	}
	return null;
}

/** A client who can do more than review (they wrote or can send the campaign). */
async function canWrite(me: AccountRow): Promise<boolean> {
	try {
		return !JSON.parse(me.limits ?? "{}").review;
	} catch {
		return true;
	}
}
