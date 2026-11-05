// The dashboard's JSON. Everything here needs the owner signed in, apart from set-up and sign in.

import { checkPassword, clearCookie, clearFailures, currentAccount, hashPassword, noteFailure, passwordProblem, sessionCookie, setupCodeMatches, setupTokenOk, signOutEverywhere, tooManyTries } from "./auth.ts";
import { cleanEmail, cleanTag, csvLine, fieldKey } from "./csv.ts";
import { firstBrand, iso, logEvent, newId, origin, type AccountRow, type BrandRow, type CampaignRow, type Env, type ListRow } from "./db.ts";
import { isProvider, parseProvider, providerSummary, sendOne, sesKeys } from "./providers.ts";
import { formHtml, oneOff, signUp } from "./public.ts";
import { blocksToHtml, cleanBlocks, renderEmail, sanitise, slugify } from "./render.ts";
import { audienceCount, campaignContent, DEFAULT_RATE, parseAudience, pause, resume, safeJson, sendTest, sendTime, start } from "./sending.ts";
import { canSendFrom, loadProvider, saveProvider, sesRecords, sesSetup, sesStatus, setUpSes } from "./settings.ts";
import { sesAccount } from "./aws.ts";
import { brandHealth } from "./health.ts";
import { cleanSteps, cleanTrigger, newAutomationId } from "./automations.ts";
import { dnsHost, findZone, TOKEN_URL } from "./cloudflare.ts";
import { ROBOT_ERROR, turnstileKey, turnstileOk } from "./turnstile.ts";

const DEFAULT_BRAND = "My newsletter";

const ok = (data: unknown = { ok: true }, init: ResponseInit = {}) => Response.json(data, { ...init, headers: { "cache-control": "no-store", ...(init.headers ?? {}) } });
const bad = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const multi = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");

async function body(request: Request): Promise<Record<string, any>> {
	try {
		return ((await request.json()) as Record<string, any>) ?? {};
	} catch {
		return {};
	}
}

/** A list's web address part: unique across the install. */
async function freeSlug(db: D1Database, want: string, self?: string): Promise<string> {
	const base = slugify(want).slice(0, 40);
	for (let i = 0; i < 50; i++) {
		const s = i ? `${base}-${i + 1}` : base;
		const hit = await db.prepare("SELECT id FROM lists WHERE slug = ?").bind(s).first<{ id: string }>();
		if (!hit || hit.id === self) return s;
	}
	return `${base}-${newId(3)}`;
}

function cleanFields(x: unknown) {
	if (!Array.isArray(x)) return [];
	return x.slice(0, 10).map((f: any) => ({ key: fieldKey(String(f?.label ?? f?.key ?? "")), label: str(f?.label, 60), required: Boolean(f?.required) })).filter((f) => f.key && f.label && !["email", "name"].includes(f.key));
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
	const db = env.DB;
	const path = url.pathname;
	const method = request.method;
	const secure = url.protocol === "https:";

	// -- Set-up and sign in --------------------------------------------------------------
	if (path === "/api/state") {
		const owner = await db.prepare("SELECT id FROM accounts LIMIT 1").first();
		const me = await currentAccount(request, db);
		return ok({ setUp: Boolean(owner), setupTokenOk: setupTokenOk(env.SETUP_TOKEN), signedIn: Boolean(me), turnstile: turnstileKey(env) });
	}
	if (path === "/api/setup" && method === "POST") {
		const b = await body(request);
		if (!setupCodeMatches(env.SETUP_TOKEN, b.code)) return bad("That set-up link isn't right. Use the one from when you installed Newsletter Sender.", 403);
		if (!(await turnstileOk(env, request, b.ts))) return bad(ROBOT_ERROR);
		const email = cleanEmail(b.email);
		if (!email) return bad("Please enter your email address.");
		const problem = passwordProblem(b.password);
		if (problem) return bad(problem);
		const existing = await db.prepare("SELECT * FROM accounts LIMIT 1").first<AccountRow>();
		const now = iso();
		if (existing) {
			// The set-up link resets the owner's sign in (forgotten password).
			await db.prepare("UPDATE accounts SET email = ?, password = ?, session_ver = session_ver + 1 WHERE id = ?").bind(email, await hashPassword(b.password), existing.id).run();
		} else {
			await db.prepare("INSERT INTO accounts (id, email, name, password, role, created_at) VALUES (?, ?, ?, ?, 'owner', ?)").bind(newId(8), email, str(b.name, 80) || null, await hashPassword(b.password), now).run();
		}
		if (!(await firstBrand(db))) {
			// The company or newsletter name is chosen later, in Settings.
			const name = str(b.brand, 80) || DEFAULT_BRAND;
			const brandId = newId(8);
			await db.batch([
				db.prepare("INSERT INTO brands (id, name, from_name, from_email, hook_key, unsub_scope, created_at) VALUES (?, ?, ?, ?, ?, 'list', ?)").bind(brandId, name, str(b.name, 80) || name, email, newId(16), now),
				db.prepare("INSERT INTO lists (id, brand_id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(8), brandId, "Newsletter", await freeSlug(db, "newsletter"), null, now),
			]);
		}
		await origin(db, request);
		const a = (await db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first<AccountRow>())!;
		return ok({ ok: true }, { headers: { "set-cookie": await sessionCookie(db, a, secure) } });
	}
	if (path === "/api/signin" && method === "POST") {
		const b = await body(request);
		const email = cleanEmail(b.email) ?? "";
		if (await tooManyTries(db, email)) return bad("Too many wrong passwords. Please wait 15 minutes and try again.", 429);
		if (!(await turnstileOk(env, request, b.ts))) return bad(ROBOT_ERROR);
		const a = await db.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first<AccountRow>();
		if (!a?.password || typeof b.password !== "string" || !(await checkPassword(b.password, a.password))) {
			await noteFailure(db, email);
			return bad("That email and password don't match.", 401);
		}
		await clearFailures(db, email);
		return ok({ ok: true }, { headers: { "set-cookie": await sessionCookie(db, a, secure) } });
	}
	if (path === "/api/signout" && method === "POST") return ok({ ok: true }, { headers: { "set-cookie": clearCookie(secure) } });

	const me = await currentAccount(request, db);
	if (!me) return bad("Please sign in.", 401);
	// Only this app's own pages may change things.
	if (method !== "GET" && request.headers.get("origin") && request.headers.get("origin") !== url.origin) return bad("Not allowed from another website.", 403);
	const brand = await firstBrand(db);
	if (!brand) return bad("Please finish setting up first.", 409);
	await origin(db, request);

	if (path === "/api/signout-everywhere" && method === "POST") {
		await signOutEverywhere(db, me.id);
		return ok({ ok: true }, { headers: { "set-cookie": clearCookie(secure) } });
	}

	// -- Overview -----------------------------------------------------------------------------
	if (path === "/api/overview") {
		const [subs, pending, gone, lists, last, events] = await db.batch([
			db.prepare("SELECT COUNT(DISTINCT s.id) AS n FROM subscribers s JOIN memberships m ON m.subscriber_id = s.id WHERE s.brand_id = ? AND s.suppressed IS NULL AND m.status = 'active'").bind(brand.id),
			db.prepare("SELECT COUNT(DISTINCT m.subscriber_id) AS n FROM memberships m JOIN lists l ON l.id = m.list_id WHERE l.brand_id = ? AND m.status = 'pending'").bind(brand.id),
			db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE brand_id = ? AND suppressed IS NOT NULL").bind(brand.id),
			db.prepare("SELECT COUNT(*) AS n FROM lists WHERE brand_id = ?").bind(brand.id),
			db.prepare("SELECT id, name, subject, status, total, started_at, finished_at FROM campaigns WHERE brand_id = ? AND status IN ('sending', 'sent', 'paused') ORDER BY started_at DESC LIMIT 1").bind(brand.id),
			db.prepare("SELECT e.at, e.kind, e.detail, s.email, c.subject FROM events e LEFT JOIN subscribers s ON s.id = e.subscriber_id LEFT JOIN campaigns c ON c.id = e.campaign_id WHERE e.brand_id = ? ORDER BY e.id DESC LIMIT 25").bind(brand.id),
		]);
		const lastCampaign = (last.results[0] as any) ?? null;
		const provider = await loadProvider(db, brand);
		const month = await db.prepare("SELECT COUNT(*) AS n FROM sends x JOIN campaigns c ON c.id = x.campaign_id WHERE c.brand_id = ? AND x.status = 'sent' AND x.sent_at >= ?").bind(brand.id, iso(new Date(Date.now() - 30 * 86_400_000))).first<{ n: number }>();
		return ok({
			name: me.name,
			brand: brand.name,
			named: brand.name !== DEFAULT_BRAND,
			subscribers: (subs.results[0] as any)?.n ?? 0,
			pending: (pending.results[0] as any)?.n ?? 0,
			suppressed: (gone.results[0] as any)?.n ?? 0,
			lists: (lists.results[0] as any)?.n ?? 0,
			sent30: month?.n ?? 0,
			last: lastCampaign ? { ...lastCampaign, stats: await campaignStats(db, lastCampaign.id) } : null,
			sending: providerSummary(provider),
			activity: events.results,
			archive: Boolean(brand.archive),
		});
	}

	// -- Brand ----------------------------------------------------------------------------------
	if (path === "/api/brand") {
		if (method === "POST") {
			// Each settings section saves its own part.
			const b = await body(request);
			const set: Record<string, unknown> = {};
			if ("name" in b) {
				const fromEmail = cleanEmail(b.from_email);
				if (!str(b.name, 80)) return bad("Please give your company or newsletter a name.");
				if (!fromEmail) return bad("Please enter the address your newsletter comes from, such as news@yourdomain.com.");
				const logo = typeof b.logo === "string" && /^https:\/\/\S{1,1000}$/.test(b.logo.trim()) ? b.logo.trim() : null;
				Object.assign(set, { name: str(b.name, 80), from_name: str(b.from_name, 80) || str(b.name, 80), from_email: fromEmail, reply_to: cleanEmail(b.reply_to), footer: multi(b.footer, 300) || null, colour: /^#[0-9a-f]{6}$/i.test(b.colour) ? b.colour : brand.colour, logo, archive: b.archive === false ? 0 : 1, app_name: str(b.app_name, 60) || null, footer_links: (b.manage_link === false ? 0 : 1) | (b.forward_link ? 2 : 0), done_email: b.done_email === false ? 0 : 1 });
			}
			if ("track_opens" in b) {
				let domain: string | null = null;
				if (typeof b.track_domain === "string" && b.track_domain.trim()) {
					const d = b.track_domain.trim().replace(/\/+$/, "");
					const u = /^https?:\/\//i.test(d) ? d : `https://${d}`;
					if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(u)) return bad("The tracking address should be a web address you've added to this Worker, such as news.yourdomain.com.");
					domain = u.toLowerCase();
				}
				Object.assign(set, { track_opens: b.track_opens ? 1 : 0, track_clicks: b.track_clicks ? 1 : 0, track_domain: domain });
			}
			if ("one_list" in b) Object.assign(set, { one_list: b.one_list ? 1 : 0, unsub_scope: b.unsub_scope === "list" ? "list" : "all" });
			const keys = Object.keys(set);
			if (keys.length) await db.prepare(`UPDATE brands SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => set[k]), brand.id).run();
			return ok();
		}
		return ok({ ...brand, provider: undefined, hook_key: undefined });
	}

	// -- Sending --------------------------------------------------------------------------------
	if (path === "/api/sending") {
		const provider = await loadProvider(db, brand);
		const base = await origin(db, request);
		if (method === "DELETE") {
			await saveProvider(db, brand.id, null, 1);
			return ok();
		}
		if (method === "POST") {
			const b = await body(request);
			const c = parseProvider(b, brand.from_email);
			if ("error" in c) return bad(c.error);
			let rate = Number(b.rate) > 0 ? Math.min(1000, Number(b.rate)) : DEFAULT_RATE[c.provider];
			if (c.provider === "ses") {
				const acct = await sesAccount(sesKeys(c));
				if ("error" in acct) return bad(acct.error);
				rate = acct.rate;
				if (provider?.provider === "ses" && provider.configSet) c.configSet = provider.configSet;
				if (provider?.provider === "ses" && provider.cfToken) c.cfToken = provider.cfToken;
			} else {
				// Check the key works with a real email to the owner before saving it.
				const r = await sendOne(c, brand.from_name, brand.from_email, { to: me.email, subject: "Newsletter Sender is connected", text: `This test came through ${c.provider}. Your newsletters will go out the same way.\n`, html: `<p>This test came through ${c.provider}. Your newsletters will go out the same way.</p>`, headers: {} });
				if (!r.ok) return bad(`The test email didn't go: ${r.error}`);
			}
			await saveProvider(db, brand.id, c, rate);
			return ok({ ok: true, rate });
		}
		const setup = await sesSetup(db, brand.id);
		return ok({
			sending: providerSummary(provider),
			rate: brand.rate,
			fromEmail: brand.from_email,
			hooks: Object.fromEntries(["ses", "postmark", "mailgun", "brevo", "resend"].map((p) => [p, `${base}/hooks/${p}/${brand.hook_key}`])),
			ses: setup ? { ...setup, records: sesRecords(setup.domain, setup.tokens, setup.region) } : null,
			cloudflareEmail: Boolean(env.EMAIL),
		});
	}
	// A Cloudflare token so we can add the Amazon SES DNS records ourselves.
	if (path === "/api/sending/dns-host") {
		const r = await dnsHost(brand.from_email.split("@")[1]);
		return "error" in r ? bad(r.error) : ok(r);
	}
	if (path === "/api/sending/cloudflare") {
		const p = await loadProvider(db, brand);
		if (p?.provider !== "ses") return bad("Please save your Amazon SES keys first.");
		if (method === "DELETE") {
			delete p.cfToken;
			await saveProvider(db, brand.id, p, brand.rate);
			return ok();
		}
		if (method === "POST") {
			const b = await body(request);
			const token = typeof b.token === "string" ? b.token.trim() : "";
			if (token.length < 20 || token.length > 200 || /\s/.test(token)) return bad("Please paste the whole Cloudflare token, with no spaces.");
			const domain = brand.from_email.split("@")[1] ?? "";
			const zone = await findZone(token, domain);
			if ("error" in zone) return bad(zone.error);
			await saveProvider(db, brand.id, { ...p, cfToken: token }, brand.rate);
			return ok({ zone: zone.name });
		}
		return ok({ tokenUrl: TOKEN_URL });
	}
	if (path === "/api/sending/ses-setup" && method === "POST") {
		const p = await loadProvider(db, brand);
		if (p?.provider !== "ses") return bad("Please save your Amazon SES keys first.");
		const r = await setUpSes(db, brand, p, request);
		return "error" in r ? bad(r.error) : ok(r);
	}
	if (path === "/api/health") {
		const h = await brandHealth(db, brand.id);
		const p = await loadProvider(db, brand);
		const acct = p?.provider === "ses" ? await sesAccount(sesKeys(p)).catch((e) => ({ error: (e as Error).message })) : null;
		return ok({ ...h, provider: p?.provider ?? null, region: p?.region ?? null, ses: acct });
	}
	if (path === "/api/sending/ses-status") {
		const p = await loadProvider(db, brand);
		if (p?.provider !== "ses") return bad("Amazon SES isn't connected.");
		const r = await sesStatus(p, brand.from_email.split("@")[1]);
		if (!("error" in r)) await db.prepare("UPDATE brands SET rate = ? WHERE id = ?").bind(r.rate, brand.id).run();
		return "error" in r ? bad(r.error) : ok(r);
	}
	if (path === "/api/sending/can-send" && method === "GET") {
		const email = cleanEmail(url.searchParams.get("email"));
		if (!email) return bad("Please enter a whole email address, such as news@yourdomain.com.");
		return ok(await canSendFrom(await loadProvider(db, brand), email));
	}
	if (path === "/api/sending/test" && method === "POST") {
		const b = await body(request);
		const to = cleanEmail(b.to) ?? me.email;
		const sent = await oneOff(env, brand, to, `A test from ${brand.name}`, ["This is a one off test email from Newsletter Sender.", "Sign up confirmations look like this."]);
		return sent ? ok() : bad("The test didn't go. Check the sending set-up.");
	}

	// -- Lists ------------------------------------------------------------------------------------
	if (path === "/api/lists") {
		if (method === "POST") {
			const b = await body(request);
			const name = str(b.name, 80);
			if (!name) return bad("Please give the list a name.");
			const thanks = typeof b.thanks_url === "string" && /^https:\/\/\S{1,500}$/.test(b.thanks_url.trim()) ? b.thanks_url.trim() : null;
			const fields = JSON.stringify(cleanFields(b.fields));
			const welcome = [str(b.welcome_subject, 150) || null, multi(b.welcome_text, 5000) || null];
			const mine = (await db.prepare("SELECT id FROM lists WHERE brand_id = ?").bind(brand.id).all<{ id: string }>()).results.map((r) => r.id);
			const also = JSON.stringify(Array.isArray(b.also_lists) ? [...new Set(b.also_lists.filter((x: unknown) => typeof x === "string" && mine.includes(x) && x !== b.id))] : []);
			if (b.id) {
				const l = await db.prepare("SELECT * FROM lists WHERE id = ? AND brand_id = ?").bind(b.id, brand.id).first<ListRow>();
				if (!l) return bad("That list has gone.", 404);
				await db.prepare("UPDATE lists SET name = ?, slug = ?, description = ?, fields = ?, double_optin = ?, welcome_subject = ?, welcome_text = ?, thanks_url = ?, also_lists = ? WHERE id = ?")
					.bind(name, b.slug ? await freeSlug(db, String(b.slug), l.id) : l.slug, multi(b.description, 500) || null, fields, b.double_optin === false ? 0 : 1, ...welcome, thanks, also, l.id).run();
				return ok({ id: l.id });
			}
			const id = newId(8);
			await db.prepare("INSERT INTO lists (id, brand_id, name, slug, description, fields, double_optin, welcome_subject, welcome_text, thanks_url, also_lists, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
				.bind(id, brand.id, name, await freeSlug(db, String(b.slug || name)), multi(b.description, 500) || null, fields, b.double_optin === false ? 0 : 1, ...welcome, thanks, also, iso()).run();
			return ok({ id });
		}
		const { results } = await db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM memberships m JOIN subscribers s ON s.id = m.subscriber_id WHERE m.list_id = l.id AND m.status = 'active' AND s.suppressed IS NULL) AS active,
			(SELECT COUNT(*) FROM memberships m WHERE m.list_id = l.id AND m.status = 'pending') AS pending,
			(SELECT COUNT(*) FROM memberships m WHERE m.list_id = l.id AND m.status = 'unsubscribed') AS left_count,
			(SELECT COUNT(*) FROM memberships m JOIN subscribers s ON s.id = m.subscriber_id WHERE m.list_id = l.id AND s.suppressed = 'bounced') AS bounced,
			(SELECT COUNT(*) FROM memberships m JOIN subscribers s ON s.id = m.subscriber_id WHERE m.list_id = l.id AND s.suppressed = 'complained') AS complained,
			(SELECT COUNT(*) FROM memberships m WHERE m.list_id = l.id) AS everyone FROM lists l WHERE l.brand_id = ? ORDER BY l.created_at`).bind(brand.id).all<ListRow & { active: number; pending: number; left_count: number }>();
		const base = await origin(db, request);
		const key = turnstileKey(env);
		return ok(results.map((l) => ({ ...l, fields: safeJson(l.fields) ?? [], also_lists: safeJson(l.also_lists) ?? [], url: `${base}/s/${l.slug}`, embed: formHtml(l, `${base}/s/${l.slug}`, key) })));
	}
	const ld = /^\/api\/lists\/([0-9a-f]{16})$/.exec(path);
	if (ld && method === "DELETE") {
		const n = await db.prepare("SELECT COUNT(*) AS n FROM lists WHERE brand_id = ?").bind(brand.id).first<{ n: number }>();
		if ((n?.n ?? 0) <= 1) return bad("You need at least one list.");
		await db.batch([
			db.prepare("DELETE FROM memberships WHERE list_id = ?").bind(ld[1]),
			db.prepare("DELETE FROM lists WHERE id = ? AND brand_id = ?").bind(ld[1], brand.id),
			db.prepare("UPDATE lists SET also_lists = COALESCE((SELECT json_group_array(value) FROM json_each(lists.also_lists) WHERE value != ?), '[]') WHERE brand_id = ?").bind(ld[1], brand.id),
		]);
		return ok();
	}

	// -- Subscribers -----------------------------------------------------------------------------
	if (path === "/api/subscribers" && method === "GET") {
		const list = url.searchParams.get("list") ?? "";
		const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
		const status = url.searchParams.get("status") ?? "active";
		const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
		const where: string[] = ["s.brand_id = ?"];
		const binds: unknown[] = [brand.id];
		if (q) {
			where.push("(s.email LIKE ? OR LOWER(s.name) LIKE ?)");
			binds.push(`%${q}%`, `%${q}%`);
		}
		if (list && !["active", "pending", "unsubscribed"].includes(status)) {
			where.push("EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.list_id = ?)");
			binds.push(list);
		}
		if (status === "bounced" || status === "complained") {
			where.push("s.suppressed = ?");
			binds.push(status);
		} else if (["active", "pending", "unsubscribed"].includes(status)) {
			where.push(`s.suppressed IS NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.status = ?${list ? " AND m.list_id = ?" : ""})`);
			binds.push(status, ...(list ? [list] : []));
		}
		const { results } = await db.prepare(`SELECT s.id, s.email, s.name, s.tags, s.suppressed, s.created_at, (SELECT GROUP_CONCAT(m.list_id || ':' || m.status) FROM memberships m WHERE m.subscriber_id = s.id) AS lists
			FROM subscribers s WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC LIMIT 51 OFFSET ?`).bind(...binds, page * 50).all<any>();
		return ok({ rows: results.slice(0, 50).map((r) => ({ ...r, tags: safeJson(r.tags) ?? [], lists: String(r.lists ?? "").split(",").filter(Boolean).map((x: string) => ({ id: x.split(":")[0], status: x.split(":")[1] })) })), more: results.length > 50 });
	}
	if (path === "/api/subscribers" && method === "POST") {
		const b = await body(request);
		const l = await db.prepare("SELECT * FROM lists WHERE id = ? AND brand_id = ?").bind(String(b.list ?? ""), brand.id).first<ListRow>();
		if (!l) return bad("Please choose a list.");
		const r = await signUp(env, l, brand, { email: b.email, name: b.name, fields: b.fields ?? {} }, "added by you", !b.confirm);
		if ("ok" in r && r.status === "blocked") return bad("That address is on your blocklist, so it can't be added. Take it off the blocklist first if you're sure.");
		return "error" in r ? bad(r.error) : ok(r);
	}
	const sd = /^\/api\/subscribers\/([0-9a-f]{16})(\/unsubscribe)?$/.exec(path);
	if (sd) {
		const s = await db.prepare("SELECT * FROM subscribers WHERE id = ? AND brand_id = ?").bind(sd[1], brand.id).first<any>();
		if (!s) return bad("That person has gone.", 404);
		if (sd[2] && method === "POST") {
			await db.prepare("UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE subscriber_id = ?").bind(iso(), s.id).run();
			await logEvent(db, brand.id, "unsubscribed", s.id, null, "by you").run();
			return ok();
		}
		if (method === "DELETE") {
			// Removes everything we hold about them (a right to be forgotten request).
			await db.batch([db.prepare("DELETE FROM memberships WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM sends WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM events WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM subscribers WHERE id = ?").bind(s.id)]);
			return ok();
		}
		if (method === "POST") {
			const b = await body(request);
			const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map(cleanTag).filter(Boolean))].slice(0, 30) : safeJson(s.tags) ?? [];
			await db.prepare("UPDATE subscribers SET name = ?, tags = ? WHERE id = ?").bind(str(b.name, 120) || null, JSON.stringify(tags), s.id).run();
			const notes: string[] = [];
			if (Array.isArray(b.removeLists)) for (const lid of b.removeLists) if (typeof lid === "string") await db.prepare("DELETE FROM memberships WHERE subscriber_id = ? AND list_id IN (SELECT id FROM lists WHERE id = ? AND brand_id = ?)").bind(s.id, lid, brand.id).run();
			if (Array.isArray(b.addLists)) for (const lid of b.addLists) {
				const l = await db.prepare("SELECT * FROM lists WHERE id = ? AND brand_id = ?").bind(lid, brand.id).first<ListRow>();
				if (!l) continue;
				const r = await signUp(env, l, brand, { email: s.email }, "added by you", true);
				if ("ok" in r && r.status === "elsewhere") notes.push(`Not added to ${l.name}: they're already on another list, and each person can only be on one list (Settings, Lists).`);
			}
			return ok({ ok: true, notes });
		}
		const { results: history } = await db.prepare("SELECT e.at, e.kind, e.detail, c.subject FROM events e LEFT JOIN campaigns c ON c.id = e.campaign_id WHERE e.subscriber_id = ? ORDER BY e.id DESC LIMIT 50").bind(s.id).all();
		const { results: lists } = await db.prepare("SELECT list_id AS id, status FROM memberships WHERE subscriber_id = ?").bind(s.id).all();
		return ok({ ...s, fields: safeJson(s.fields) ?? {}, tags: safeJson(s.tags) ?? [], token: undefined, history, lists });
	}

	// -- Import and export -------------------------------------------------------------------------
	if (path === "/api/import" && method === "POST") {
		const b = await body(request);
		if (!b.consent) return bad("Please confirm everyone on this list agreed to hear from you.");
		const l = await db.prepare("SELECT * FROM lists WHERE id = ? AND brand_id = ?").bind(String(b.list ?? ""), brand.id).first<ListRow>();
		if (!l) return bad("Please choose a list.");
		const rows = Array.isArray(b.rows) ? b.rows.slice(0, 1000) : [];
		const extraTags = Array.isArray(b.tags) ? b.tags.map(cleanTag).filter(Boolean) : [];
		const now = iso();
		let added = 0;
		let skipped = 0;
		const stmts: D1PreparedStatement[] = [];
		for (const r of rows) {
			const email = cleanEmail(r?.email);
			if (!email) {
				skipped++;
				continue;
			}
			const fields: Record<string, string> = {};
			for (const [k, v] of Object.entries(r.fields ?? {})) if (typeof v === "string" && fieldKey(k)) fields[fieldKey(k)] = v.slice(0, 500);
			const tags = [...new Set([...(Array.isArray(r.tags) ? r.tags.map(cleanTag) : []), ...extraTags].filter(Boolean))].slice(0, 20);
			const id = newId(8);
			stmts.push(
				db.prepare(`INSERT INTO subscribers (id, brand_id, email, name, fields, tags, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (brand_id, email) DO UPDATE SET name = COALESCE(excluded.name, subscribers.name), fields = json_patch(subscribers.fields, excluded.fields),
					tags = (SELECT json_group_array(DISTINCT value) FROM (SELECT value FROM json_each(subscribers.tags) UNION SELECT value FROM json_each(excluded.tags)))`)
					.bind(id, brand.id, email, str(r.name, 120) || null, JSON.stringify(fields), JSON.stringify(tags), newId(16), now),
				// Never re-add someone who unsubscribed (from any list, or this one when unsubscribing is per list), bounced or complained.
				// With one list per person, someone already on another list stays where they are.
				db.prepare(`INSERT INTO memberships (list_id, subscriber_id, status, source, created_at, confirmed_at)
					SELECT ?1, s.id, 'active', 'import', ?2, ?2 FROM subscribers s WHERE s.brand_id = ?3 AND s.email = ?4 AND s.suppressed IS NULL
					AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.status = 'unsubscribed' AND (?5 = 'all' OR m.list_id = ?1))
					AND NOT EXISTS (SELECT 1 FROM blocklist b WHERE b.brand_id = ?3 AND b.email = s.email) AND NOT EXISTS (SELECT 1 FROM blocked_domains d WHERE d.brand_id = ?3 AND d.domain = substr(s.email, instr(s.email, '@') + 1))
					AND NOT (?6 = 1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.list_id != ?1 AND m.status IN ('active', 'pending')))
					ON CONFLICT (list_id, subscriber_id) DO NOTHING`)
					.bind(l.id, now, brand.id, email, brand.unsub_scope, brand.one_list),
			);
			added++;
		}
		for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
		if (added) await logEvent(db, brand.id, "imported", null, null, `${added} into ${l.name}`).run();
		return ok({ added, skipped });
	}
	if (path === "/api/export") {
		const list = url.searchParams.get("list");
		const { results } = await db.prepare(`SELECT s.email, s.name, s.fields, s.tags, s.suppressed, s.created_at, m.status, m.confirmed_at FROM subscribers s JOIN memberships m ON m.subscriber_id = s.id
			JOIN lists l ON l.id = m.list_id WHERE l.brand_id = ? ${list ? "AND l.id = ?" : ""} ORDER BY s.created_at`).bind(brand.id, ...(list ? [list] : [])).all<any>();
		const keys = [...new Set(results.flatMap((r) => Object.keys(safeJson(r.fields) ?? {})))];
		const lines = [csvLine(["email", "name", "status", "joined", "confirmed", "tags", ...keys])];
		for (const r of results) {
			const f = safeJson(r.fields) ?? {};
			lines.push(csvLine([r.email, r.name, r.suppressed ?? r.status, r.created_at, r.confirmed_at, (safeJson(r.tags) ?? []).join(" "), ...keys.map((k) => f[k] ?? "")]));
		}
		return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="subscribers-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
	}
	if (path === "/api/tags") {
		const { results } = await db.prepare("SELECT t.value AS tag, COUNT(*) AS n FROM subscribers s, json_each(s.tags) t WHERE s.brand_id = ? GROUP BY t.value ORDER BY n DESC LIMIT 100").bind(brand.id).all();
		return ok(results);
	}

	// -- Campaigns ---------------------------------------------------------------------------------
	if (path === "/api/campaigns" && method === "GET") {
		const { results } = await db.prepare(`SELECT c.id, c.name, c.subject, c.status, c.send_at, c.started_at, c.finished_at, c.total, c.updated_at,
			(SELECT COUNT(*) FROM sends x WHERE x.campaign_id = c.id AND x.status = 'sent') AS sent,
			(SELECT COUNT(opened_at) FROM sends x WHERE x.campaign_id = c.id) AS opens,
			(SELECT COUNT(clicked_at) FROM sends x WHERE x.campaign_id = c.id) AS clicks
			FROM campaigns c WHERE c.brand_id = ? ORDER BY COALESCE(c.started_at, c.send_at, c.updated_at) DESC LIMIT 500`).bind(brand.id).all();
		return ok({ campaigns: results, tracking: { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) } });
	}
	if (path === "/api/campaigns" && method === "POST") {
		const b = await body(request);
		const id = newId(8);
		// With just one list, it's chosen already. With more, the owner picks.
		const { results: all } = await db.prepare("SELECT id FROM lists WHERE brand_id = ? LIMIT 2").bind(brand.id).all<{ id: string }>();
		// A new campaign starts blank, from a template, or from HTML the owner brought in (a file or a web page).
		let html = "<p>Hello {{first_name|there}},</p>\n<p>Write your newsletter here.</p>";
		if (typeof b.template === "string") {
			const t = await db.prepare("SELECT html FROM templates WHERE id = ? AND brand_id = ?").bind(b.template, brand.id).first<{ html: string }>();
			if (!t) return bad("That template has gone.");
			html = t.html;
		} else if (typeof b.html === "string" && b.html.trim()) html = sanitise(b.html.slice(0, 500_000));
		await db.prepare("INSERT INTO campaigns (id, brand_id, name, subject, preheader, blocks, html, audience, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)")
			.bind(id, brand.id, str(b.name, 120) || null, str(b.subject, 200) || "Untitled email", null, html, JSON.stringify({ lists: all.length === 1 ? [all[0].id] : [], tags: [] }), iso(), iso()).run();
		return ok({ id });
	}
	if (path === "/api/audience" && method === "POST") {
		const a = parseAudience(await body(request));
		const n = await audienceCount(db, brand.id, a);
		return ok({ count: n, time: sendTime(n, brand.rate) });
	}
	// The people behind each number in a report: download them, or add them to a list (to send again to people who didn't open, say).
	const pm = /^\/api\/campaigns\/([0-9a-f]{16})\/people$/.exec(path);
	if (pm) {
		const c = await db.prepare("SELECT id, name, subject FROM campaigns WHERE id = ? AND brand_id = ?").bind(pm[1], brand.id).first<{ id: string; name: string | null; subject: string }>();
		if (!c) return bad("That email has gone.", 404);
		const b = method === "POST" ? await body(request) : null;
		const who = String(b?.who ?? url.searchParams.get("who") ?? "");
		const n = Number(b?.n ?? url.searchParams.get("n") ?? 0);
		const pick = usesLink(reportPeople(who));
		if (!pick) return bad("Please choose who.");
		const sel = `SELECT x.subscriber_id FROM sends x WHERE x.campaign_id = ?1 AND ${pick}`;
		if (method === "POST") {
			const l = await db.prepare("SELECT id, name FROM lists WHERE id = ? AND brand_id = ?").bind(String(b?.list ?? ""), brand.id).first<{ id: string; name: string }>();
			if (!l) return bad("Please choose a list.");
			const now = iso();
			// The same rules as an import: never re-add people who unsubscribed, bounced, complained or are blocked.
			const r = await db.prepare(`INSERT INTO memberships (list_id, subscriber_id, status, source, created_at, confirmed_at)
				SELECT ?3, s.id, 'active', 'report', ?4, ?4 FROM subscribers s WHERE s.id IN (${sel}) AND s.brand_id = ?5 AND s.suppressed IS NULL
				AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.status = 'unsubscribed' AND (?6 = 'all' OR m.list_id = ?3))
				AND NOT EXISTS (SELECT 1 FROM blocklist bl WHERE bl.brand_id = ?5 AND bl.email = s.email) AND NOT EXISTS (SELECT 1 FROM blocked_domains d WHERE d.brand_id = ?5 AND d.domain = substr(s.email, instr(s.email, '@') + 1))
				AND NOT (?7 = 1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.list_id != ?3 AND m.status IN ('active', 'pending')))
				ON CONFLICT (list_id, subscriber_id) DO NOTHING`).bind(c.id, n, l.id, now, brand.id, brand.unsub_scope, brand.one_list).run();
			return ok({ added: r.meta.changes ?? 0, list: l.name });
		}
		const { results } = await db.prepare(`SELECT s.email, s.name, x.opened_at, x.clicked_at, x.opens, x.country FROM sends x JOIN subscribers s ON s.id = x.subscriber_id
			WHERE x.campaign_id = ?1 AND ${pick} ORDER BY s.email`).bind(c.id, n).all<any>();
		const lines = [csvLine(["email", "name", "opened", "clicked", "times opened", "country"])];
		for (const r of results) lines.push(csvLine([r.email, r.name, r.opened_at, r.clicked_at, r.opens, r.country]));
		const file = `${slugify(c.name || c.subject) || "campaign"}-${who}${who === "link" ? `-${n}` : ""}.csv`;
		return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file}"`, "cache-control": "no-store" } });
	}
	const cm = /^\/api\/campaigns\/([0-9a-f]{16})(?:\/(test|send|schedule|unschedule|cancel|pause|resume|duplicate|preview))?$/.exec(path);
	if (cm) {
		const c = await db.prepare("SELECT * FROM campaigns WHERE id = ? AND brand_id = ?").bind(cm[1], brand.id).first<CampaignRow>();
		if (!c) return bad("That email has gone.", 404);
		const action = cm[2];
		const editable = c.status === "draft" || c.status === "scheduled";
		if (!action && method === "GET") {
			const stats = await campaignStats(db, c.id);
			const links = brand.track_clicks ? (await db.prepare("SELECT l.n, l.url, l.clicks, (SELECT COUNT(*) FROM link_clicks k WHERE k.campaign_id = l.campaign_id AND k.n = l.n) AS people FROM links l WHERE l.campaign_id = ? ORDER BY people DESC, l.clicks DESC LIMIT 50").bind(c.id).all()).results : [];
			const countries = brand.track_opens || brand.track_clicks ? (await db.prepare("SELECT country, COUNT(*) AS n FROM sends WHERE campaign_id = ? AND country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 10").bind(c.id).all()).results : [];
			const paused = c.status === "paused" ? await db.prepare("SELECT detail FROM events WHERE campaign_id = ? AND kind = 'campaign.paused' ORDER BY id DESC LIMIT 1").bind(c.id).first<{ detail: string }>() : null;
			const base = await origin(db, request);
			return ok({ ...c, blocks: undefined, html: c.html ?? blocksToHtml(cleanBlocks(safeJson(c.blocks)), brand.colour), audience: parseAudience(c.audience), stats, links, countries, pausedWhy: paused?.detail ?? null, defaults: { from_name: brand.from_name, from_email: brand.from_email, reply_to: brand.reply_to }, tracking: { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) }, colour: brand.colour, webUrl: brand.archive && c.public && c.slug && !editable ? `${base}/archive/${c.slug}` : null });
		}
		if (!action && method === "POST") {
			if (!editable) return bad("This email has been sent, so it can't be changed. Duplicate it to make a new one.");
			const b = await body(request);
			const slug = b.slug ? slugify(String(b.slug)) : slugify(str(b.subject, 200));
			const clash = await db.prepare("SELECT id FROM campaigns WHERE slug = ? AND id != ?").bind(slug, c.id).first();
			const html = typeof b.html === "string" ? sanitise(b.html.slice(0, 500_000)) : c.html;
			// From name, address and Reply to: blank means "use Settings".
			const own = (v: string | null | undefined, d: string | null) => (v && v !== d ? v : null);
			await db.prepare("UPDATE campaigns SET from_name = ?, from_email = ?, reply_to = ? WHERE id = ?")
				.bind(own(str(b.from_name, 80), brand.from_name), own(cleanEmail(b.from_email), brand.from_email), own(cleanEmail(b.reply_to), brand.reply_to), c.id).run();
			await db.prepare("UPDATE campaigns SET name = ?, subject = ?, preheader = ?, html = ?, audience = ?, public = ?, slug = ?, updated_at = ? WHERE id = ?")
				.bind(str(b.name, 120) || null, str(b.subject, 200) || "Untitled email", str(b.preheader, 200) || null, html, JSON.stringify(parseAudience(b.audience)), b.public === false ? 0 : 1, clash ? `${slug}-${c.id.slice(0, 4)}` : slug, iso(), c.id).run();
			return ok();
		}
		if (!action && method === "DELETE") {
			if (c.status === "sending") return bad("This one is sending. Stop it first, then delete it.");
			await db.batch([db.prepare("DELETE FROM sends WHERE campaign_id = ?").bind(c.id), db.prepare("DELETE FROM links WHERE campaign_id = ?").bind(c.id), db.prepare("DELETE FROM campaigns WHERE id = ?").bind(c.id)]);
			return ok();
		}
		if (action === "preview") {
			const base = await origin(db, request);
			const out = renderEmail(c.subject, campaignContent(c), { brandName: brand.name, colour: brand.colour, logo: brand.logo, footer: brand.footer, preheader: c.preheader, unsubscribeUrl: `${base}/u/test`, manageUrl: `${base}/p/test`, forwardUrl: `${base}/f/test`, footerLinks: brand.footer_links, webUrl: null, track: null }, { email: me.email, name: me.name });
			return new Response(out.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": EMAIL_CSP } });
		}
		if (method !== "POST") return bad("Not found.", 404);
		const b = await body(request);
		if (action === "test") {
			const provider = await loadProvider(db, brand);
			if (!provider) return bad("Please choose how to send first, under Settings, Sending.");
			const to = (Array.isArray(b.to) ? b.to : String(b.to ?? me.email).split(/[,\s]+/)).map(cleanEmail).filter((e): e is string => !!e).slice(0, 5);
			if (!to.length) return bad("Please enter an address to send the test to.");
			const res = await sendTest(env, brand, provider, { subject: c.subject, preheader: c.preheader, content: campaignContent(c), from_name: c.from_name, from_email: c.from_email, reply_to: c.reply_to }, to, { email: me.email, name: me.name });
			const failed = res.find((r) => !r.ok);
			return failed ? bad(`The test didn't go: ${failed.error}`) : ok({ sent: to.length });
		}
		if (action === "send") {
			const r = await start(env, c, request);
			return "error" in r ? bad(r.error) : ok(r);
		}
		if (action === "schedule") {
			if (!editable) return bad("This email has already gone.");
			const at = new Date(String(b.at ?? ""));
			if (isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) return bad("Please choose a time at least a minute from now.");
			if (!(await loadProvider(db, brand))) return bad("Please choose how to send first, under Settings, Sending.");
			await db.prepare("UPDATE campaigns SET status = 'scheduled', send_at = ?, updated_at = ? WHERE id = ?").bind(iso(at), iso(), c.id).run();
			return ok();
		}
		if (action === "unschedule") {
			await db.prepare("UPDATE campaigns SET status = 'draft', send_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'").bind(iso(), c.id).run();
			return ok();
		}
		if (action === "cancel") {
			if (c.status !== "sending" && c.status !== "paused") return bad("Only an email that's sending can be stopped.");
			await db.batch([
				db.prepare("UPDATE campaigns SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").bind(iso(), iso(), c.id),
				db.prepare("UPDATE sends SET status = 'cancelled' WHERE campaign_id = ? AND status = 'queued'").bind(c.id),
			]);
			await logEvent(db, brand.id, "campaign.cancelled", null, c.id).run();
			return ok();
		}
		if (action === "pause") {
			if (c.status !== "sending") return bad("Only an email that's sending can be paused.");
			await pause(db, c, "You paused it. Carry on whenever you're ready.");
			return ok();
		}
		if (action === "resume") {
			const r = await resume(env, c);
			return "error" in r ? bad(r.error) : ok();
		}
		if (action === "duplicate") {
			const id = newId(8);
			await db.prepare("INSERT INTO campaigns (id, brand_id, name, subject, preheader, blocks, html, audience, from_name, from_email, reply_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, brand.id, `${c.name || c.subject} (copy)`, c.subject, c.preheader, c.blocks, c.html, c.audience, c.from_name ?? null, c.from_email ?? null, c.reply_to ?? null, iso(), iso()).run();
			return ok({ id });
		}
	}

	// -- Bringing in a design from a web page --------------------------------------------------------
	if (path === "/api/fetch-html" && method === "POST") {
		const b = await body(request);
		let u: URL;
		try {
			u = new URL(String(b.url ?? "").trim());
		} catch {
			return bad("Please enter the full web address, starting https://");
		}
		if (u.protocol !== "https:" && u.protocol !== "http:") return bad("Please enter the full web address, starting https://");
		const r = await fetch(u.toString(), { headers: { accept: "text/html" }, redirect: "follow" }).catch(() => null);
		if (!r || !r.ok) return bad(`We couldn't open that page${r ? ` (it answered ${r.status})` : ""}.`);
		if (!/html|text\/plain/i.test(r.headers.get("content-type") ?? "")) return bad("That address isn't a web page.");
		const text = (await r.text()).slice(0, 500_000);
		// Make the page's own short picture and link addresses work in an email.
		const fixed = text.replace(/\b(src|href)\s*=\s*(["'])(?!https?:|mailto:|data:|#|\{\{)([^"']+)\2/gi, (_m, a: string, q: string, v: string) => {
			try {
				return `${a}=${q}${new URL(v, u).toString()}${q}`;
			} catch {
				return _m;
			}
		});
		return ok({ html: sanitise(fixed), title: /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text)?.[1]?.trim() ?? "" });
	}

	// -- Automations ------------------------------------------------------------------------------------
	if (path === "/api/automations" && method === "GET") {
		const { results } = await db.prepare(`SELECT a.id, a.name, a.trigger, a.steps, a.enabled, a.updated_at,
			(SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'waiting') AS waiting,
			(SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'done') AS finished,
			(SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id) AS started
			FROM automations a WHERE a.brand_id = ? ORDER BY a.created_at DESC`).bind(brand.id).all<any>();
		return ok(results.map((a) => ({ ...a, trigger: cleanTrigger(safeJson(a.trigger)), steps: cleanSteps(safeJson(a.steps)), enabled: Boolean(a.enabled) })));
	}
	if (path === "/api/automations" && method === "POST") {
		const b = await body(request);
		const id = newAutomationId();
		await db.prepare("INSERT INTO automations (id, brand_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, brand.id, str(b.name, 120) || "New automation", iso(), iso()).run();
		return ok({ id });
	}
	const am = /^\/api\/automations\/([0-9a-f]{16})$/.exec(path);
	if (am) {
		const a = await db.prepare("SELECT * FROM automations WHERE id = ? AND brand_id = ?").bind(am[1], brand.id).first<any>();
		if (!a) return bad("That automation has gone.", 404);
		if (method === "DELETE") {
			await db.batch([db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").bind(a.id), db.prepare("DELETE FROM automations WHERE id = ?").bind(a.id)]);
			return ok();
		}
		if (method === "POST") {
			const b = await body(request);
			const trigger = b.trigger === undefined ? cleanTrigger(safeJson(a.trigger)) : cleanTrigger(b.trigger);
			const steps = b.steps === undefined ? cleanSteps(safeJson(a.steps)) : cleanSteps(b.steps);
			const enabled = b.enabled === undefined ? Boolean(a.enabled) : Boolean(b.enabled);
			if (enabled && (!trigger || !steps.length)) return bad("Choose what starts it and add at least one step before switching it on.");
			if (enabled && trigger?.kind === "yearly" && !trigger.field) return bad("Choose the field that holds each person's date, like their birthday.");
			if (enabled && trigger?.kind === "date" && !trigger.date) return bad("Choose the day it should run.");
			await db.prepare("UPDATE automations SET name = ?, trigger = ?, steps = ?, enabled = ?, updated_at = ? WHERE id = ?")
				.bind(str(b.name, 120) || a.name, JSON.stringify(trigger ?? {}), JSON.stringify(steps), enabled ? 1 : 0, iso(), a.id).run();
			return ok({ trigger, steps, enabled });
		}
		const counts = (await db.prepare("SELECT step, status, COUNT(*) AS n FROM automation_runs WHERE automation_id = ? GROUP BY step, status").bind(a.id).all<{ step: number; status: string; n: number }>()).results;
		return ok({ id: a.id, name: a.name, trigger: cleanTrigger(safeJson(a.trigger)), steps: cleanSteps(safeJson(a.steps)), enabled: Boolean(a.enabled), counts });
	}

	// -- Templates -------------------------------------------------------------------------------------
	if (path === "/api/templates" && method === "GET") {
		const { results } = await db.prepare("SELECT id, name, created_at, updated_at FROM templates WHERE brand_id = ? ORDER BY updated_at DESC").bind(brand.id).all();
		return ok(results);
	}
	if (path === "/api/templates" && method === "POST") {
		const b = await body(request);
		const id = newId(8);
		let html = typeof b.html === "string" ? sanitise(b.html.slice(0, 500_000)) : "<p>Hello {{first_name|there}},</p>\n<p>Your words here.</p>";
		if (typeof b.from === "string") {
			const c = await db.prepare("SELECT * FROM campaigns WHERE id = ? AND brand_id = ?").bind(b.from, brand.id).first<CampaignRow>();
			if (c) html = c.html ?? blocksToHtml(cleanBlocks(safeJson(c.blocks)), brand.colour);
		}
		await db.prepare("INSERT INTO templates (id, brand_id, name, html, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, brand.id, str(b.name, 120) || "Untitled template", html, iso(), iso()).run();
		return ok({ id });
	}
	const tm = /^\/api\/templates\/([0-9a-f]{16})$/.exec(path);
	if (tm) {
		const t = await db.prepare("SELECT * FROM templates WHERE id = ? AND brand_id = ?").bind(tm[1], brand.id).first<any>();
		if (!t) return bad("That template has gone.", 404);
		if (method === "DELETE") {
			await db.prepare("DELETE FROM templates WHERE id = ?").bind(t.id).run();
			return ok();
		}
		if (method === "POST") {
			const b = await body(request);
			await db.prepare("UPDATE templates SET name = ?, html = ?, updated_at = ? WHERE id = ?").bind(str(b.name, 120) || "Untitled template", typeof b.html === "string" ? sanitise(b.html.slice(0, 500_000)) : t.html, iso(), t.id).run();
			return ok();
		}
		return ok({ ...t, colour: brand.colour });
	}
	const tp = /^\/api\/templates\/([0-9a-f]{16})\/preview$/.exec(path);
	if (tp) {
		const t = await db.prepare("SELECT * FROM templates WHERE id = ? AND brand_id = ?").bind(tp[1], brand.id).first<any>();
		if (!t) return bad("That template has gone.", 404);
		const out = renderEmail(t.name, t.html, { brandName: brand.name, colour: brand.colour, logo: brand.logo, footer: brand.footer, unsubscribeUrl: `${await origin(db, request)}/u/test`, webUrl: null, track: null }, { email: me.email, name: me.name });
		return new Response(out.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": EMAIL_CSP } });
	}

	// -- Blocklist -------------------------------------------------------------------------------------
	if (path === "/api/blocklist" && method === "GET") {
		const domains = url.searchParams.get("type") === "domains";
		const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
		const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
		const col = domains ? "domain" : "email";
		const table = domains ? "blocked_domains" : "blocklist";
		const [rows, counts] = await db.batch([
			db.prepare(`SELECT ${col} AS value, attempts, updated_at FROM ${table} WHERE brand_id = ? ${q ? `AND ${col} LIKE ?` : ""} ORDER BY updated_at DESC LIMIT 51 OFFSET ?`).bind(brand.id, ...(q ? [`%${q}%`] : []), page * 50),
			db.prepare("SELECT (SELECT COUNT(*) FROM blocklist WHERE brand_id = ?1) AS emails, (SELECT COUNT(*) FROM blocked_domains WHERE brand_id = ?1) AS domains").bind(brand.id),
		]);
		return ok({ rows: rows.results.slice(0, 50), more: rows.results.length > 50, counts: counts.results[0] });
	}
	if (path === "/api/blocklist" && method === "POST") {
		const b = await body(request);
		const domains = b.type === "domains";
		const items: string[] = (Array.isArray(b.items) ? b.items : String(b.items ?? "").split(/[\s,;]+/))
			.map((x: unknown) => String(x ?? "").trim().toLowerCase().replace(/^@/, ""))
			.filter((x: string) => (domains ? /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x) : !!cleanEmail(x)))
			.slice(0, 5000);
		if (b.remove) {
			if (b.all) await db.prepare(`DELETE FROM ${domains ? "blocked_domains" : "blocklist"} WHERE brand_id = ?`).bind(brand.id).run();
			else for (let i = 0; i < items.length; i += 100) await db.batch(items.slice(i, i + 100).map((x) => db.prepare(`DELETE FROM ${domains ? "blocked_domains" : "blocklist"} WHERE brand_id = ? AND ${domains ? "domain" : "email"} = ?`).bind(brand.id, x)));
			return ok();
		}
		if (!items.length) return bad(domains ? "Please enter at least one domain, such as example.com." : "Please enter at least one email address.");
		const now = iso();
		for (let i = 0; i < items.length; i += 100) await db.batch(items.slice(i, i + 100).map((x) => db.prepare(`INSERT INTO ${domains ? "blocked_domains (brand_id, domain" : "blocklist (brand_id, email"}, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(brand.id, x, now, now)));
		await logEvent(db, brand.id, "blocklist", null, null, `${items.length} ${domains ? "domains" : "addresses"} added`).run();
		return ok({ added: items.length });
	}
	if (path === "/api/blocklist/export") {
		const domains = url.searchParams.get("type") === "domains";
		const { results } = await db.prepare(`SELECT ${domains ? "domain" : "email"} AS value, attempts, created_at FROM ${domains ? "blocked_domains" : "blocklist"} WHERE brand_id = ? ORDER BY value`).bind(brand.id).all<any>();
		const lines = [csvLine([domains ? "domain" : "email", "block_attempts", "added"]), ...results.map((r) => csvLine([r.value, String(r.attempts), r.created_at]))];
		return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="blocklist-${domains ? "domains-" : ""}${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
	}

	// -- A list's subscribers, many at once ---------------------------------------------------------------
	const lb = /^\/api\/lists\/([0-9a-f]{16})\/(unsubscribe|remove)$/.exec(path);
	if (lb && method === "POST") {
		const l = await db.prepare("SELECT * FROM lists WHERE id = ? AND brand_id = ?").bind(lb[1], brand.id).first<ListRow>();
		if (!l) return bad("That list has gone.", 404);
		const b = await body(request);
		const emails: string[] = String(b.emails ?? "").split(/[\s,;]+/).map((x) => cleanEmail(x)).filter((x): x is string => !!x).slice(0, 10000);
		if (!emails.length) return bad("Please paste at least one email address.");
		let n = 0;
		for (let i = 0; i < emails.length; i += 100) {
			const res = await db.batch(emails.slice(i, i + 100).map((e) => lb[2] === "unsubscribe"
				? db.prepare("UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE list_id = ? AND status != 'unsubscribed' AND subscriber_id = (SELECT id FROM subscribers WHERE brand_id = ? AND email = ?)").bind(iso(), l.id, brand.id, e)
				: db.prepare("DELETE FROM memberships WHERE list_id = ? AND subscriber_id = (SELECT id FROM subscribers WHERE brand_id = ? AND email = ?)").bind(l.id, brand.id, e)));
			n += res.reduce((t, r) => t + (r.meta.changes ?? 0), 0);
		}
		if (n) await logEvent(db, brand.id, lb[2] === "unsubscribe" ? "unsubscribed" : "removed", null, null, `${n} from ${l.name} by you`).run();
		return ok({ changed: n });
	}

	// -- Reports ---------------------------------------------------------------------------------------
	if (path === "/api/reports") {
		const [emails, problems] = await db.batch([
			db.prepare(`SELECT c.id, c.name, c.subject, c.status, c.started_at, c.total,
				(SELECT COUNT(*) FROM sends x WHERE x.campaign_id = c.id AND x.status = 'sent') AS sent,
				(SELECT COUNT(opened_at) FROM sends x WHERE x.campaign_id = c.id) AS opens,
				(SELECT COUNT(clicked_at) FROM sends x WHERE x.campaign_id = c.id) AS clicks,
				(SELECT COUNT(DISTINCT subscriber_id) FROM events e WHERE e.campaign_id = c.id AND e.kind = 'bounced') AS bounced,
				(SELECT COUNT(DISTINCT subscriber_id) FROM events e WHERE e.campaign_id = c.id AND e.kind = 'complained') AS complained,
				(SELECT COUNT(DISTINCT subscriber_id) FROM events e WHERE e.campaign_id = c.id AND e.kind = 'unsubscribed') AS unsubscribed
				FROM campaigns c WHERE c.brand_id = ? AND c.started_at IS NOT NULL ORDER BY c.started_at DESC LIMIT 100`).bind(brand.id),
			db.prepare(`SELECT e.at, e.kind, e.detail, s.email, c.name, c.subject FROM events e LEFT JOIN subscribers s ON s.id = e.subscriber_id LEFT JOIN campaigns c ON c.id = e.campaign_id
				WHERE e.brand_id = ? AND e.kind IN ('bounced', 'soft_bounce', 'complained') ORDER BY e.id DESC LIMIT 100`).bind(brand.id),
		]);
		return ok({ emails: emails.results, problems: problems.results, tracking: { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) } });
	}

	// -- Images ----------------------------------------------------------------------------------------
	if (path === "/api/images" && method === "POST") {
		if (!env.IMAGES) return bad("Images need the R2 bucket. See the README.");
		const form = await request.formData().catch(() => null);
		const file = form?.get("file") as unknown as File | null;
		if (!file || typeof file === "string") return bad("Please choose a picture.");
		const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[file.type];
		if (!ext) return bad("Please use a PNG, JPEG, GIF or WebP picture.");
		if (file.size > 5_000_000) return bad("That picture is over 5 MB. Please make it smaller first.");
		const key = `${newId(8)}.${ext}`;
		await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
		return ok({ url: `${await origin(db, request)}/img/${key}` });
	}

	return bad("Not found.", 404);
}

/** Which emails a report number stands for (x is the sends row, ?1 the campaign, ?2 the link number). */
export function reportPeople(who: string): string | null {
	const ev = (kind: string) => `EXISTS (SELECT 1 FROM events e WHERE e.campaign_id = ?1 AND e.subscriber_id = x.subscriber_id AND e.kind = '${kind}')`;
	const sent = "x.status = 'sent'";
	return ({
		opened: `${sent} AND x.opened_at IS NOT NULL`,
		unopened: `${sent} AND x.opened_at IS NULL AND NOT ${ev("bounced")} AND NOT ${ev("complained")}`,
		clicked: `${sent} AND x.clicked_at IS NOT NULL`,
		link: `EXISTS (SELECT 1 FROM link_clicks k WHERE k.campaign_id = ?1 AND k.n = ?2 AND k.send_id = x.id)`,
		unsubscribed: ev("unsubscribed"),
		bounced: ev("bounced"),
		complained: ev("complained"),
	} as Record<string, string>)[who] ?? null;
}
/** Every report query binds the link number, so it always appears (SQLite wants every bound value used). */
function usesLink(sql: string | null): string | null {
	return sql && (sql.includes("?2") ? sql : `${sql} AND ?2 IS ?2`);
}

/** What happened to a campaign's emails. */
export async function campaignStats(db: D1Database, id: string) {
	const [byStatus, byEvent, engaged] = await db.batch([
		db.prepare("SELECT status, COUNT(*) AS n FROM sends WHERE campaign_id = ? GROUP BY status").bind(id),
		db.prepare("SELECT kind, COUNT(DISTINCT subscriber_id) AS n FROM events WHERE campaign_id = ? GROUP BY kind").bind(id),
		db.prepare("SELECT COUNT(opened_at) AS opens, COUNT(clicked_at) AS clicks, COALESCE(SUM(opens), 0) AS allOpens FROM sends WHERE campaign_id = ?").bind(id),
	]);
	const s = Object.fromEntries((byStatus.results as any[]).map((r) => [r.status, r.n]));
	const e = Object.fromEntries((byEvent.results as any[]).map((r) => [r.kind, r.n]));
	const g = (engaged.results[0] as any) ?? {};
	return {
		queued: s.queued ?? 0,
		sent: s.sent ?? 0,
		failed: s.failed ?? 0,
		skipped: (s.skipped ?? 0) + (s.cancelled ?? 0),
		bounced: e.bounced ?? 0,
		softBounced: e.soft_bounce ?? 0,
		complained: e.complained ?? 0,
		unsubscribed: e.unsubscribed ?? 0,
		opens: g.opens ?? 0,
		clicks: g.clicks ?? 0,
		allOpens: Math.max(g.allOpens ?? 0, g.opens ?? 0),
	};
}

/** Emails shown inside the app or on the web can show pictures and styles, never run anything. */
export const EMAIL_CSP = "default-src 'none'; img-src * data:; style-src * 'unsafe-inline'; font-src * data:";

export { isProvider };
