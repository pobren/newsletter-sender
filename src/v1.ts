// The public API (/api/v1/*) and webhooks. The same rules as Paul's other apps:
//   * keys are made in the app (Settings, API), shown once, and only their SHA-256 hash is kept;
//   * send the key as "Authorization: Bearer ns_live_..." or "X-API-Key: ns_live_...", never in the web address;
//   * 60 requests a minute per key, up to 10 keys per brand;
//   * errors are { error, docs } and there is no CORS (keys belong on servers, not in web pages);
//   * webhooks are signed: NewsletterSender-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">,
//     with NewsletterSender-Event and NewsletterSender-Delivery headers. Up to 5 per brand; one is switched off after
//     10 failures in a row.

import { cleanEmail, cleanTag } from "./csv.ts";
import { getMeta, iso, logEvent, newId, origin, setMeta, type BrandRow, type Env, type ListRow } from "./db.ts";
import { sealText, sendOne, unsealText } from "./providers.ts";
import { signUp } from "./public.ts";
import { slugify } from "./render.ts";
import { audienceCount, safeJson } from "./sending.ts";
import { loadProvider, sealSecret } from "./settings.ts";

export const DOCS = "https://newslettersender.com/help/api/";
export const MAX_KEYS = 10;
export const MAX_HOOKS = 5;
const PER_MINUTE = 60;

export const EVENTS = ["subscriber.subscribed", "subscriber.pending", "subscriber.unsubscribed", "subscriber.bounced", "subscriber.complained", "campaign.started", "campaign.sent", "campaign.paused"] as const;
/** The app's own event names, as webhooks call them. */
const EVENT_OF: Record<string, (typeof EVENTS)[number]> = {
	subscribed: "subscriber.subscribed", signed_up: "subscriber.pending", unsubscribed: "subscriber.unsubscribed", bounced: "subscriber.bounced",
	complained: "subscriber.complained", "campaign.started": "campaign.started", "campaign.sent": "campaign.sent", "campaign.paused": "campaign.paused",
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (error: string, status = 400, headers: Record<string, string> = {}) => json({ error, docs: DOCS }, status, headers);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(secret: string, text: string): Promise<string> {
	const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -- Keys (made and removed from the app) -------------------------------------------------------------------------

export async function makeKey(db: D1Database, brandId: string, name: string): Promise<{ id: string; key: string } | { error: string }> {
	const n = (await db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE brand_id = ?").bind(brandId).first<{ n: number }>())?.n ?? 0;
	if (n >= MAX_KEYS) return { error: `You can have up to ${MAX_KEYS} keys. Please remove one you don't use first.` };
	const key = `ns_live_${newId(24)}`;
	const id = newId(8);
	await db.prepare("INSERT INTO api_keys (id, brand_id, name, hash, tail, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, brandId, str(name, 60) || "API key", await sha256(key), key.slice(-4), iso()).run();
	return { id, key };
}

export async function listKeys(db: D1Database, brandId: string) {
	return (await db.prepare("SELECT id, name, tail, created_at, last_used_at FROM api_keys WHERE brand_id = ? ORDER BY created_at DESC").bind(brandId).all()).results;
}

// -- Webhooks (made and removed from the app) -----------------------------------------------------------------------

export function cleanHookUrl(v: unknown): string | null {
	if (typeof v !== "string") return null;
	try {
		const u = new URL(v.trim());
		if (u.protocol !== "https:" || u.username || u.password || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname)) return null;
		return u.toString().slice(0, 500);
	} catch {
		return null;
	}
}

export async function makeHook(db: D1Database, brandId: string, url: string, events: string[]): Promise<{ id: string; secret: string } | { error: string }> {
	const n = (await db.prepare("SELECT COUNT(*) AS n FROM webhooks WHERE brand_id = ?").bind(brandId).first<{ n: number }>())?.n ?? 0;
	if (n >= MAX_HOOKS) return { error: `You can have up to ${MAX_HOOKS} webhooks. Please remove one first.` };
	const wanted = events.filter((e) => (EVENTS as readonly string[]).includes(e));
	if (!wanted.length) return { error: "Please choose at least one event." };
	const secret = `whsec_${newId(24)}`;
	const id = newId(8);
	// Start from now, so a new webhook doesn't get everything that happened before it.
	const last = (await db.prepare("SELECT MAX(id) AS m FROM events").first<{ m: number | null }>())?.m ?? 0;
	if (!(await getMeta(db, "hook_cursor"))) await setMeta(db, "hook_cursor", String(last));
	await db.prepare("INSERT INTO webhooks (id, brand_id, url, events, secret, active, failures, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?)")
		.bind(id, brandId, url, JSON.stringify(wanted), await sealText(await sealSecret(db), secret), iso()).run();
	return { id, secret };
}

export async function listHooks(db: D1Database, brandId: string) {
	const { results } = await db.prepare("SELECT id, url, events, active, failures, last_status, last_at, created_at FROM webhooks WHERE brand_id = ? ORDER BY created_at").bind(brandId).all<any>();
	return results.map((h) => ({ ...h, events: safeJson(h.events) ?? [], active: Boolean(h.active) }));
}

interface Hook { id: string; brand_id: string; url: string; events: string; secret: string; failures: number }

/** Sends one event to one webhook, signed. Returns the HTTP status (0 when it couldn't connect). */
export async function deliver(db: D1Database, h: Hook, event: string, data: unknown, fetcher: typeof fetch = fetch): Promise<number> {
	const secret = await unsealText(await sealSecret(db), h.secret);
	if (!secret) return 0;
	const delivery = newId(12);
	const body = JSON.stringify({ id: delivery, event, created_at: iso(), data });
	const t = Math.floor(Date.now() / 1000);
	const status = await fetcher(h.url, {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": "NewsletterSender-Webhooks", "NewsletterSender-Event": event, "NewsletterSender-Delivery": delivery, "NewsletterSender-Signature": `t=${t},v1=${await hmac(secret, `${t}.${body}`)}` },
		body,
		signal: AbortSignal.timeout(10_000),
		redirect: "manual",
	}).then((r) => r.status, () => 0);
	const okay = status >= 200 && status < 300;
	await db.prepare("UPDATE webhooks SET last_status = ?, last_at = ?, failures = ?, active = ? WHERE id = ?")
		.bind(status, iso(), okay ? 0 : h.failures + 1, okay || h.failures + 1 < 10 ? 1 : 0, h.id).run();
	h.failures = okay ? 0 : h.failures + 1;
	return status;
}

/** Every minute: new events go to the webhooks that asked for them. */
export async function dispatchHooks(env: Env, fetcher: typeof fetch = fetch): Promise<number> {
	const db = env.DB;
	const hooks = (await db.prepare("SELECT * FROM webhooks WHERE active = 1").all<Hook>()).results;
	const max = (await db.prepare("SELECT MAX(id) AS m FROM events").first<{ m: number | null }>())?.m ?? 0;
	if (!hooks.length) {
		await setMeta(db, "hook_cursor", String(max));
		return 0;
	}
	const from = Number((await getMeta(db, "hook_cursor")) ?? max);
	const kinds = Object.keys(EVENT_OF);
	const { results } = await db.prepare(`SELECT e.*, s.email, s.name FROM events e LEFT JOIN subscribers s ON s.id = e.subscriber_id
		WHERE e.id > ? AND e.kind IN (${kinds.map(() => "?").join(",")}) AND (e.detail IS NULL OR e.detail != 'load test') ORDER BY e.id LIMIT 300`).bind(from, ...kinds).all<any>();
	let sent = 0;
	for (const e of results) {
		const event = EVENT_OF[e.kind];
		const data = event.startsWith("subscriber.")
			? { subscriber: { id: e.subscriber_id, email: e.email ?? null, name: e.name ?? null }, campaign_id: e.campaign_id, detail: e.detail }
			: { campaign_id: e.campaign_id, detail: e.detail };
		for (const h of hooks) {
			if (h.brand_id !== e.brand_id || h.failures >= 10 || !(safeJson(h.events) ?? []).includes(event)) continue;
			await deliver(db, h, event, { ...data, at: e.at }, fetcher);
			sent++;
		}
	}
	await setMeta(db, "hook_cursor", String(results.length ? results[results.length - 1].id : Math.max(from, max)));
	return sent;
}

// -- The API itself -------------------------------------------------------------------------------------------------

async function keyFor(db: D1Database, request: Request, url: URL): Promise<{ brand: BrandRow; keyId: string } | Response> {
	if (["key", "api_key", "apikey", "token"].some((k) => url.searchParams.has(k))) return fail("Please send your key in the Authorization header, never in the web address. Make a new key now, as this one may have been seen.", 400);
	const auth = request.headers.get("authorization") ?? "";
	const key = (/^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? request.headers.get("x-api-key") ?? "").trim();
	if (!/^ns_live_[0-9a-f]{48}$/.test(key)) return fail("Please send your API key as Authorization: Bearer ns_live_...", 401);
	const row = await db.prepare("SELECT k.id, k.brand_id FROM api_keys k WHERE k.hash = ?").bind(await sha256(key)).first<{ id: string; brand_id: string }>();
	if (!row) return fail("That API key isn't right, or it has been removed.", 401);
	const bucket = Math.floor(Date.now() / 600_000);
	const minute = Math.floor(Date.now() / 60_000);
	const used = await db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value").bind(`rl:${bucket}:api:${row.id}:${minute}`).first<{ value: string }>();
	if (Number(used?.value ?? 0) > PER_MINUTE) return fail(`Too many requests. Each key can make ${PER_MINUTE} a minute.`, 429, { "retry-after": String(60 - (Math.floor(Date.now() / 1000) % 60)) });
	await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").bind(iso(), row.id, new Date(Date.now() - 600_000).toISOString()).run();
	const brand = await db.prepare("SELECT * FROM brands WHERE id = ?").bind(row.brand_id).first<BrandRow>();
	if (!brand) return fail("That API key's brand has gone.", 401);
	return { brand, keyId: row.id };
}

async function body(request: Request): Promise<Record<string, any> | null> {
	try {
		const b = await request.json();
		return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, any>) : null;
	} catch {
		return null;
	}
}

async function findList(db: D1Database, brandId: string, ref: unknown): Promise<ListRow | null> {
	if (typeof ref !== "string" || !ref.trim()) return null;
	return db.prepare("SELECT * FROM lists WHERE brand_id = ? AND (id = ? OR slug = ?)").bind(brandId, ref.trim(), ref.trim().toLowerCase()).first<ListRow>();
}

async function findSubscriber(db: D1Database, brandId: string, ref: string): Promise<any | null> {
	const r = decodeURIComponent(ref).toLowerCase();
	return db.prepare("SELECT * FROM subscribers WHERE brand_id = ? AND (id = ? OR email = ?)").bind(brandId, r, r).first<any>();
}

async function subscriberOut(db: D1Database, s: any) {
	const { results } = await db.prepare("SELECT l.id, l.slug, l.name, m.status, m.created_at, m.confirmed_at, m.left_at FROM memberships m JOIN lists l ON l.id = m.list_id WHERE m.subscriber_id = ?").bind(s.id).all<any>();
	return {
		id: s.id, email: s.email, name: s.name, fields: safeJson(s.fields) ?? {}, tags: safeJson(s.tags) ?? [],
		status: s.suppressed ? s.suppressed : results.some((m) => m.status === "active") ? "active" : results.some((m) => m.status === "pending") ? "pending_confirmation" : "unsubscribed",
		lists: results.map((m) => ({ id: m.id, slug: m.slug, name: m.name, status: m.status === "pending" ? "pending_confirmation" : m.status, joined_at: m.created_at, confirmed_at: m.confirmed_at, left_at: m.left_at })),
		created_at: s.created_at,
	};
}

const cleanTags = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(cleanTag).filter((t): t is string => !!t))].slice(0, 30) : []);

export async function handleV1(request: Request, env: Env, url: URL): Promise<Response> {
	const db = env.DB;
	if (request.method === "OPTIONS") return new Response(null, { status: 204 });
	const who = await keyFor(db, request, url);
	if (who instanceof Response) return who;
	const { brand } = who;
	const path = url.pathname.replace(/\/+$/, "");
	const method = request.method;

	if (path === "/api/v1" || path === "/api/v1/me") return json({ brand: { id: brand.id, name: brand.name }, docs: DOCS });

	// -- Lists
	if (path === "/api/v1/lists" && method === "GET") {
		const { results } = await db.prepare(`SELECT l.id, l.slug, l.name, l.description, l.double_optin, l.created_at,
			(SELECT COUNT(*) FROM memberships m WHERE m.list_id = l.id AND m.status = 'active') AS subscribers FROM lists l WHERE l.brand_id = ? ORDER BY l.created_at`).bind(brand.id).all<any>();
		return json({ data: results.map((l) => ({ ...l, double_optin: Boolean(l.double_optin) })) });
	}

	// -- Subscribers
	if (path === "/api/v1/subscribers" && method === "GET") {
		const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
		const after = url.searchParams.get("cursor") ?? "";
		const where = ["s.brand_id = ?", "s.id > ?"];
		const binds: unknown[] = [brand.id, after];
		const listRef = url.searchParams.get("list");
		if (listRef) {
			const l = await findList(db, brand.id, listRef);
			if (!l) return fail("There's no list with that id or slug.", 404);
			const st = url.searchParams.get("status") ?? "active";
			where.push("EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.list_id = ? AND m.status = ?)");
			binds.push(l.id, st === "pending_confirmation" ? "pending" : st);
		}
		const { results } = await db.prepare(`SELECT s.* FROM subscribers s WHERE ${where.join(" AND ")} ORDER BY s.id LIMIT ?`).bind(...binds, limit + 1).all<any>();
		const page = results.slice(0, limit);
		return json({ data: await Promise.all(page.map((s) => subscriberOut(db, s))), next_cursor: results.length > limit ? page[page.length - 1].id : null });
	}
	if (path === "/api/v1/subscribers" && method === "POST") {
		const b = await body(request);
		if (!b) return fail("Please send JSON, such as { \"email\": \"sam@example.com\", \"list\": \"weekly\" }.");
		const refs: unknown[] = Array.isArray(b.lists) ? b.lists : b.list ? [b.list] : [];
		if (!refs.length) return fail("Please say which list, by its id or slug: \"list\": \"weekly\".");
		const lists: ListRow[] = [];
		for (const r of refs.slice(0, 20)) {
			const l = await findList(db, brand.id, r);
			if (!l) return fail(`There's no list called ${String(r).slice(0, 60)}.`, 404);
			lists.push(l);
		}
		if (!cleanEmail(b.email)) return fail("Please check the email address.");
		// Double opt in by default; "confirmed": true is for people who've already said yes somewhere else.
		const confirmed = b.confirmed === true;
		let status = "";
		for (const l of lists) {
			const r = await signUp(env, l, brand, { email: b.email, name: b.name, fields: b.fields && typeof b.fields === "object" ? b.fields : {} }, "API", confirmed);
			if ("error" in r) return fail(r.error);
			if (r.status === "blocked") return fail("That address is on your blocklist, so it can't be added.", 409);
			status ||= r.status;
		}
		const s = await findSubscriber(db, brand.id, cleanEmail(b.email)!);
		const tags = cleanTags(b.tags);
		if (s && tags.length) await db.prepare("UPDATE subscribers SET tags = ? WHERE id = ?").bind(JSON.stringify([...new Set([...(safeJson(s.tags) ?? []), ...tags])].slice(0, 30)), s.id).run();
		const out = await subscriberOut(db, (await findSubscriber(db, brand.id, s.id))!);
		return json({ ...out, result: status === "pending" ? "pending_confirmation" : status }, status === "already" ? 200 : 201);
	}
	const sm = /^\/api\/v1\/subscribers\/([^/]+)(\/unsubscribe)?$/.exec(path);
	if (sm) {
		const s = await findSubscriber(db, brand.id, sm[1]);
		if (!s) return fail("There's no subscriber with that id or email.", 404);
		if (sm[2]) {
			if (method !== "POST") return fail("Use POST to unsubscribe someone.", 405);
			const b = (await body(request)) ?? {};
			const l = b.list ? await findList(db, brand.id, b.list) : null;
			if (b.list && !l) return fail("There's no list with that id or slug.", 404);
			await db.prepare(`UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE subscriber_id = ? AND status != 'unsubscribed'${l ? " AND list_id = ?" : ""}`).bind(...[iso(), s.id, ...(l ? [l.id] : [])]).run();
			await logEvent(db, brand.id, "unsubscribed", s.id, null, l ? `${l.name}, by the API` : "by the API").run();
			return json(await subscriberOut(db, s));
		}
		if (method === "GET") return json(await subscriberOut(db, s));
		if (method === "PATCH") {
			const b = await body(request);
			if (!b) return fail("Please send JSON.");
			let tags: string[] = safeJson(s.tags) ?? [];
			if (Array.isArray(b.tags)) tags = cleanTags(b.tags);
			tags = [...new Set([...tags, ...cleanTags(b.add_tags)])].filter((t) => !cleanTags(b.remove_tags).includes(t)).slice(0, 30);
			const fields = { ...(safeJson(s.fields) ?? {}) };
			if (b.fields && typeof b.fields === "object") for (const [k, v] of Object.entries(b.fields).slice(0, 50)) {
				if (v === null) delete fields[k];
				else if (typeof v === "string" || typeof v === "number") fields[k.slice(0, 40)] = String(v).slice(0, 500);
			}
			await db.prepare("UPDATE subscribers SET name = ?, tags = ?, fields = ? WHERE id = ?").bind("name" in b ? str(b.name, 120) || null : s.name, JSON.stringify(tags), JSON.stringify(fields), s.id).run();
			return json(await subscriberOut(db, (await findSubscriber(db, brand.id, s.id))!));
		}
		if (method === "DELETE") {
			// Everything we hold about them goes (a right to be forgotten request).
			await db.batch([db.prepare("DELETE FROM memberships WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM sends WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM events WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM automation_runs WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM poll_votes WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM subscribers WHERE id = ?").bind(s.id)]);
			return json({ deleted: true, id: s.id });
		}
		return fail("That method isn't supported here.", 405);
	}

	// -- Campaigns
	if (path === "/api/v1/campaigns" && method === "GET") {
		const { results } = await db.prepare(`SELECT c.id, c.name, c.subject, c.status, c.send_at, c.started_at, c.finished_at, c.total, c.created_at,
			(SELECT COUNT(*) FROM sends x WHERE x.campaign_id = c.id AND x.status = 'sent') AS sent FROM campaigns c WHERE c.brand_id = ? ORDER BY c.created_at DESC LIMIT 100`).bind(brand.id).all();
		return json({ data: results });
	}
	if (path === "/api/v1/campaigns" && method === "POST") {
		const b = await body(request);
		if (!b) return fail("Please send JSON.");
		const subject = str(b.subject, 200);
		if (!subject) return fail("Please give the campaign a subject.");
		const html = typeof b.html === "string" ? b.html.slice(0, 500_000) : "";
		const listIds: string[] = [];
		for (const r of (Array.isArray(b.lists) ? b.lists : b.list ? [b.list] : []).slice(0, 20)) {
			const l = await findList(db, brand.id, r);
			if (!l) return fail(`There's no list called ${String(r).slice(0, 60)}.`, 404);
			listIds.push(l.id);
		}
		const id = newId(8);
		const now = iso();
		await db.prepare("INSERT INTO campaigns (id, brand_id, name, subject, preheader, html, audience, status, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)")
			.bind(id, brand.id, str(b.name, 120) || null, subject, str(b.preheader, 200) || null, html, JSON.stringify({ lists: listIds, tags: cleanTags(b.tags) }), `${slugify(subject).slice(0, 50)}-${id.slice(0, 4)}`, now, now).run();
		return json({ id, status: "draft", edit_url: `${await origin(db)}/#email/${id}`, audience: listIds.length ? await audienceCount(db, brand.id, { lists: listIds, tags: cleanTags(b.tags) } as any) : 0 }, 201);
	}
	const cm = /^\/api\/v1\/campaigns\/([0-9a-f]{16})$/.exec(path);
	if (cm && method === "GET") {
		const c = await db.prepare("SELECT id, name, subject, preheader, status, send_at, started_at, finished_at, total, created_at, updated_at FROM campaigns WHERE id = ? AND brand_id = ?").bind(cm[1], brand.id).first<any>();
		if (!c) return fail("There's no campaign with that id.", 404);
		const counts = (await db.prepare("SELECT status, COUNT(*) AS n FROM sends WHERE campaign_id = ? GROUP BY status").bind(c.id).all<{ status: string; n: number }>()).results;
		const ev = (await db.prepare("SELECT kind, COUNT(DISTINCT subscriber_id) AS n FROM events WHERE campaign_id = ? GROUP BY kind").bind(c.id).all<{ kind: string; n: number }>()).results;
		const n = (k: string) => ev.find((e) => e.kind === k)?.n ?? 0;
		return json({ ...c, stats: { ...Object.fromEntries(counts.map((x) => [x.status, x.n])), unsubscribed: n("unsubscribed"), bounced: n("bounced"), complained: n("complained") } });
	}

	// -- One off emails (a receipt, a password reset, a "thanks for your order")
	if (path === "/api/v1/emails" && method === "POST") {
		const b = await body(request);
		if (!b) return fail("Please send JSON.");
		const to = cleanEmail(b.to);
		const subject = str(b.subject, 200);
		const html = typeof b.html === "string" ? b.html.slice(0, 500_000) : "";
		const text = typeof b.text === "string" ? b.text.slice(0, 200_000) : html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		if (!to) return fail("Please check the \"to\" address.");
		if (!subject || (!html && !text)) return fail("Please send a subject and html or text.");
		const s = await findSubscriber(db, brand.id, to);
		if (s?.suppressed) return fail("That address bounced or marked you as spam before, so we won't email it.", 409);
		const provider = await loadProvider(db, brand);
		if (!provider) return fail("Please choose how to send first, under Settings, Sending.", 409);
		const r = await sendOne(provider, brand.from_name, brand.from_email, { to, subject, text, html: html || `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</pre>`, headers: {}, replyTo: cleanEmail(b.reply_to) || brand.reply_to });
		if (!r.ok) return fail(`It didn't send: ${r.error ?? "please try again"}`, 502);
		return json({ sent: true, message_id: r.id ?? null }, 202);
	}

	return fail("There's nothing at that address. See the docs for what the API can do.", 404);
}
