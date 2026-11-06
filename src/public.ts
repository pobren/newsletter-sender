// Everything readers see without signing in: sign up forms, confirming, unsubscribing, the archive of past issues,
// images, and (only when the owner switches them on) open and click counts. Plus the addresses sending services
// report bounces and spam complaints to.

import { csvLine, cleanEmail } from "./csv.ts";
import { getMeta, isBlocked, iso, linkBase, logEvent, newId, origin, setMeta, type BrandRow, type CampaignRow, type Env, type ListRow, type SubscriberRow } from "./db.ts";
import { isProvider, parseProviderEvent, parseSesEvent, sendOne, trustedSubscribeUrl, type MailEvent } from "./providers.ts";
import { cleanBlocks, esc, renderEmail } from "./render.ts";
import { campaignContent, safeJson, sendSig, shareSig } from "./sending.ts";
import { loadProvider, sealSecret } from "./settings.ts";
import { turnstileKey, turnstileOk } from "./turnstile.ts";
import { checkCampaign } from "./health.ts";
import { fireSafely } from "./automations.ts";
import { pollsIn } from "./polls.ts";

export { csvLine };

const html = (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });

/** A simple page in the brand's colours. */
export function publicPage(brand: Pick<BrandRow, "name" | "colour" | "logo">, title: string, body: string, opts: { index?: boolean; turnstile?: boolean } = {}): string {
	const colour = /^#[0-9a-f]{6}$/i.test(brand.colour) ? brand.colour : "#a3195b";
	return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | ${esc(brand.name)}</title>${opts.index ? "" : '<meta name="robots" content="noindex">'}
<style>:root{--c:${colour}}*{box-sizing:border-box}body{margin:0;background:#fbf7f9;color:#1d1424;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:620px;margin:0 auto;padding:48px 20px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;color:var(--c);text-decoration:none;margin-bottom:28px}.brand img{height:40px;width:auto}
.card{background:#fff;border:1px solid #efe2e9;border-radius:16px;padding:28px}h1{font-size:30px;line-height:1.2;margin:0 0 12px}p{margin:0 0 14px;color:#4a3b52}
label{display:block;font-weight:600;margin:16px 0 6px}input{width:100%;min-height:50px;padding:0 14px;border:2px solid #e6cfdb;border-radius:10px;font:inherit}input:focus{outline:3px solid #fbe6f0;border-color:var(--c)}
button,.btn{display:inline-flex;align-items:center;gap:8px;margin-top:20px;min-height:50px;padding:0 22px;border:0;border-radius:10px;background:var(--c);color:#fff;font:600 17px system-ui,sans-serif;cursor:pointer;text-decoration:none}
button svg,.btn svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.hp{position:absolute;left:-9999px}.opt{display:flex;gap:12px;align-items:flex-start;font-weight:400;margin:0;padding:12px 0;border-bottom:1px solid #efe2e9;cursor:pointer}.opt input{width:22px;height:22px;min-height:0;margin:3px 0 0;accent-color:var(--c);flex:none}.opt span{display:block}.btns{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.btn.ghost{background:#fff;color:var(--c);border:2px solid #e6cfdb}.okmsg{display:flex;gap:8px;align-items:center;color:#166534;font-weight:600;background:#dcfce7;padding:10px 14px;border-radius:10px}.okmsg svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2}.small{font-size:14px;color:#6b5a73}.err{color:#a1122e;font-weight:600}ul.issues{list-style:none;padding:0;margin:0}ul.issues li{padding:14px 0;border-bottom:1px solid #efe2e9}ul.issues a{color:#1d1424;font-weight:600;text-decoration:none}ul.issues span{display:block;font-size:14px;color:#6b5a73}
</style>${opts.turnstile ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""}</head><body><main>
<a class="brand" href="/archive">${brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}">` : esc(brand.name)}</a>${body}</main></body></html>`;
}

const ICON_RSS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="vertical-align:-3px;margin-right:6px"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>`;
const ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

interface Field {
	key: string;
	label: string;
	required?: boolean;
}

export const listFields = (l: ListRow): Field[] => (safeJson(l.fields) ?? []).filter((f: any) => f && typeof f.key === "string" && typeof f.label === "string");

/** The sign up form, as a hosted page or as code to paste into any website. */
export function formHtml(l: ListRow, action: string, siteKey: string | null): string {
	const fields = listFields(l)
		.map((f) => `<label for="f_${esc(f.key)}">${esc(f.label)}</label><input id="f_${esc(f.key)}" name="${esc(f.key)}"${f.required ? " required" : ""}>`)
		.join("");
	return `<form method="post" action="${esc(action)}">
<label for="ns_email">Your email address</label><input id="ns_email" type="email" name="email" required autocomplete="email">
<label for="ns_name">Your name (optional)</label><input id="ns_name" name="name" autocomplete="name">${fields}
<div class="hp" aria-hidden="true"><label for="ns_hp">Leave this empty</label><input id="ns_hp" name="hp" tabindex="-1" autocomplete="off"></div>
${siteKey ? `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-response-field-name="ts" style="margin-top:16px"></div>` : ""}
<button type="submit">${ICON_SEND}Subscribe</button></form>`;
}

/** The brand a public page belongs to: the one whose own domain for links this is, otherwise the first. */
async function brandForHost(db: D1Database, url: URL): Promise<BrandRow | null> {
	return (await db.prepare("SELECT * FROM brands WHERE track_domain = ?").bind(`https://${url.hostname}`).first<BrandRow>())
		?? db.prepare("SELECT * FROM brands ORDER BY created_at LIMIT 1").first<BrandRow>();
}

async function listBySlug(db: D1Database, slug: string) {
	const l = await db.prepare("SELECT * FROM lists WHERE slug = ?").bind(slug).first<ListRow>();
	const b = l ? await db.prepare("SELECT * FROM brands WHERE id = ?").bind(l.brand_id).first<BrandRow>() : null;
	return l && b ? { l, b } : null;
}

/** At most this many sign ups from one address in ten minutes. */
const SIGNUPS_PER_IP = 10;

async function tooMany(db: D1Database, ip: string): Promise<boolean> {
	const slot = Math.floor(Date.now() / 600_000);
	const key = `rl:${slot}:${ip}`;
	const n = Number((await getMeta(db, key)) ?? 0) + 1;
	await setMeta(db, key, String(n));
	return n > SIGNUPS_PER_IP;
}

/** Someone signing up, from the hosted page, a form on any website or the API. */
export async function signUp(env: Env, l: ListRow, b: BrandRow, input: { email: unknown; name?: unknown; fields?: Record<string, unknown> }, source: string, confirmed = false): Promise<{ ok: true; status: "pending" | "active" | "already" | "elsewhere" | "blocked" } | { error: string }> {
	const db = env.DB;
	const email = cleanEmail(input.email);
	if (!email) return { error: "Please check your email address." };
	const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 120) || null : null;
	const fields: Record<string, string> = {};
	for (const f of listFields(l)) {
		const v = input.fields?.[f.key];
		if (typeof v === "string" && v.trim()) fields[f.key] = v.trim().slice(0, 500);
		else if (f.required && !confirmed) return { error: `Please fill in ${f.label}.` };
	}
	// The blocklist: never added, and (on public forms) never told why.
	if (await isBlocked(db, b.id, email)) return { ok: true, status: "blocked" };
	const now = iso();
	await db.prepare("INSERT INTO subscribers (id, brand_id, email, name, fields, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (brand_id, email) DO NOTHING").bind(newId(8), b.id, email, name, JSON.stringify(fields), newId(16), now).run();
	const s = (await db.prepare("SELECT * FROM subscribers WHERE brand_id = ? AND email = ?").bind(b.id, email).first<SubscriberRow>())!;
	// Keep what they told us this time, without losing what we had.
	const merged = { ...(safeJson(s.fields) ?? {}), ...fields };
	await db.prepare("UPDATE subscribers SET name = COALESCE(?, name), fields = ? WHERE id = ?").bind(name, JSON.stringify(merged), s.id).run();
	if (s.suppressed === "complained") return { ok: true, status: "already" }; // marked us as spam: never again, but don't say so
	const m = await db.prepare("SELECT status FROM memberships WHERE list_id = ? AND subscriber_id = ?").bind(l.id, s.id).first<{ status: string }>();
	if (m?.status === "active") return { ok: true, status: "already" };
	// One list per person (when the owner has chosen that): someone on another list stays where they are.
	if (b.one_list && (await db.prepare("SELECT 1 FROM memberships WHERE subscriber_id = ? AND list_id != ? AND status IN ('active', 'pending')").bind(s.id, l.id).first())) return { ok: true, status: "elsewhere" };
	const direct = confirmed || !l.double_optin;
	const token = direct ? null : newId(16);
	await db.prepare(`INSERT INTO memberships (list_id, subscriber_id, status, source, confirm_token, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (list_id, subscriber_id) DO UPDATE SET status = excluded.status, source = excluded.source, confirm_token = excluded.confirm_token, confirmed_at = excluded.confirmed_at, left_at = NULL`)
		.bind(l.id, s.id, direct ? "active" : "pending", source, token, now, direct ? now : null).run();
	// The other lists this list's form adds people to. They're confirmed along with this one.
	const also: string[] = b.one_list ? [] : (safeJson(l.also_lists) ?? []).filter((x: unknown) => typeof x === "string");
	if (also.length) await db.batch(also.map((id) => db.prepare(`INSERT INTO memberships (list_id, subscriber_id, status, source, created_at, confirmed_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM lists WHERE id = ? AND brand_id = ?)
		ON CONFLICT (list_id, subscriber_id) DO UPDATE SET status = CASE WHEN memberships.status = 'active' THEN 'active' ELSE excluded.status END, left_at = NULL`).bind(id, s.id, direct ? "active" : "pending", `${source}, with ${l.name}`, now, direct ? now : null, id, b.id)));
	// A bounced address that signs up again gets another chance.
	if (s.suppressed === "bounced") await db.prepare("UPDATE subscribers SET suppressed = NULL, suppressed_at = NULL WHERE id = ?").bind(s.id).run();
	await logEvent(db, b.id, direct ? "subscribed" : "signed_up", s.id, null, `${l.name} (${source})`).run();
	if (direct) for (const id of [l.id, ...also]) await fireSafely(db, b.id, s.id, { kind: "joined", list: id });
	const base = linkBase(b, await origin(db));
	if (!direct) await oneOff(env, b, email, `Please confirm: ${l.name}`, [`Hello${name ? ` ${name.split(" ")[0]}` : ""},`, `Please confirm you'd like to get ${l.name === b.name ? b.name : `${l.name} from ${b.name}`}. Just press the button below.`, `If you didn't ask for this, you can ignore this email and you won't hear from us again.`], { label: "Yes, sign me up", href: `${base}/c/${token}` });
	else if (l.welcome_subject && l.welcome_text) await oneOff(env, b, email, l.welcome_subject, l.welcome_text.split(/\n{2,}/));
	return { ok: true, status: direct ? "active" : "pending" };
}

/**
 * A one off email (a sign up confirmation or welcome). Cloudflare's email service sends these when the Worker has
 * it (Paul's rule: confirmations only, never newsletters); otherwise the brand's own sending service does.
 */
export async function oneOff(env: Env, b: BrandRow, to: string, subject: string, paras: string[], button?: { label: string; href: string }): Promise<boolean> {
	const blocks = [{ type: "text" as const, text: paras.join("\n\n") }, ...(button ? [{ type: "button" as const, label: button.label, href: button.href }] : [])];
	const base = linkBase(b, await origin(env.DB));
	const out = renderEmail(subject, blocks, { brandName: b.name, colour: b.colour, logo: b.logo, footer: b.footer, unsubscribeUrl: `${base}/archive`, track: null }, { email: to });
	const text = [...paras, button ? `${button.label}: ${button.href}` : ""].filter(Boolean).join("\n\n") + `\n\n${b.name}\n`;
	if (env.EMAIL) {
		try {
			await env.EMAIL.send({ to, from: { email: b.from_email, name: b.from_name }, subject, text, html: out.html.replace(/You're getting this because[^<]*<br>/, "").replace(/<a [^>]*>Unsubscribe<\/a>/, "") } as any);
			return true;
		} catch (e) {
			console.error("Cloudflare email failed, trying the sending service", e);
		}
	}
	const p = await loadProvider(env.DB, b);
	if (!p) return false;
	const r = await sendOne(p, b.from_name, b.from_email, { to, subject, text, html: out.html, headers: {}, replyTo: b.reply_to });
	return r.ok;
}

/** An open or click: start any automations it triggers (never stopping the reader getting where they're going). */
async function fireForCampaign(db: D1Database, campaign: string, subscriber: string, e: Parameters<typeof fireSafely>[3]): Promise<void> {
	const c = await db.prepare("SELECT brand_id FROM campaigns WHERE id = ?").bind(campaign).first<{ brand_id: string }>().catch(() => null);
	if (c) await fireSafely(db, c.brand_id, subscriber, e);
}

/** The reader's country as two letters, from Cloudflare. Only the country is kept, never the IP address. */
export function countryOf(request: Request): string | null {
	const c = String((request as any).cf?.country ?? "").toUpperCase();
	return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null;
}

export async function handlePublic(request: Request, env: Env, url: URL): Promise<Response | null> {
	const db = env.DB;
	const path = url.pathname;
	const ip = request.headers.get("cf-connecting-ip") ?? "local";

	// -- Sign up -----------------------------------------------------------------
	const sm = /^\/s\/([a-z0-9-]{1,60})\/?$/.exec(path);
	if (sm) {
		const found = await listBySlug(db, sm[1]);
		if (!found) return html(publicPage({ name: "Newsletter", colour: "#a3195b", logo: null }, "Not found", `<div class="card"><h1>That sign up form isn't here</h1><p>It may have moved.</p></div>`), 404);
		const { l, b } = found;
		const siteKey = turnstileKey(env);
		if (request.method === "POST") {
			const wantsJson = (request.headers.get("accept") ?? "").includes("application/json") || (request.headers.get("content-type") ?? "").includes("application/json");
			const form: Record<string, unknown> = wantsJson ? ((await request.json().catch(() => ({}))) as any) : Object.fromEntries(await request.formData().catch(() => new FormData()));
			const fail = (msg: string, status = 400) => (wantsJson ? Response.json({ error: msg }, { status, headers: cors }) : html(publicPage(b, l.name, `<div class="card"><h1>${esc(l.name)}</h1><p class="err">${esc(msg)}</p>${formHtml(l, `/s/${l.slug}`, siteKey)}</div>`, { turnstile: !!siteKey }), status));
			if (form.hp) return wantsJson ? Response.json({ ok: true }, { headers: cors }) : Response.redirect(`${url.origin}/s/${l.slug}?done=1`, 303);
			if (await tooMany(db, ip)) return fail("Lots of sign ups from here just now. Please try again in a few minutes.", 429);
			if (!(await turnstileOk(env, request, form.ts ?? form["cf-turnstile-response"]))) return fail("We couldn't check you're a person. Please try again.");
			const fields: Record<string, unknown> = {};
			for (const f of listFields(l)) fields[f.key] = form[f.key];
			const r = await signUp(env, l, b, { email: form.email, name: form.name, fields }, request.headers.get("referer") ? new URL(request.headers.get("referer")!).hostname : "form");
			if ("error" in r) return fail(r.error);
			if (wantsJson) return Response.json({ ok: true, confirm: r.status === "pending" }, { headers: cors });
			return Response.redirect(l.thanks_url || `${url.origin}/s/${l.slug}?done=${r.status === "pending" ? 1 : 2}`, 303);
		}
		const done = url.searchParams.get("done");
		if (done) return html(publicPage(b, l.name, `<div class="card"><h1>${done === "1" ? "Nearly there" : "You're on the list"}</h1><p>${done === "1" ? "Please check your inbox and press the button in the email we've just sent, so we know it's really you." : `Thanks for signing up to ${esc(l.name)}.`}</p></div>`));
		return html(publicPage(b, l.name, `<div class="card"><h1>${esc(l.name)}</h1>${l.description ? `<p>${esc(l.description)}</p>` : ""}${formHtml(l, `/s/${l.slug}`, siteKey)}<p class="small" style="margin-top:16px">You can unsubscribe at any time with the link in every email.</p></div>`, { index: true, turnstile: !!siteKey }));
	}
	if (request.method === "OPTIONS" && /^\/s\//.test(path)) return new Response(null, { status: 204, headers: cors });

	// -- Confirm ---------------------------------------------------------------------
	const cm = /^\/c\/([0-9a-f]{32})\/?$/.exec(path);
	if (cm) {
		const m = await db.prepare("SELECT m.*, l.name AS list_name, l.brand_id, l.welcome_subject, l.welcome_text, l.also_lists FROM memberships m JOIN lists l ON l.id = m.list_id WHERE m.confirm_token = ?").bind(cm[1]).first<any>();
		const b = m ? await db.prepare("SELECT * FROM brands WHERE id = ?").bind(m.brand_id).first<BrandRow>() : await db.prepare("SELECT * FROM brands LIMIT 1").first<BrandRow>();
		const brand = b ?? { name: "Newsletter", colour: "#a3195b", logo: null };
		if (!m || !b) return html(publicPage(brand, "Link expired", `<div class="card"><h1>That link has already been used</h1><p>If you've confirmed already, you're all set.</p></div>`), 404);
		// Link checkers in some inboxes open every link, so confirming needs a press (done for you by the page's script).
		if (request.method !== "POST") return html(publicPage(b, "Confirm", `<div class="card"><h1>Confirm your subscription</h1><p>${esc(m.list_name)} from ${esc(b.name)}.</p><form method="post" id="go"><button type="submit">${ICON_CHECK}Yes, sign me up</button></form></div><script>document.getElementById("go").submit()</script>`));
		await db.batch([
			db.prepare("UPDATE memberships SET status = 'active', confirmed_at = ?, confirm_token = NULL WHERE list_id = ? AND subscriber_id = ?").bind(iso(), m.list_id, m.subscriber_id),
			// The other lists the form added them to wait for this same confirmation.
			db.prepare("UPDATE memberships SET status = 'active', confirmed_at = ? WHERE subscriber_id = ? AND status = 'pending' AND confirm_token IS NULL AND list_id IN (SELECT value FROM json_each(?))").bind(iso(), m.subscriber_id, m.also_lists || "[]"),
		]);
		await logEvent(db, b.id, "subscribed", m.subscriber_id, null, `${m.list_name} (confirmed)`).run();
		for (const id of [m.list_id, ...((safeJson(m.also_lists) ?? []) as string[])]) await fireSafely(db, b.id, m.subscriber_id, { kind: "joined", list: id });
		const s = await db.prepare("SELECT email FROM subscribers WHERE id = ?").bind(m.subscriber_id).first<{ email: string }>();
		if (s && m.welcome_subject && m.welcome_text) await oneOff(env, b, s.email, m.welcome_subject, String(m.welcome_text).split(/\n{2,}/));
		return html(publicPage(b, "Confirmed", `<div class="card"><h1>You're on the list</h1><p>Thanks for confirming. ${esc(m.list_name)} will arrive in your inbox.</p></div>`));
	}

	// -- Unsubscribe (also the one click unsubscribe mail apps use) ---------------------
	const um = /^\/u\/([0-9a-f]{32}|test)\/?$/.exec(path);
	if (um) {
		const s = um[1] === "test" ? null : await db.prepare("SELECT * FROM subscribers WHERE token = ?").bind(um[1]).first<SubscriberRow>();
		const b = s ? await db.prepare("SELECT * FROM brands WHERE id = ?").bind(s.brand_id).first<BrandRow>() : await db.prepare("SELECT * FROM brands LIMIT 1").first<BrandRow>();
		const brand = b ?? { name: "Newsletter", colour: "#a3195b", logo: null };
		if (um[1] === "test") return html(publicPage(brand, "Unsubscribe", `<div class="card"><h1>This was a test email</h1><p>In a real email, this link unsubscribes the reader straight away.</p></div>`));
		if (!s || !b) return html(publicPage(brand, "Unsubscribe", `<div class="card"><h1>You're not on the list</h1><p>There's nothing more to do.</p></div>`), 404);
		const campaign = /^[0-9a-f]{16}$/.test(url.searchParams.get("c") ?? "") ? url.searchParams.get("c") : null;
		// Unsubscribing leaves every list, or (when the owner has chosen it) just the lists that email went to.
		const c = campaign && b.unsub_scope === "list" ? await db.prepare("SELECT audience FROM campaigns WHERE id = ? AND brand_id = ?").bind(campaign, b.id).first<{ audience: string }>() : null;
		const only: string[] = c ? (safeJson(c.audience)?.lists ?? []).filter((x: unknown) => typeof x === "string") : [];
		const names = only.length ? (await db.prepare("SELECT name FROM lists WHERE id IN (SELECT value FROM json_each(?)) AND brand_id = ?").bind(JSON.stringify(only), b.id).all<{ name: string }>()).results.map((r) => r.name) : [];
		const what = names.length ? names.join(", ") : b.name;
		if (request.method === "POST") {
			const was = (await db.prepare("SELECT list_id FROM memberships WHERE subscriber_id = ? AND status != 'unsubscribed'").bind(s.id).all<{ list_id: string }>()).results.map((r) => r.list_id).filter((x) => !only.length || only.includes(x));
			const changed = only.length
				? await db.prepare("UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE subscriber_id = ? AND status != 'unsubscribed' AND list_id IN (SELECT value FROM json_each(?))").bind(iso(), s.id, JSON.stringify(only)).run()
				: await db.prepare("UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE subscriber_id = ? AND status != 'unsubscribed'").bind(iso(), s.id).run();
			for (const id of was) await fireSafely(db, b.id, s.id, { kind: "unsubscribed", list: id });
			if (changed.meta.changes) await logEvent(db, b.id, "unsubscribed", s.id, campaign, `${request.headers.get("content-type")?.includes("form") && (await request.clone().text()).includes("One-Click") ? "one click" : "page"}${names.length ? `, ${names.join(", ")}` : ""}`).run();
			return html(publicPage(b, "Unsubscribed", `<div class="card"><h1>You've unsubscribed</h1><p>${esc(s.email)} won't get any more emails from ${esc(what)}.</p><p class="small">Changed your mind? You can sign up again on the website.</p></div>`));
		}
		return html(publicPage(b, "Unsubscribe", `<div class="card"><h1>Unsubscribe?</h1><p>Stop ${names.length ? "" : "all "}emails from ${esc(what)} to ${esc(s.email)}.</p><form method="post"><button type="submit">${ICON_X}Unsubscribe</button></form></div>`));
	}

	// -- Manage my subscription: change your name and which lists you're on ------------------------
	const pm = /^\/p\/([0-9a-f]{32}|test)\/?$/.exec(path);
	if (pm) {
		const s = pm[1] === "test" ? null : await db.prepare("SELECT * FROM subscribers WHERE token = ?").bind(pm[1]).first<SubscriberRow>();
		const b = s ? await db.prepare("SELECT * FROM brands WHERE id = ?").bind(s.brand_id).first<BrandRow>() : await db.prepare("SELECT * FROM brands LIMIT 1").first<BrandRow>();
		const brand = b ?? { name: "Newsletter", colour: "#a3195b", logo: null };
		if (pm[1] === "test") return html(publicPage(brand, "Manage your subscription", `<div class="card"><h1>This was a test email</h1><p>In a real email, this link lets the reader change their name and choose which lists they're on.</p></div>`));
		if (!s || !b) return html(publicPage(brand, "Manage your subscription", `<div class="card"><h1>We couldn't find you</h1><p>The link may be old. Use the newest email you have from us.</p></div>`), 404);
		const load = async () => (await db.prepare("SELECT l.id, l.name, l.description, m.status FROM memberships m JOIN lists l ON l.id = m.list_id WHERE m.subscriber_id = ? AND l.brand_id = ? ORDER BY l.name").bind(s.id, b.id).all<{ id: string; name: string; description: string | null; status: string }>()).results;
		let lists = await load();
		let note = "";
		if (request.method === "POST") {
			const f = await request.formData().catch(() => new FormData());
			const want = new Set(f.getAll("list").map(String));
			const name = String(f.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
			const now = iso();
			const stmts: D1PreparedStatement[] = [];
			if (name !== (s.name ?? "")) stmts.push(db.prepare("UPDATE subscribers SET name = ? WHERE id = ?").bind(name || null, s.id));
			for (const l of lists) {
				const on = l.status === "active" || l.status === "pending";
				if (on && !want.has(l.id)) {
					stmts.push(db.prepare("UPDATE memberships SET status = 'unsubscribed', left_at = ? WHERE list_id = ? AND subscriber_id = ?").bind(now, l.id, s.id));
					stmts.push(logEvent(db, b.id, "unsubscribed", s.id, null, `subscription page, ${l.name}`));
				} else if (!on && want.has(l.id) && !s.suppressed) {
					stmts.push(db.prepare("UPDATE memberships SET status = 'active', left_at = NULL, confirmed_at = COALESCE(confirmed_at, ?) WHERE list_id = ? AND subscriber_id = ?").bind(now, l.id, s.id));
					stmts.push(logEvent(db, b.id, "subscribed", s.id, null, `${l.name} (back, from the subscription page)`));
				}
			}
			if (stmts.length) await db.batch(stmts);
			for (const l of lists) {
				const on = l.status === "active" || l.status === "pending";
				if (on && !want.has(l.id)) await fireSafely(db, b.id, s.id, { kind: "unsubscribed", list: l.id });
				else if (!on && want.has(l.id) && !s.suppressed) await fireSafely(db, b.id, s.id, { kind: "joined", list: l.id });
			}
			s.name = name || null;
			lists = await load();
			note = `<p class="okmsg">${ICON_CHECK}Saved. Thanks for letting us know.</p>`;
		}
		const one = Boolean(b.one_list) && lists.length > 1;
		const row = (l: (typeof lists)[number]) => {
			const on = l.status === "active" || l.status === "pending";
			return `<label class="opt"><input type="${one ? "radio" : "checkbox"}" name="list" value="${esc(l.id)}" ${on ? "checked" : ""} ${s.suppressed && !on ? "disabled" : ""}><span><b>${esc(l.name)}</b>${l.description ? `<span class="small">${esc(l.description)}</span>` : ""}${l.status === "pending" ? `<span class="small">Waiting for you to confirm by email</span>` : ""}</span></label>`;
		};
		return html(publicPage(b, "Manage your subscription", `<div class="card"><h1>Your subscription</h1><p>For ${esc(s.email)}. Change anything you like, then press Save.</p>${note}
			<form method="post"><label for="n">Your name</label><input id="n" name="name" value="${esc(s.name ?? "")}" maxlength="80" autocomplete="name">
			<p style="margin:22px 0 8px;font-weight:600">${one ? "The list you'd like" : "The emails you'd like"}</p>${lists.map(row).join("")}${one ? `<label class="opt"><input type="radio" name="list" value=""><span><b>None</b></span></label>` : ""}
			${s.suppressed ? `<p class="small">We can't email this address at the moment (it bounced or was marked as spam), so lists can't be turned back on here.</p>` : ""}
			<div class="btns"><button type="submit">${ICON_CHECK}Save</button><a class="btn ghost" href="/u/${esc(s.token)}">${ICON_X}Unsubscribe from everything</a></div></form></div>`));
	}

	// -- Forward to a friend: the email on a page with share buttons, and a sign up button for the friend ---------------
	const fm = /^\/f\/(?:([0-9a-f]{16})\.([0-9a-f]{12})|test)\/?$/.exec(path);
	if (fm) {
		const owner = fm[1] ? await db.prepare("SELECT brand_id FROM campaigns WHERE id = ?").bind(fm[1]).first<{ brand_id: string }>() : null;
		const b = owner ? await db.prepare("SELECT * FROM brands WHERE id = ?").bind(owner.brand_id).first<BrandRow>() : await brandForHost(db, url);
		if (!b) return null;
		if (!fm[1]) return html(publicPage(b, "Forward to a friend", `<div class="card"><h1>This was a test email</h1><p>In a real email, this link opens a page where the reader can share the email with a friend, and the friend can sign up.</p></div>`));
		if ((await shareSig(await sealSecret(db), fm[1])) !== fm[2]) return null;
		const c = await db.prepare("SELECT * FROM campaigns WHERE id = ? AND brand_id = ? AND status IN ('sent', 'sending', 'paused')").bind(fm[1], b.id).first<CampaignRow>();
		if (!c) return null;
		const form = await db.prepare("SELECT slug FROM lists WHERE brand_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 1").bind(b.id, JSON.stringify(safeJson(c.audience)?.lists ?? [])).first<{ slug: string }>()
			?? await db.prepare("SELECT slug FROM lists WHERE brand_id = ? ORDER BY created_at LIMIT 1").bind(b.id).first<{ slug: string }>();
		const here = `${await origin(db, request)}${path}`;
		const subject = c.subject.replace(/\{\{[^}]*\}\}/g, "").replace(/\s+/g, " ").trim();
		const out = renderEmail(c.subject, campaignContent(c), { brandName: b.name, colour: b.colour, logo: b.logo, footer: b.footer, unsubscribeUrl: here, track: null }, { email: "" });
		const colour = /^#[0-9a-f]{6}$/i.test(b.colour) ? b.colour : "#a3195b";
		const ico = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:-4px;margin-right:6px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round" aria-hidden="true"><path d="${d}"/></svg>`;
		const btn = `display:inline-block;margin:4px;padding:10px 16px;border-radius:10px;font:600 15px system-ui,sans-serif;text-decoration:none`;
		const bar = `<div style="background:#fff;border-bottom:1px solid #efe2e9;padding:14px 16px;text-align:center;font:16px/1.5 system-ui,sans-serif;color:#1d1424">
			<b>${esc(b.name)}</b>: someone thought you'd like this.<br>
			${form ? `<a href="/s/${esc(form.slug)}" style="${btn};background:${colour};color:#fff">${ico("M12 5v14M5 12h14")}Subscribe</a>` : ""}<a href="mailto:?subject=${encodeURIComponent(subject)}&amp;body=${encodeURIComponent(`I thought you'd like this: ${here}`)}" style="${btn};background:#f3e8ee;color:${colour}">${ico("M3 6h18v12H3zM3 7l9 6 9-6")}Email it to a friend</a></div>`;
		const page = out.html.replace(/You're getting this because[^<]*<br>/, "").replace(/<a [^>]*>Unsubscribe<\/a>(\s*·\s*)?/, "").replace(/(<body[^>]*>)/i, `$1${bar}`);
		return html(page, 200, { "content-security-policy": "default-src 'none'; img-src * data:; style-src * 'unsafe-inline'; font-src * data:" });
	}

	// -- The archive as an RSS feed, so readers and other apps can follow new issues -----
	if (path === "/archive/feed.xml") {
		const b = await brandForHost(db, url);
		if (!b || !b.archive) return null;
		const base = await origin(db, request);
		const { results } = await db.prepare("SELECT subject, preheader, slug, started_at FROM campaigns WHERE brand_id = ? AND status IN ('sent', 'sending') AND public = 1 AND slug IS NOT NULL ORDER BY started_at DESC LIMIT 50").bind(b.id).all<CampaignRow>();
		const x = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
		const clean = (v: string) => v.replace(/\{\{[^}]*\}\}/g, "").replace(/\s+/g, " ").trim();
		const items = results.map((c) => `<item><title>${x(clean(c.subject))}</title><link>${x(`${base}/archive/${c.slug}`)}</link><guid>${x(`${base}/archive/${c.slug}`)}</guid><pubDate>${new Date(c.started_at!).toUTCString()}</pubDate>${c.preheader ? `<description>${x(clean(c.preheader))}</description>` : ""}</item>`).join("");
		const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${x(b.name || "Newsletter")}</title><link>${x(`${base}/archive`)}</link><atom:link href="${x(`${base}/archive/feed.xml`)}" rel="self" type="application/rss+xml"/><description>${x(`Past campaigns from ${b.name || "the newsletter"}`)}</description><language>en-gb</language>${items}</channel></rss>`;
		return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=600" } });
	}

	// -- The archive of past issues ------------------------------------------------------
	const am = /^\/archive(?:\/([a-z0-9-]{1,80}))?\/?$/.exec(path);
	if (am) {
		// An issue's own page belongs to its brand; the list of issues to the brand whose domain for links this is.
		const mine = am[1] ? await db.prepare("SELECT brand_id FROM campaigns WHERE slug = ?").bind(am[1]).first<{ brand_id: string }>() : null;
		const b = mine ? await db.prepare("SELECT * FROM brands WHERE id = ?").bind(mine.brand_id).first<BrandRow>() : await brandForHost(db, url);
		if (!b || !b.archive) return null;
		if (!am[1]) {
			const { results } = await db.prepare("SELECT subject, slug, started_at FROM campaigns WHERE brand_id = ? AND status IN ('sent', 'sending') AND public = 1 AND slug IS NOT NULL ORDER BY started_at DESC LIMIT 200").bind(b.id).all<CampaignRow>();
			const items = results.map((c) => `<li><a href="/archive/${esc(c.slug!)}">${esc(c.subject.replace(/\{\{[^}]*\}\}/g, "").trim())}</a><span>${new Date(c.started_at!).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</span></li>`).join("");
			const forms = (await db.prepare("SELECT slug, name FROM lists WHERE brand_id = ? ORDER BY created_at LIMIT 1").bind(b.id).first<{ slug: string; name: string }>());
			return html(publicPage(b, "Past campaigns", `<div class="card"><h1>Past campaigns</h1>${items ? `<ul class="issues">${items}</ul>` : "<p>Nothing here yet.</p>"}${forms ? `<a class="btn" href="/s/${esc(forms.slug)}">${ICON_SEND}Subscribe</a>` : ""}<p class="small" style="margin-top:16px"><a href="/archive/feed.xml">${ICON_RSS}Follow by RSS</a></p></div>`, { index: true }));
		}
		const c = await db.prepare("SELECT * FROM campaigns WHERE slug = ? AND brand_id = ? AND status IN ('sent', 'sending') AND public = 1").bind(am[1], b.id).first<CampaignRow>();
		if (!c) return null;
		const out = renderEmail(c.subject, campaignContent(c), { brandName: b.name, colour: b.colour, logo: b.logo, footer: b.footer, unsubscribeUrl: "/archive", track: null }, { email: "" });
		return html(out.html.replace("<title>", '<meta name="robots" content="index"><link rel="alternate" href="/archive"><title>').replace(/You're getting this because[^<]*<br>/, "").replace(/<a [^>]*>Unsubscribe<\/a>/, '<a href="/archive" style="color:#6b5a73">More campaigns</a>'), 200, { "content-security-policy": "default-src 'none'; img-src * data:; style-src * 'unsafe-inline'; font-src * data:" });
	}

	// -- Images -------------------------------------------------------------------------------
	const im = /^\/img\/([0-9a-f]{16}\.(?:png|jpe?g|gif|webp))$/.exec(path);
	if (im) {
		const obj = env.IMAGES ? await env.IMAGES.get(im[1]) : null;
		if (!obj) return new Response("Not found", { status: 404 });
		return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "image/png", "cache-control": "public, max-age=31536000, immutable" } });
	}

	// -- Opens and clicks (only in emails sent with them switched on) -------------------------------
	const om = /^\/o\/(\d+)\.([0-9a-f]{12})$/.exec(path);
	if (om) {
		if ((await sendSig(await sealSecret(db), Number(om[1]))) === om[2]) {
			const r = await db.prepare("UPDATE sends SET opened_at = COALESCE(opened_at, ?), opens = opens + 1, country = COALESCE(country, ?) WHERE id = ? RETURNING campaign_id, subscriber_id, opens").bind(iso(), countryOf(request), Number(om[1])).first<{ campaign_id: string; subscriber_id: string; opens: number }>();
			if (r && r.opens === 1) await fireForCampaign(db, r.campaign_id, r.subscriber_id, { kind: "opened", campaign: r.campaign_id });
		}
		return new Response(Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (ch) => ch.charCodeAt(0)), { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
	}
	const lm = /^\/l\/(\d+)\.([0-9a-f]{12})\/(\d{1,3})$/.exec(path);
	if (lm) {
		const id = Number(lm[1]);
		const send = await db.prepare("SELECT campaign_id, subscriber_id FROM sends WHERE id = ?").bind(id).first<{ campaign_id: string; subscriber_id: string }>();
		const link = send ? await db.prepare("SELECT url FROM links WHERE campaign_id = ? AND n = ?").bind(send.campaign_id, Number(lm[3])).first<{ url: string }>() : null;
		if (!link) return new Response("That link has expired.", { status: 404 });
		if ((await sendSig(await sealSecret(db), id)) === lm[2]) {
			await db.batch([
				db.prepare("UPDATE sends SET clicked_at = COALESCE(clicked_at, ?), opened_at = COALESCE(opened_at, ?), country = COALESCE(country, ?) WHERE id = ?").bind(iso(), iso(), countryOf(request), id),
				db.prepare("UPDATE links SET clicks = clicks + 1 WHERE campaign_id = ? AND n = ?").bind(send!.campaign_id, Number(lm[3])),
				db.prepare("INSERT INTO link_clicks (campaign_id, n, send_id, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(send!.campaign_id, Number(lm[3]), id, iso()),
			]);
			await fireForCampaign(db, send!.campaign_id, send!.subscriber_id, { kind: "clicked", campaign: send!.campaign_id, link: Number(lm[3]) });
		}
		return Response.redirect(link.url, 302);
	}

	// -- One click polls: the page records the answer itself, so link checkers that open every link in an email
	// (some workplaces do) don't vote. Without JavaScript there's a button. Clicking another answer changes it.
	const vm = /^\/v\/(\d+)\.([0-9a-f]{12})\/([a-z0-9]{4,12})\/(\d{1,2})$/.exec(path);
	if (vm) {
		const id = Number(vm[1]);
		const send = (await sendSig(await sealSecret(db), id)) === vm[2] ? await db.prepare("SELECT campaign_id, subscriber_id FROM sends WHERE id = ?").bind(id).first<{ campaign_id: string; subscriber_id: string }>() : null;
		const c = send ? await db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(send.campaign_id).first<CampaignRow>() : null;
		const b = c ? await db.prepare("SELECT * FROM brands WHERE id = ?").bind(c.brand_id).first<BrandRow>() : null;
		const poll = c ? pollsIn(c.html).find((p) => p.id === vm[3]) : null;
		const answer = poll?.answers.find((a) => a.n === Number(vm[4]));
		if (!send || !b || !poll || !answer) return html(publicPage(b ?? { name: "Newsletter", colour: "#a3195b", logo: null }, "Poll", `<div class="card"><h1>That poll has closed</h1><p>Thanks for wanting to answer, though.</p></div>`), 404);
		if (request.method === "POST") {
			await db.prepare("INSERT INTO poll_votes (campaign_id, poll, subscriber_id, answer, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (campaign_id, poll, subscriber_id) DO UPDATE SET answer = excluded.answer, at = excluded.at")
				.bind(send.campaign_id, poll.id, send.subscriber_id, answer.n, iso()).run();
			return html(publicPage(b, "Thanks", `<div class="card"><h1>Thanks, your answer is in</h1>${poll.question ? `<p>${esc(poll.question)}</p>` : ""}<p>You chose <b>${esc(answer.text)}</b>. Changed your mind? Click a different answer in the email.</p></div>`));
		}
		return html(publicPage(b, "Your answer", `<div class="card"><h1>Your answer</h1>${poll.question ? `<p>${esc(poll.question)}</p>` : ""}<p><b>${esc(answer.text)}</b></p><form method="post" id="vote"><button type="submit">${ICON_CHECK}That's my answer</button></form></div><script>document.getElementById("vote").submit()</script>`));
	}

	// -- Bounces and complaints from the sending services ------------------------------------------
	const hm = /^\/hooks\/(ses|postmark|mailgun|brevo|resend)\/([0-9a-f]{32})$/.exec(path);
	if (hm && request.method === "POST") {
		const b = await db.prepare("SELECT * FROM brands WHERE hook_key = ?").bind(hm[2]).first<BrandRow>();
		if (!b) return new Response("Not found", { status: 404 });
		const body = (await request.json().catch(() => null)) as any;
		if (hm[1] === "ses") {
			// Amazon SNS: confirm the subscription the set-up made, then pass on each SES event.
			if (body?.Type === "SubscriptionConfirmation" && trustedSubscribeUrl(body.SubscribeURL)) {
				await fetch(body.SubscribeURL);
				await logEvent(db, b.id, "sending.connected", null, null, "Amazon SES bounces and complaints connected").run();
				return new Response("OK");
			}
			if (body?.Type === "Notification") {
				const e = parseSesEvent(safeJson(body.Message));
				if (e) await recordMailEvent(db, b, e);
			}
			return new Response("OK");
		}
		if (isProvider(hm[1])) {
			const e = parseProviderEvent(hm[1], body);
			if (e) await recordMailEvent(db, b, e);
		}
		return new Response("OK");
	}
	return null;
}

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, accept" };

/** A bounce or complaint: count it against the campaign, and never email a hard bounce or a complaint again. */
export async function recordMailEvent(db: D1Database, b: BrandRow, e: MailEvent): Promise<void> {
	for (const address of e.addresses) {
		const s = e.sub ? await db.prepare("SELECT id, email FROM subscribers WHERE id = ? AND brand_id = ?").bind(e.sub, b.id).first<{ id: string; email: string }>() : await db.prepare("SELECT id, email FROM subscribers WHERE email = ? AND brand_id = ?").bind(address, b.id).first<{ id: string; email: string }>();
		if (!s) continue;
		const stmts = [logEvent(db, b.id, e.kind === "complaint" ? "complained" : e.permanent ? "bounced" : "soft_bounce", s.id, e.campaign ?? null, e.detail)];
		if (e.permanent) stmts.push(db.prepare("UPDATE subscribers SET suppressed = ?, suppressed_at = ? WHERE id = ? AND (suppressed IS NULL OR suppressed = 'bounced')").bind(e.kind === "complaint" ? "complained" : "bounced", iso(), s.id));
		await db.batch(stmts);
	}
	if (e.campaign && (e.permanent || e.kind === "complaint")) await checkCampaign(db, e.campaign);
}
