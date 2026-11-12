// The agency edition's routes: more brands, every brand at a glance, client logins and the licence key.

import type { AddonContext } from "../addon.ts";
import { hashPassword, passwordProblem, sessionCookie } from "../auth.ts";
import { sesAccount } from "../aws.ts";
import { cleanEmail } from "../csv.ts";
import { getMeta, iso, newId, type AccountRow, type Env } from "../db.ts";
import { brandHealth } from "../health.ts";
import { bad, body, freeSlug, ok, str } from "../kit.ts";
import { sesKeys } from "../providers.ts";
import { loadProvider } from "../settings.ts";
import { askLicence, checkLicence, covers, currentLicence, GRACE_DAYS, licenceStatus, notCovered, renewedKey, renewUrl, saveLicence } from "./licence.ts";
import { VERSION } from "../update.ts";
import { brandCookie, canOf, cleanCan, CLIENT_START } from "./team.ts";

const INVITE_DAYS = 14;

/** A client's invite link: choose a password and you're in. Works before signing in. */
export async function openRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (url.pathname !== "/api/invite") return null;
	const db = env.DB;
	const method = request.method;
	if (!(await currentLicence(db))) return bad("Client logins need the agency edition's licence. Please ask the owner.", 403);
	const token = method === "POST" ? String((await body(request.clone())).token ?? "") : String(url.searchParams.get("token") ?? "");
	const a = /^[0-9a-f]{32}$/.test(token) ? await db.prepare("SELECT * FROM accounts WHERE reset_token = ? AND reset_until > ?").bind(token, iso()).first<AccountRow>() : null;
	if (!a) return bad("That invite link has run out or has been used. Please ask for a new one.", 404);
	const b0 = a.brand_id ? await db.prepare("SELECT name FROM brands WHERE id = ?").bind(a.brand_id).first<{ name: string }>() : null;
	if (method !== "POST") return ok({ email: a.email, brand: b0?.name ?? "", name: a.name });
	const b = await body(request);
	const problem = passwordProblem(b.password);
	if (problem) return bad(problem);
	await db.prepare("UPDATE accounts SET password = ?, name = COALESCE(?, name), reset_token = NULL, reset_until = NULL, session_ver = session_ver + 1 WHERE id = ?").bind(await hashPassword(b.password), str(b.name, 80) || null, a.id).run();
	const fresh = (await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(a.id).first<AccountRow>())!;
	return ok({ ok: true }, { headers: { "set-cookie": await sessionCookie(db, fresh, url.protocol === "https:") } });
}

export async function agencyRoutes(x: AddonContext): Promise<Response | null> {
	const { request, env, url, path, method, secure, me, brands, brand } = x;
	const db = env.DB;

	// -- The licence key (the owner only: team.ts) ----------------------------------------------------
	if (path === "/api/licence" && method === "GET") {
		let l = await currentLicence(db);
		const count = (await db.prepare("SELECT COUNT(*) AS n FROM brands").first<{ n: number }>())?.n ?? 0;
		// Why a saved key isn't working: cancelled, or newslettersender.com not reached for GRACE_DAYS.
		// Or this version came out after the licence's updates ended.
		const saved = await getMeta(db, "agency_licence");
		let c = saved && !l ? await checkLicence(saved) : null;
		// Not covered: ask newslettersender.com now, in case they've just renewed (the answer carries the new key).
		if (c?.ok && !covers(c.licence)) {
			const a = await askLicence(c.licence.id, VERSION);
			if (a?.key && (await renewedKey(db, c.licence, a.key))) {
				l = await currentLicence(db);
				c = null;
			}
		}
		const s = saved && !l && c ? await licenceStatus(db) : null;
		const problem = c?.ok && !covers(c.licence) ? notCovered(c.licence) : !s ? null : s.status === "cancelled" ? s.message || "This licence has been cancelled. Email hello@newslettersender.com if you think that's a mistake." : `We couldn't check your licence with newslettersender.com for ${GRACE_DAYS} days, so the agency features are paused. They come back as soon as the check works again.`;
		return ok({ licence: l && { to: l.to, id: l.id, brands: l.brands, until: l.until, updates: l.updates }, brands: count, problem, renew: renewUrl(l?.id ?? (c?.ok ? c.licence.id : "")), today: new Date().toISOString().slice(0, 10) });
	}
	if (path === "/api/licence" && method === "POST") {
		const key = (await body(request)).key;
		if (key === null || key === "") {
			await saveLicence(db, null);
			return ok();
		}
		const c = await checkLicence(key);
		if (!c.ok) return bad(c.error);
		const answer = await askLicence(c.licence.id, VERSION);
		if (answer?.status === "cancelled") return bad(answer.message || "That licence has been cancelled. Email hello@newslettersender.com if you think that's a mistake.");
		await saveLicence(db, String(key).replace(/\s+/g, ""), answer);
		return ok({ to: c.licence.to, covered: covers(c.licence) });
	}

	const licence = await currentLicence(db);
	// Who's signed in, which brands they can open, and the licence (for the brand picker and Settings).
	if (path === "/api/brands" && method === "GET") {
		return ok({ brands: brands.map((b) => ({ id: b.id, name: b.name })), current: brand.id, role: me.role, can: canOf(me), me: { name: me.name, email: me.email }, edition: "agency", licence: licence && { to: licence.to, brands: licence.brands, until: licence.until, updates: licence.updates } });
	}
	if (!licence) return null; // the free edition: none of the routes below

	// -- Brands -----------------------------------------------------------------------------------------
	if (path === "/api/brands" && method === "POST") {
		const name = str((await body(request)).name, 80);
		if (!name) return bad("Please give the brand a name.");
		if (licence.brands && brands.length >= licence.brands) return bad(`Your licence is for ${licence.brands} brands, and you have ${brands.length}. Get in touch to add more.`);
		const id = newId(8);
		const now = iso();
		await db.batch([
			db.prepare("INSERT INTO brands (id, name, from_name, from_email, hook_key, unsub_scope, created_at) VALUES (?, ?, ?, ?, ?, 'list', ?)").bind(id, name, name, me.email, newId(16), now),
			db.prepare("INSERT INTO lists (id, brand_id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(8), id, "Newsletter", await freeSlug(db, name), null, now),
		]);
		return ok({ id }, { headers: { "set-cookie": brandCookie(id, secure) } });
	}
	// Every brand at a glance: the first page the owner sees when there's more than one.
	if (path === "/api/brands/overview" && method === "GET") {
		if (me.role !== "owner") return bad("Only the owner can do that.", 403);
		const month = iso(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)));
		const { results: clients } = await db.prepare("SELECT brand_id, limits FROM accounts WHERE role = 'client'").all<{ brand_id: string; limits: string | null }>();
		const accounts = new Map<string, Promise<unknown>>();
		const rows = await Promise.all(brands.map(async (b) => {
			const [subs, sent, last, live] = await db.batch([
				db.prepare("SELECT COUNT(DISTINCT s.id) AS n FROM subscribers s JOIN memberships m ON m.subscriber_id = s.id WHERE s.brand_id = ? AND s.suppressed IS NULL AND m.status = 'active'").bind(b.id),
				db.prepare("SELECT COUNT(*) AS n FROM sends x JOIN campaigns c ON c.id = x.campaign_id WHERE c.brand_id = ? AND x.status = 'sent' AND x.sent_at >= ?").bind(b.id, month),
				db.prepare("SELECT id, name, subject, status, finished_at, started_at FROM campaigns WHERE brand_id = ? AND status IN ('sent', 'sending', 'paused') ORDER BY started_at DESC LIMIT 1").bind(b.id),
				db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE brand_id = ? AND status = 'sending'").bind(b.id),
			]);
			const lc = (last.results[0] as any) ?? null;
			let opened: number | null = null;
			if (lc && b.track_opens) {
				const o = await db.prepare("SELECT COUNT(*) AS sent, COUNT(opened_at) AS opened FROM sends WHERE campaign_id = ? AND status = 'sent'").bind(lc.id).first<{ sent: number; opened: number }>();
				opened = o?.sent ? o.opened / o.sent : null;
			}
			const p = await loadProvider(db, b);
			// One look at each Amazon SES account, however many brands share it.
			let account: string | null = null;
			if (p?.provider === "ses") {
				const k = sesKeys(p);
				account = `${k.accessKeyId}:${k.region}`; // kept on the server: only the region goes to the page
				if (!accounts.has(account)) accounts.set(account, sesAccount(k).catch((e) => ({ error: (e as Error).message })));
			}
			const limits = clients.filter((c) => c.brand_id === b.id).map((c) => canOf({ role: "client", limits: c.limits }).month_limit).filter((n) => n > 0);
			const health = await brandHealth(db, b.id);
			return {
				id: b.id, name: b.name, logo: b.logo, colour: b.colour, provider: p?.provider ?? null, account,
				subscribers: (subs.results[0] as any)?.n ?? 0, sentMonth: (sent.results[0] as any)?.n ?? 0, limit: limits.length ? Math.min(...limits) : 0,
				sending: ((live.results[0] as any)?.n ?? 0) > 0, last: lc && { id: lc.id, name: lc.name || lc.subject, status: lc.status, at: lc.finished_at || lc.started_at }, opened,
				health: health.bounceLevel === "bad" || health.complaintLevel === "bad" ? "bad" : health.bounceLevel === "ok" || health.complaintLevel === "ok" || health.paused.length ? "ok" : "good",
			};
		}));
		const seen = [...accounts.entries()];
		const acct = await Promise.all(seen.map(([, v]) => v));
		const services = seen.map(([key], i) => {
			const users = rows.filter((r) => r.account === key);
			const p = key.split(":")[1] || null;
			return { region: p, brands: users.map((u) => u.name), ses: acct[i] };
		});
		return ok({ brands: rows.map(({ account, ...r }) => ({ ...r, service: account ? seen.findIndex(([k]) => k === account) : null })), services, current: brand.id });
	}
	if (path === "/api/brands/switch" && method === "POST") {
		const id = String((await body(request)).id ?? "");
		if (!brands.some((b) => b.id === id)) return bad("You can't open that brand.", 403);
		return ok({ ok: true }, { headers: { "set-cookie": brandCookie(id, secure) } });
	}

	// -- People: client logins (the owner only: team.ts) ---------------------------------------------------
	if (path === "/api/people" && method === "GET") {
		const { results } = await db.prepare("SELECT a.id, a.email, a.name, a.role, a.brand_id, a.limits, a.created_at, a.password IS NOT NULL AS joined, b.name AS brand FROM accounts a LEFT JOIN brands b ON b.id = a.brand_id ORDER BY a.role DESC, a.created_at").all<any>();
		return ok({ people: results.map((p) => ({ ...p, joined: Boolean(p.joined), can: canOf(p), limits: undefined })), brands: brands.map((b) => ({ id: b.id, name: b.name })), start: CLIENT_START });
	}
	if (path === "/api/people" && method === "POST") {
		const b = await body(request);
		const email = cleanEmail(b.email);
		if (!email) return bad("Please enter their email address.");
		if (!brands.some((x) => x.id === b.brand)) return bad("Please choose their brand.");
		if (await db.prepare("SELECT 1 FROM accounts WHERE email = ?").bind(email).first()) return bad("Someone with that email address already has a login.");
		const token = newId(16);
		await db.prepare("INSERT INTO accounts (id, email, name, password, role, brand_id, limits, reset_token, reset_until, created_at) VALUES (?, ?, ?, NULL, 'client', ?, ?, ?, ?, ?)")
			.bind(newId(8), email, str(b.name, 80) || null, b.brand, JSON.stringify(cleanCan(b.can)), token, iso(new Date(Date.now() + INVITE_DAYS * 86_400_000)), iso()).run();
		return ok({ link: `${url.origin}/#invite/${token}` });
	}
	const pp = /^\/api\/people\/([0-9a-f]{16})(\/link)?$/.exec(path);
	if (pp) {
		const p = await db.prepare("SELECT * FROM accounts WHERE id = ? AND role = 'client'").bind(pp[1]).first<AccountRow>();
		if (!p) return bad("That login has gone.", 404);
		if (pp[2] && method === "POST") {
			const token = newId(16);
			await db.prepare("UPDATE accounts SET reset_token = ?, reset_until = ? WHERE id = ?").bind(token, iso(new Date(Date.now() + INVITE_DAYS * 86_400_000)), p.id).run();
			return ok({ link: `${url.origin}/#invite/${token}` });
		}
		if (!pp[2] && method === "POST") {
			const b = await body(request);
			const brandId = brands.some((x) => x.id === b.brand) ? b.brand : p.brand_id;
			await db.prepare("UPDATE accounts SET limits = ?, brand_id = ?, name = COALESCE(?, name) WHERE id = ?").bind(JSON.stringify(cleanCan(b.can)), brandId, str(b.name, 80) || null, p.id).run();
			return ok();
		}
		if (!pp[2] && method === "DELETE") {
			await db.prepare("DELETE FROM accounts WHERE id = ?").bind(p.id).run();
			return ok();
		}
	}
	return null;
}
