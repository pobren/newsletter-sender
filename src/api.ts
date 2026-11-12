// The dashboard's JSON. Everything here needs the owner signed in, apart from set-up and sign in.

import { install, latest, newer, RELEASES, undo, VERSION } from "./update.ts";
import { checkLicence, renewUrl } from "./agency/licence.ts";
import { cleanReferrals, parseReferrals } from "./referrals.ts";
import { checkPassword, clearCookie, clearFailures, currentAccount, hashPassword, noteFailure, passwordProblem, sessionCookie, setupCodeMatches, setupTokenOk, signOutEverywhere, tooManyTries } from "./auth.ts";
import { cleanEmail, cleanTag, csvLine, fieldKey } from "./csv.ts";
import { cleanHookUrl, deliver, DOCS, EVENTS, listHooks, listKeys, makeHook, makeKey, MAX_HOOKS, MAX_KEYS } from "./v1.ts";
import { addon } from "./addon.ts";
import { bad, body, freeSlug, multi, ok, str } from "./kit.ts";
import { copyToS3, s3Keys, s3Status } from "./s3.ts";
import { finishUpload, getBackup, KEEP, timed, listBackups, makeBackup, restoreBackup, startUpload, uploadPart } from "./backup.ts";
import { accountById, firstBrand, getMeta, iso, setMeta, logEvent, newId, origin, type AccountRow, type BrandRow, type CampaignRow, type Env, type ListRow } from "./db.ts";
import { cleanKeep, forgetKept, getKeep, KEEP_CHOICES, keptOne, olderThan, saveKeep, withKept, type Kept } from "./retention.ts";
import { cleanCold, getCold, GRACE_DAYS, lookCold, removeCold, saveCold, tagCold } from "./cold.ts";
import { AiError, aiUse, DAILY_CAP, getAi, saveAi, TASKS, write } from "./aihelper.ts";
import { cleanSegment, deleteSegment, forLists, getSegments, saveSegment } from "./segments.ts";
import { cleanGoodbye, DEFAULT_TEXT, getGoodbye, saveGoodbye } from "./goodbye.ts";
import { getFeed, makeDraft, readFeed, saveFeed } from "./blogfeed.ts";
import { FIRSTS, getWarmup, saveWarmup, today, warmupStatus } from "./warmup.ts";
import { addWebhook, isProvider, parseProvider, PROVIDERS, providerName, providerSummary, sendOne, sesKeys } from "./providers.ts";
import { formHtml, oneOff, signUp } from "./public.ts";
import { blocksToHtml, cleanBlocks, renderEmail, sanitise, slugify } from "./render.ts";
import { audienceCount, campaignContent, DEFAULT_RATE, parseAudience, pause, resume, safeJson, sendTest, sendTime, start } from "./sending.ts";
import { ALGS, b64url, checkClientData, keyUsable, newChallenge, passkeyName, takeChallenge, unb64url, verifyAssertion, type PasskeyRow } from "./passkeys.ts";
import { canSendFrom, installId, linksToken, ownLinksToken, loadProvider, saveLinksToken, saveProvider, sesRecords, sesSetup, sesStatus, setUpSes } from "./settings.ts";
import { sesAccount } from "./aws.ts";
import { brandHealth } from "./health.ts";
import { cleanSteps, cleanTrigger, newAutomationId } from "./automations.ts";
import { inlineStyleSheets } from "./pagecss.ts";
import { addWorkerDomain, canAddWorkerDomains, listZones, linksNameProblem, dnsHost, findZone, LINKS_TOKEN_URL, TOKEN_URL, workerName } from "./cloudflare.ts";
import { ROBOT_ERROR, turnstileKey, turnstileOk } from "./turnstile.ts";
import { checkEmail } from "./check.ts";
import { pollsIn } from "./polls.ts";
import { abResults, cleanAb, parseAb, winnerOf } from "./abtest.ts";
import { importStatus, mailchimp, pastDate } from "./move.ts";

const DEFAULT_BRAND = "My newsletter";

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
		const existing = await db.prepare("SELECT * FROM accounts WHERE role = 'owner' ORDER BY created_at LIMIT 1").first<AccountRow>();
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
		const pk = await db.prepare("SELECT 1 FROM passkeys WHERE account_id = ? AND rp_id = ? LIMIT 1").bind(a.id, url.hostname).first();
		return ok({ ok: true, passkeyHere: Boolean(pk) }, { headers: { "set-cookie": await sessionCookie(db, a, secure) } });
	}
	// -- Passkeys: signing in without a password ---------------------------------------------------
	if (path === "/api/passkey/signin-options" && method === "POST") {
		return ok({ challenge: await newChallenge(db, "signin"), rpId: url.hostname });
	}
	if (path === "/api/passkey/signin" && method === "POST") {
		const b = await body(request);
		const fail = (m: string) => bad(m, 401);
		try {
			const clientData = unb64url(String(b.clientDataJSON ?? ""));
			const cd = checkClientData(clientData, "webauthn.get", url.origin);
			if ("error" in cd) return fail(cd.error);
			if (!(await takeChallenge(db, cd.challenge, "signin"))) return fail("That passkey prompt ran out of time. Please try again.");
			const pk = await db.prepare("SELECT * FROM passkeys WHERE id = ? AND rp_id = ?").bind(String(b.id ?? ""), url.hostname).first<PasskeyRow>();
			if (!pk) return fail("We don't know that passkey here. Sign in with your password, then add it in Settings, Account.");
			const r = await verifyAssertion({ publicKey: unb64url(pk.public_key), alg: pk.alg, rpId: pk.rp_id, authenticatorData: unb64url(String(b.authenticatorData ?? "")), clientDataJSON: clientData, signature: unb64url(String(b.signature ?? "")), storedCount: pk.sign_count });
			if ("error" in r) return fail(r.error);
			const a = await accountById(db, pk.account_id);
			if (!a) return fail("That passkey's account has gone.");
			await db.prepare("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").bind(r.count, iso(), pk.id).run();
			return ok({ ok: true }, { headers: { "set-cookie": await sessionCookie(db, a, secure) } });
		} catch {
			return fail("That passkey reply couldn't be read. Please try again.");
		}
	}
	// The agency edition's routes that work before signing in (a client's invite link).
	const early = await addon.open(request, env, url);
	if (early) return early;
	if (path === "/api/signout" && method === "POST") return ok({ ok: true }, { headers: { "set-cookie": clearCookie(secure) } });

	const me = await currentAccount(request, db);
	if (!me) return bad("Please sign in.", 401);
	// Only this app's own pages may change things.
	if (method !== "GET" && request.headers.get("origin") && request.headers.get("origin") !== url.origin) return bad("Not allowed from another website.", 403);
	const brands = await addon.brandsFor(db, me);
	if (!brands.length) return bad(me.role === "client" ? "Your login can't open a brand here. Please ask the owner." : "Please finish setting up first.", 409);
	const brand = addon.pickBrand(request, brands);
	const can = addon.can(me);
	const refused = addon.refuse(me, path, method);
	if (refused) return bad(refused, 403);
	await origin(db, request);

	// More brands, client logins and every brand at a glance come from the agency edition.
	const extra = await addon.api({ request, env, url, path, method, secure, me, brands, brand });
	if (extra) return extra;
	// -- Who's signed in, and which brands they can open ----------------------------------------
	if (path === "/api/brands" && method === "GET") {
		return ok({ brands: brands.map((b) => ({ id: b.id, name: b.name })), current: brand.id, role: me.role, can, me: { name: me.name, email: me.email }, edition: addon.edition });
	}

	// -- Updates (update.ts): the owner installs a new version with one press, or goes back -----------------
	if (path.startsWith("/api/update")) {
		if (me.role !== "owner") return bad("Only the owner can update Newsletter Sender.", 403);
		const status = async (fresh = false) => {
			const rel = await latest(db, fresh);
			// An agency licence's updates date, so the page can warn before installing a version it doesn't cover.
			const key = await getMeta(db, "agency_licence");
			const c = key ? await checkLicence(key) : null;
			return { version: VERSION, latest: rel && newer(rel.version, VERSION) ? rel : null, last: JSON.parse((await getMeta(db, "update_last")) ?? "null"), releases: RELEASES, updates: c?.ok ? c.licence.updates : null, renew: renewUrl(c?.ok ? c.licence.id : "") };
		};
		if (path === "/api/update" && method === "GET") return ok(await status(url.searchParams.has("check")));
		if (path === "/api/update/install" && method === "POST") {
			const rel = await latest(db, true);
			if (!rel || !newer(rel.version, VERSION)) return bad("You're already on the newest version.");
			const r = await install(db, url.hostname, rel);
			if ("error" in r) return bad(r.error);
			await logEvent(db, brand.id, "update", null, null, `Updated from ${VERSION} to ${rel.version}`).run();
			return ok({ version: rel.version });
		}
		if (path === "/api/update/undo" && method === "POST") {
			const r = await undo(db, url.hostname);
			if ("error" in r) return bad(r.error);
			await logEvent(db, brand.id, "update", null, null, `Went back to ${r.version}`).run();
			return ok({ version: r.version });
		}
	}

	// -- Your account: password and passkeys --------------------------------------------------------
	if (path === "/api/account" && method === "GET") {
		const keys = (await db.prepare("SELECT id, name, rp_id, created_at, last_used_at FROM passkeys WHERE account_id = ? ORDER BY created_at").bind(me.id).all<PasskeyRow>()).results;
		return ok({ email: me.email, name: me.name, passkeys: keys.map((k) => ({ id: k.id, name: k.name, created_at: k.created_at, last_used_at: k.last_used_at, here: k.rp_id === url.hostname, site: k.rp_id })) });
	}
	if (path === "/api/account/password" && method === "POST") {
		const b = await body(request);
		if (!me.password || typeof b.current !== "string" || !(await checkPassword(b.current, me.password))) return bad("Your current password isn't right.");
		const problem = passwordProblem(b.password);
		if (problem) return bad(problem);
		await db.prepare("UPDATE accounts SET password = ?, session_ver = session_ver + 1 WHERE id = ?").bind(await hashPassword(b.password), me.id).run();
		// Every other device is signed out; this one stays signed in.
		return ok({ ok: true }, { headers: { "set-cookie": await sessionCookie(db, { id: me.id, session_ver: me.session_ver + 1 }, secure) } });
	}
	if (path === "/api/passkey/add-options" && method === "POST") {
		const have = (await db.prepare("SELECT id FROM passkeys WHERE account_id = ? AND rp_id = ?").bind(me.id, url.hostname).all<{ id: string }>()).results;
		return ok({ challenge: await newChallenge(db, "add", me.id), rpId: url.hostname, rpName: brand.app_name || "Newsletter Sender", user: { id: b64url(new TextEncoder().encode(me.id)), name: me.email, displayName: me.name || me.email }, exclude: have.map((k) => k.id), algs: ALGS });
	}
	if (path === "/api/passkey/add" && method === "POST") {
		const b = await body(request);
		try {
			const cd = checkClientData(unb64url(String(b.clientDataJSON ?? "")), "webauthn.create", url.origin);
			if ("error" in cd) return bad(cd.error);
			if (!(await takeChallenge(db, cd.challenge, "add", me.id))) return bad("That passkey prompt ran out of time. Please try again.");
			const id = String(b.id ?? "");
			const alg = Number(b.alg);
			const key = unb64url(String(b.publicKey ?? ""));
			if (!/^[A-Za-z0-9_-]{16,1400}$/.test(id)) return bad("That passkey's ID couldn't be read.");
			if (!ALGS.includes(alg) || !(await keyUsable(key, alg))) return bad("This device made a kind of passkey we can't use yet. Please try another device or browser.");
			const count = (await db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?").bind(me.id).first<{ n: number }>())!.n;
			if (count >= 20) return bad("You already have 20 passkeys. Please remove one first.");
			const name = str(b.name, 60) || passkeyName(request.headers.get("user-agent"));
			await db.prepare("INSERT INTO passkeys (id, account_id, name, public_key, alg, rp_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING").bind(id, me.id, name, b64url(key), alg, url.hostname, iso()).run();
			return ok({ ok: true, name });
		} catch {
			return bad("That passkey reply couldn't be read. Please try again.");
		}
	}
	const pkm = /^\/api\/passkey\/([A-Za-z0-9_-]{16,1400})$/.exec(path);
	if (pkm && method === "DELETE") {
		await db.prepare("DELETE FROM passkeys WHERE id = ? AND account_id = ?").bind(pkm[1], me.id).run();
		return ok();
	}
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
			if ("track_opens" in b) Object.assign(set, { track_opens: b.track_opens ? 1 : 0, track_clicks: b.track_clicks ? 1 : 0 });
			if ("track_domain" in b) {
				let domain: string | null = null;
				if (typeof b.track_domain === "string" && b.track_domain.trim()) {
					const d = b.track_domain.trim().replace(/\/+$/, "");
					const u = /^https?:\/\//i.test(d) ? d : `https://${d}`;
					if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(u)) return bad("Your domain for links should be a web address you've added to this Worker, such as news.yourdomain.com.");
					domain = u.toLowerCase();
				}
				set.track_domain = domain;
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
				const r = await sendOne(c, brand.from_name, brand.from_email, { to: me.email, subject: "Newsletter Sender is connected", text: `This test came through ${providerName(c.provider)}. Your newsletters will go out the same way.\n`, html: `<p>This test came through ${providerName(c.provider)}. Your newsletters will go out the same way.</p>`, headers: {} });
				if (!r.ok) return bad(`The test email didn't go: ${r.error}`);
			}
			// Add our bounce and complaint webhook in their account for them. If we can't, the page shows the address to add.
			let hook: { ok: true } | { error: string } | null = null;
			if (c.provider !== "ses" && c.provider !== "smtp") {
				hook = await addWebhook(c, `${base}/hooks/${c.provider}/${brand.hook_key}`);
				c.hookAdded = "ok" in hook;
			}
			await saveProvider(db, brand.id, c, rate);
			return ok({ ok: true, rate, hook: hook && "error" in hook ? hook.error : null });
		}
		const setup = await sesSetup(db, brand.id);
		return ok({
			sending: providerSummary(provider),
			rate: brand.rate,
			fromEmail: brand.from_email,
			hooks: Object.fromEntries(PROVIDERS.map(({ id }) => [id, `${base}/hooks/${id}/${brand.hook_key}`])),
			ses: setup ? { ...setup, records: sesRecords(setup.domain, setup.tokens, setup.region) } : null,
			cloudflareEmail: Boolean(env.EMAIL),
		});
	}
	// Domain warm up (Settings, Sending): a small number of emails a day at first, growing each day.
	if (path === "/api/sending/warmup") {
		if (method === "POST") {
			const b = await body(request);
			const w = await getWarmup(db, brand.id);
			if (b.on === true) {
				const first = FIRSTS.includes(Number(b.first)) ? Number(b.first) : 50;
				await saveWarmup(db, brand.id, { on: true, start: w?.on ? w.start : today(), first, waiting: w?.waiting ?? [] });
			} else if (w) await saveWarmup(db, brand.id, { ...w, on: false, done: false });
		}
		return ok(await warmupStatus(db, brand.id));
	}
	// Open and click log retention (Settings, Tracking).
	if (path === "/api/retention") {
		if (method === "POST") await saveKeep(db, brand.id, cleanKeep((await body(request))?.days));
		const days = await getKeep(db, brand.id);
		const look = cleanKeep(url.searchParams.get("days") ?? days);
		return ok({ days, choices: KEEP_CHOICES, older: await olderThan(db, brand.id, look), look });
	}
	// Cold contact clean up (Settings, Lists).
	if (path === "/api/cold") {
		if (method === "POST") await saveCold(db, brand.id, cleanCold(await body(request)));
		const policy = await getCold(db, brand.id);
		const look = cleanCold({ days: url.searchParams.get("days") ?? policy.days, min: url.searchParams.get("min") ?? policy.min });
		return ok({ policy, look: await lookCold(db, brand.id, look), graceDays: GRACE_DAYS, tracking: { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) } });
	}
	if ((path === "/api/cold/tag" || path === "/api/cold/remove") && method === "POST") {
		const p = cleanCold(await body(request));
		if (path === "/api/cold/tag") return ok(await tagCold(db, brand.id, p));
		return ok({ removed: await removeCold(db, brand.id, p, { afterGrace: false }) });
	}
	// The writing helper (Settings, Writing helper; used in the campaign editor). Off unless switched on.
	if (path === "/api/ai") {
		if (method === "POST") await saveAi(db, brand.id, (await body(request))?.on === true);
		return ok({ ...(await getAi(db, brand.id)), ready: Boolean(env.AI), used: await aiUse(db, brand.id), cap: DAILY_CAP });
	}
	if (path === "/api/ai/write" && method === "POST") {
		const b = await body(request);
		if (!(TASKS as readonly string[]).includes(b?.task)) return bad("Choose what the helper should do.");
		try {
			return ok({ result: await write(env, brand, b.task, typeof b.text === "string" ? b.text : "") });
		} catch (e) {
			if (e instanceof AiError) return bad(e.message);
			throw e;
		}
	}
	// Saved segments: named audience filters to pick when setting up a campaign.
	if (path === "/api/segments") {
		const own = (await db.prepare("SELECT id FROM lists WHERE brand_id = ?").bind(brand.id).all<{ id: string }>()).results.map((r) => r.id);
		if (method === "POST") {
			const s = cleanSegment(await body(request));
			if (!s) return bad("Give the segment a name, and choose at least one list, tag or recent activity.");
			try {
				const seg = await saveSegment(db, brand.id, { ...s, audience: { ...s.audience, lists: s.audience.lists.filter((id) => own.includes(id)) } });
				return ok({ segment: seg, segments: await getSegments(db, brand.id) });
			} catch (e) {
				return bad((e as Error).message);
			}
		}
		if (method === "DELETE") {
			const id = url.searchParams.get("id") ?? "";
			await deleteSegment(db, brand.id, id);
		}
		return ok({ segments: (await getSegments(db, brand.id)).map((s) => ({ ...s, audience: forLists(s, own) })) });
	}
	// The goodbye email with a one click way back (Settings, Lists).
	if (path === "/api/goodbye") {
		if (method === "POST") await saveGoodbye(db, brand.id, cleanGoodbye(await body(request)));
		return ok({ ...(await getGoodbye(db, brand.id)), defaultText: DEFAULT_TEXT });
	}
	// Blog posts to newsletter drafts (Settings, Blog posts).
	if (path === "/api/blogfeed") {
		const f = await getFeed(db, brand.id);
		if (method === "DELETE") {
			await saveFeed(db, brand.id, null);
			return ok();
		}
		if (method === "POST") {
			const b = await body(request);
			const own = new Set((await db.prepare("SELECT id FROM lists WHERE brand_id = ?").bind(brand.id).all<{ id: string }>()).results.map((r) => r.id));
			const lists = (Array.isArray(b.lists) ? b.lists : f?.lists ?? []).filter((x: unknown) => typeof x === "string" && own.has(x)).slice(0, 50);
			if (b.on === false && f) {
				await saveFeed(db, brand.id, { ...f, on: false, lists });
				return ok({ feed: { ...f, on: false, lists, seen: undefined } });
			}
			let url = String(b.url ?? f?.url ?? "").trim();
			if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
			try {
				const u = new URL(url);
				if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw new Error();
			} catch {
				return bad("Please enter your blog's address, or its feed, such as https://yourblog.com/feed.");
			}
			const r = await readFeed(url);
			if ("error" in r) return bad(r.error);
			const same = f && f.url === r.feedUrl;
			const next = { url: r.feedUrl, on: true, lists, seen: same ? f.seen : r.posts.map((p) => p.id).slice(0, 100), checked_at: iso(), error: null, made: f?.made ?? 0 };
			await saveFeed(db, brand.id, next);
			return ok({ feed: { ...next, seen: undefined }, latest: r.posts.slice(0, 3) });
		}
		return ok({ feed: f ? { ...f, seen: undefined } : null });
	}
	// A draft from the newest post now, to see what they look like.
	if (path === "/api/blogfeed/draft" && method === "POST") {
		const f = await getFeed(db, brand.id);
		if (!f) return bad("Please add your blog first.");
		const r = await readFeed(f.url);
		if ("error" in r) return bad(r.error);
		if (!r.posts[0]?.link) return bad("Your blog's feed has no posts yet.");
		return ok({ id: await makeDraft(db, brand, f, r.posts[0]) });
	}
	// Try adding the bounce webhook again (Settings, Sending), say after the owner swapped to a Full access key.
	if (path === "/api/sending/webhook" && method === "POST") {
		const p = await loadProvider(db, brand);
		if (!p || p.provider === "ses" || p.provider === "smtp") return bad("Please save your sending service first.");
		const r = await addWebhook(p, `${await origin(db, request)}/hooks/${p.provider}/${brand.hook_key}`);
		if ("error" in r) return bad(r.error);
		await saveProvider(db, brand.id, { ...p, hookAdded: true }, brand.rate);
		return ok();
	}
	// A Cloudflare token so we can add the Amazon SES DNS records ourselves.
	if (path === "/api/sending/dns-host") {
		const r = await dnsHost(brand.from_email.split("@")[1]);
		return "error" in r ? bad(r.error) : ok(r);
	}
	// The domains in your Cloudflare account, for choosing this app's own address in the setup wizard.
	if (path === "/api/cloudflare/zones" && method === "GET") {
		const t = await linksToken(db, brand);
		return ok({ zones: t ? await listZones(t) : [] });
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
	// Backups (Settings, Backups): the list, one now, download, and putting one back.
	if (path === "/api/backups") {
		if (method === "POST") {
			try {
				const now = new Date();
				return ok(await makeBackup(env, now, timed("by-hand", now)));
			} catch (e) {
				return bad((e as Error).message);
			}
		}
		const keys = await s3Keys(env);
		return ok({ backups: await listBackups(env), keep: KEEP, error: await getMeta(db, "backup_error"), bucket: Boolean(env.IMAGES), s3: keys ? { region: keys.region, last: await s3Status(env) } : null });
	}
	// Copy the newest backup to the owner's Amazon S3 now (it happens each night by itself too).
	if (path === "/api/backups/s3" && method === "POST") {
		const newest = (await listBackups(env))[0];
		if (!newest) return bad("There's no backup to copy yet. Press Back up now first.");
		const r = await copyToS3(env, newest.name, await s3Keys(env));
		await setMeta(db, "backup_s3", JSON.stringify(r));
		return ok(r);
	}
	if (path === "/api/backups/download") {
		const name = url.searchParams.get("name") ?? "";
		const obj = await getBackup(env, name);
		if (!obj) return bad("That backup has gone.", 404);
		return new Response(obj.body, { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
	}
	// Restore from a file: the page sends the file in 8 MB parts (start, part, part..., finish), then we check it and
	// put it back like any other backup.
	if (path === "/api/backups/upload/start" && method === "POST") {
		const r = await startUpload(env);
		return "error" in r ? bad(r.error) : ok(r);
	}
	if (path === "/api/backups/upload/part" && method === "PUT") {
		const r = await uploadPart(env, url.searchParams.get("name") ?? "", url.searchParams.get("id") ?? "", Number(url.searchParams.get("n")), await request.arrayBuffer());
		return "error" in r ? bad(r.error) : ok({ partNumber: r.partNumber, etag: r.etag });
	}
	if (path === "/api/backups/upload/finish" && method === "POST") {
		const b = await body(request);
		const name = String(b.name ?? "");
		const checked = await finishUpload(env, name, String(b.id ?? ""), b.parts as R2UploadedPart[]);
		if ("error" in checked) return bad(checked.error);
		try {
			const r = await restoreBackup(env, name);
			return "error" in r ? bad(r.error) : ok({ ...r, name });
		} catch (e) {
			return bad(`The restore stopped part way: ${(e as Error).message}. Your backup from just before is in the list, so you can put that back.`);
		}
	}
	if (path === "/api/backups/restore" && method === "POST") {
		const b = await body(request);
		if (b.confirm !== true) return bad("Please confirm first.");
		try {
			const r = await restoreBackup(env, String(b.name ?? ""));
			return "error" in r ? bad(r.error) : ok(r);
		} catch (e) {
			return bad(`The restore stopped part way: ${(e as Error).message}. Your backup from just before is in the list, so you can put that back.`);
		}
	}
	// Your own domain for links: every link in your emails (unsubscribe, view online, opens and clicks) uses it.
	if (path === "/api/links") {
		const host = brand.track_domain ? new URL(brand.track_domain).hostname : null;
		if (method === "DELETE") {
			await db.prepare("UPDATE brands SET track_domain = NULL WHERE id = ?").bind(brand.id).run();
			return ok();
		}
		if (method === "POST") {
			const b = await body(request);
			const hostname = String(b.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
			if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname) || hostname.split(".").length < 3) return bad("Please enter a subdomain of your website, such as news.yourdomain.com.");
			if (hostname === url.hostname) return bad("That's this app's own address. Please choose a new name, such as news.yourdomain.com.");
			let token = typeof b.token === "string" ? b.token.trim() : "";
			if (token && (token.length < 20 || token.length > 200 || /\s/.test(token))) return bad("Please paste the whole Cloudflare token, with no spaces.");
			if (!token) token = (await linksToken(db, brand)) ?? "";
			if (!token) return bad("Please make a Cloudflare token first, with the Make a Cloudflare token button.", 409);
			const zone = await findZone(token, hostname);
			if ("error" in zone) return bad(zone.error);
			if (!zone.accountId) return bad("Cloudflare didn't tell us which account that domain is in. Please try again.");
			const problem = await linksNameProblem(token, zone, hostname);
			if (problem) return bad(problem);
			const service = await workerName(token, zone.accountId, url.hostname);
			const r = await addWorkerDomain(token, zone, hostname, service);
			if ("error" in r) return r.token ? Response.json({ error: r.error, needToken: true }, { status: 409 }) : bad(r.error);
			if (b.token) await saveLinksToken(db, brand.id, token);
			await db.prepare("UPDATE brands SET track_domain = ? WHERE id = ?").bind(`https://${hostname}`, brand.id).run();
			return ok({ ok: true, domain: hostname, already: r.already });
		}
		if (url.searchParams.has("check")) {
			if (!host) return ok({ live: false, message: "No domain for links yet." });
			const want = await installId(db);
			const got = await fetch(`https://${host}/.well-known/newsletter-sender`, { cf: { cacheTtl: 0 } } as RequestInit).then((r) => (r.ok ? r.text() : ""), () => "");
			// A Worker can't always reach its own custom domain, so the page checks from the browser too (want).
			return ok(got.trim() === want ? { live: true, message: `${host} is working. Every link in your emails now uses it.` } : { live: false, host, want, message: `Waiting for ${host}. Cloudflare usually takes a minute or two to make the certificate.` });
		}
		// A saved links token works; the token from the Amazon SES wizard only counts if it can add Worker custom domains.
		const linksTokenWorks = async () => {
			if (await ownLinksToken(db, brand)) return true;
			const t = (await loadProvider(db, brand))?.cfToken;
			const domain = (brand.from_email ?? "").split("@")[1];
			return Boolean(t && domain && (await canAddWorkerDomains(t, domain)));
		};
		return ok({ domain: host, hasToken: await linksTokenWorks(), tokenUrl: LINKS_TOKEN_URL, appHost: url.hostname, suggest: `news.${(brand.from_email ?? "").split("@")[1] || "yourdomain.com"}` });
	}
	// The public API's keys and webhooks (Settings, API).
	if (path === "/api/developer" && method === "GET") {
		return ok({ keys: await listKeys(db, brand.id), hooks: await listHooks(db, brand.id), events: EVENTS, docs: DOCS, base: `${url.origin}/api/v1`, maxKeys: MAX_KEYS, maxHooks: MAX_HOOKS });
	}
	if (path === "/api/developer/keys" && method === "POST") {
		const r = await makeKey(db, brand.id, str((await body(request)).name, 60));
		return "error" in r ? bad(r.error) : ok(r);
	}
	const dk = /^\/api\/developer\/keys\/([0-9a-f]{16})$/.exec(path);
	if (dk && method === "DELETE") {
		await db.prepare("DELETE FROM api_keys WHERE id = ? AND brand_id = ?").bind(dk[1], brand.id).run();
		return ok();
	}
	if (path === "/api/developer/hooks" && method === "POST") {
		const b = await body(request);
		const hookUrl = cleanHookUrl(b.url);
		if (!hookUrl) return bad("Please enter the full https:// address that should get the events.");
		const r = await makeHook(db, brand.id, hookUrl, Array.isArray(b.events) ? b.events.map(String) : []);
		return "error" in r ? bad(r.error) : ok(r);
	}
	const dh = /^\/api\/developer\/hooks\/([0-9a-f]{16})(\/test|\/on)?$/.exec(path);
	if (dh) {
		const h = await db.prepare("SELECT * FROM webhooks WHERE id = ? AND brand_id = ?").bind(dh[1], brand.id).first<any>();
		if (!h) return bad("That webhook has gone.", 404);
		if (!dh[2] && method === "DELETE") {
			await db.prepare("DELETE FROM webhooks WHERE id = ?").bind(h.id).run();
			return ok();
		}
		if (dh[2] === "/on" && method === "POST") {
			await db.prepare("UPDATE webhooks SET active = 1, failures = 0 WHERE id = ?").bind(h.id).run();
			return ok();
		}
		if (dh[2] === "/test" && method === "POST") {
			const status = await deliver(db, h, "test", { message: "This is a test from Newsletter Sender." });
			return ok({ status, ok: status >= 200 && status < 300 });
		}
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
			db.prepare("DELETE FROM referral_rewards WHERE list_id = ? AND EXISTS (SELECT 1 FROM lists WHERE id = ? AND brand_id = ?)").bind(ld[1], ld[1], brand.id),
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
			await db.batch([db.prepare("DELETE FROM memberships WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM sends WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM events WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM poll_votes WHERE subscriber_id = ?").bind(s.id), db.prepare("DELETE FROM referral_rewards WHERE subscriber_id = ?").bind(s.id), db.prepare("UPDATE memberships SET referred_by = NULL WHERE referred_by = ?").bind(s.id), db.prepare("DELETE FROM subscribers WHERE id = ?").bind(s.id)]);
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
		const counts = { active: 0, unsubscribed: 0, bounced: 0, complained: 0 };
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
			const status = importStatus(r.status);
			const joined = pastDate(r.joined) ?? now;
			counts[status]++;
			stmts.push(
				db.prepare(`INSERT INTO subscribers (id, brand_id, email, name, fields, tags, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (brand_id, email) DO UPDATE SET name = COALESCE(excluded.name, subscribers.name), fields = json_patch(subscribers.fields, excluded.fields),
					tags = (SELECT json_group_array(DISTINCT value) FROM (SELECT value FROM json_each(subscribers.tags) UNION SELECT value FROM json_each(excluded.tags)))`)
					.bind(id, brand.id, email, str(r.name, 120) || null, JSON.stringify(fields), JSON.stringify(tags), newId(16), joined),
			);
			added++;
			if (status === "unsubscribed") {
				// Someone who left the old service stays left here, so they're never mailed by mistake.
				stmts.push(db.prepare(`INSERT INTO memberships (list_id, subscriber_id, status, source, created_at, left_at)
					SELECT ?1, s.id, 'unsubscribed', 'import', ?2, ?3 FROM subscribers s WHERE s.brand_id = ?4 AND s.email = ?5
					ON CONFLICT (list_id, subscriber_id) DO UPDATE SET status = 'unsubscribed', left_at = COALESCE(memberships.left_at, excluded.left_at)`).bind(l.id, joined, now, brand.id, email));
				continue;
			}
			if (status !== "active") {
				// Bounced or marked as spam on the old service: keep them on the list (so the counts match) but never send to them.
				stmts.push(
					db.prepare("UPDATE subscribers SET suppressed = ?, suppressed_at = ? WHERE brand_id = ? AND email = ? AND (suppressed IS NULL OR suppressed = 'bounced')").bind(status, now, brand.id, email),
					db.prepare(`INSERT INTO memberships (list_id, subscriber_id, status, source, created_at, confirmed_at)
						SELECT ?1, s.id, 'active', 'import', ?2, ?2 FROM subscribers s WHERE s.brand_id = ?3 AND s.email = ?4 ON CONFLICT (list_id, subscriber_id) DO NOTHING`).bind(l.id, joined, brand.id, email),
				);
				continue;
			}
			stmts.push(
				// Never re-add someone who unsubscribed (from any list, or this one when unsubscribing is per list), bounced or complained.
				// With one list per person, someone already on another list stays where they are.
				db.prepare(`INSERT INTO memberships (list_id, subscriber_id, status, source, created_at, confirmed_at)
					SELECT ?1, s.id, 'active', 'import', ?2, ?2 FROM subscribers s WHERE s.brand_id = ?3 AND s.email = ?4 AND s.suppressed IS NULL
					AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.status = 'unsubscribed' AND (?5 = 'all' OR m.list_id = ?1))
					AND NOT EXISTS (SELECT 1 FROM blocklist b WHERE b.brand_id = ?3 AND b.email = s.email) AND NOT EXISTS (SELECT 1 FROM blocked_domains d WHERE d.brand_id = ?3 AND d.domain = substr(s.email, instr(s.email, '@') + 1))
					AND NOT (?6 = 1 AND EXISTS (SELECT 1 FROM memberships m WHERE m.subscriber_id = s.id AND m.list_id != ?1 AND m.status IN ('active', 'pending')))
					ON CONFLICT (list_id, subscriber_id) DO NOTHING`)
					.bind(l.id, joined, brand.id, email, brand.unsub_scope, brand.one_list),
			);
		}
		for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
		if (added) await logEvent(db, brand.id, "imported", null, null, `${added} into ${l.name}`).run();
		return ok({ added, skipped, counts });
	}
	if (path === "/api/move/mailchimp" && method === "POST") {
		const b = await body(request);
		const r = await mailchimp(String(b.key ?? ""), b.audience ? String(b.audience) : null, Number(b.offset) || 0);
		return r.error ? bad(r.error) : ok(r);
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
			FROM campaigns c WHERE c.brand_id = ? ORDER BY COALESCE(c.started_at, c.send_at, c.updated_at) DESC LIMIT 500`).bind(brand.id).all<any>();
		return ok({ campaigns: await withKept(db, results), tracking: { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) } });
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
		if (await keptOne(db, c.id)) return bad("Who opened and clicked this campaign was cleared, as set under Settings, Tracking. The totals are still in the report.");
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
	const cm = /^\/api\/campaigns\/([0-9a-f]{16})(?:\/(test|send|schedule|unschedule|cancel|pause|resume|duplicate|resend|check|preview))?$/.exec(path);
	if (cm) {
		const c = await db.prepare("SELECT * FROM campaigns WHERE id = ? AND brand_id = ?").bind(cm[1], brand.id).first<CampaignRow>();
		if (!c) return bad("That email has gone.", 404);
		const action = cm[2];
		const editable = c.status === "draft" || c.status === "scheduled";
		if (!action && method === "GET") {
			const stats = await campaignStats(db, c.id);
			const kept = await keptOne(db, c.id);
			const links = kept ? (brand.track_clicks ? kept.links : []) : brand.track_clicks ? (await db.prepare("SELECT l.n, l.url, l.clicks, (SELECT COUNT(*) FROM link_clicks k WHERE k.campaign_id = l.campaign_id AND k.n = l.n) AS people FROM links l WHERE l.campaign_id = ? ORDER BY people DESC, l.clicks DESC LIMIT 50").bind(c.id).all()).results : [];
			const countries = kept ? (brand.track_opens || brand.track_clicks ? kept.countries : []) : brand.track_opens || brand.track_clicks ? (await db.prepare("SELECT country, COUNT(*) AS n FROM sends WHERE campaign_id = ? AND country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 10").bind(c.id).all()).results : [];
			const paused = c.status === "paused" ? await db.prepare("SELECT detail FROM events WHERE campaign_id = ? AND kind = 'campaign.paused' ORDER BY id DESC LIMIT 1").bind(c.id).first<{ detail: string }>() : null;
			const base = await origin(db, request);
			const polls = pollsIn(c.html);
			const votes = polls.length ? (await db.prepare("SELECT poll, answer, COUNT(*) AS n FROM poll_votes WHERE campaign_id = ? GROUP BY poll, answer").bind(c.id).all<{ poll: string; answer: number; n: number }>()).results : [];
			const pollResults = polls.map((p) => ({ ...p, answers: p.answers.map((a) => ({ ...a, votes: votes.find((v) => v.poll === p.id && v.answer === a.n)?.n ?? 0 })) }));
			const aud = parseAudience(c.audience);
			const resendOf = aud.resend ? await db.prepare("SELECT id, COALESCE(name, subject) AS name FROM campaigns WHERE id = ? AND brand_id = ?").bind(aud.resend.campaign, brand.id).first() : null;
			const ab = parseAb(c.ab);
			const abOut = ab && { subject: ab.b, pct: ab.pct, hours: ab.hours, by: ab.by, at: ab.at ?? null, winner: ab.winner ?? null, results: ab.bTo != null ? await abResults(db, c, ab) : null };
			if (abOut?.results && !abOut.winner && abOut.results.a[ab!.by] + abOut.results.b[ab!.by] > 0) (abOut as any).leading = winnerOf(abOut.results, ab!.by);
			return ok({ ...c, cleared: Boolean(kept), ab: abOut, resendOf, polls: pollResults, blocks: undefined, html: c.html ?? blocksToHtml(cleanBlocks(safeJson(c.blocks)), brand.colour), audience: parseAudience(c.audience), stats, links, countries, pausedWhy: paused?.detail ?? null, defaults: { from_name: brand.from_name, from_email: brand.from_email, reply_to: brand.reply_to }, tracking: { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) }, colour: brand.colour, webUrl: brand.archive && c.public && c.slug && !editable ? `${base}/archive/${c.slug}` : null });
		}
		if (!action && method === "POST") {
			if (!editable) return bad("This email has been sent, so it can't be changed. Duplicate it to make a new one.");
			const b = await body(request);
			const slug = b.slug ? slugify(String(b.slug)) : slugify(str(b.subject, 200));
			const clash = await db.prepare("SELECT id FROM campaigns WHERE slug = ? AND id != ?").bind(slug, c.id).first();
			const html = typeof b.html === "string" ? sanitise(b.html.slice(0, 500_000)) : c.html;
			// From name, address and Reply to: blank means "use Settings".
			const own = (v: string | null | undefined, d: string | null) => (v && v !== d ? v : null);
			const ab = cleanAb(b.ab, { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) });
			await db.prepare("UPDATE campaigns SET from_name = ?, from_email = ?, reply_to = ?, ab = ? WHERE id = ?")
				.bind(own(str(b.from_name, 80), brand.from_name), own(cleanEmail(b.from_email), brand.from_email), own(cleanEmail(b.reply_to), brand.reply_to), ab ? JSON.stringify(ab) : null, c.id).run();
			await db.prepare("UPDATE campaigns SET name = ?, subject = ?, preheader = ?, html = ?, audience = ?, public = ?, slug = ?, updated_at = ? WHERE id = ?")
				.bind(str(b.name, 120) || null, str(b.subject, 200) || "Untitled email", str(b.preheader, 200) || null, html, JSON.stringify(parseAudience(b.audience)), b.public === false ? 0 : 1, clash ? `${slug}-${c.id.slice(0, 4)}` : slug, iso(), c.id).run();
			return ok();
		}
		if (!action && method === "DELETE") {
			if (c.status === "sending") return bad("This one is sending. Stop it first, then delete it.");
			await db.batch([db.prepare("DELETE FROM sends WHERE campaign_id = ?").bind(c.id), db.prepare("DELETE FROM links WHERE campaign_id = ?").bind(c.id), db.prepare("DELETE FROM poll_votes WHERE campaign_id = ?").bind(c.id), forgetKept(db, c.id), db.prepare("DELETE FROM campaigns WHERE id = ?").bind(c.id)]);
			return ok();
		}
		if (action === "preview") {
			const base = await origin(db, request);
			const out = renderEmail(c.subject, campaignContent(c), { brandName: brand.name, colour: brand.colour, logo: brand.logo, footer: brand.footer, preheader: c.preheader, unsubscribeUrl: `${base}/u/test`, manageUrl: `${base}/p/test`, forwardUrl: `${base}/f/test`, referralUrl: `${base}/r/test`, footerLinks: brand.footer_links, webUrl: null, track: null }, { email: me.email, name: me.name });
			return new Response(out.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": EMAIL_CSP } });
		}
		if (method !== "POST") return bad("Not found.", 404);
		const b = await body(request);
		if (action === "check") return ok({ items: await checkEmail({ subject: c.subject, preheader: c.preheader, content: campaignContent(c), colour: brand.colour, brandName: brand.name }) });
		if (action === "test") {
			const provider = await loadProvider(db, brand);
			if (!provider) return bad("Please choose how to send first, under Settings, Sending.");
			const to = (Array.isArray(b.to) ? b.to : String(b.to ?? me.email).split(/[,\s]+/)).map(cleanEmail).filter((e): e is string => !!e).slice(0, 5);
			if (!to.length) return bad("Please enter an address to send the test to.");
			// Testing two subject lines: a test of each, so you see both in your inbox.
			const subjects = [c.subject, ...(parseAb(c.ab) ? [parseAb(c.ab)!.b] : [])];
			const res = [];
			for (const subject of subjects) res.push(...(await sendTest(env, brand, provider, { subject, preheader: c.preheader, content: campaignContent(c), from_name: c.from_name, from_email: c.from_email, reply_to: c.reply_to }, to, { email: me.email, name: me.name })));
			const failed = res.find((r) => !r.ok);
			return failed ? bad(`The test didn't go: ${failed.error}`) : ok({ sent: to.length });
		}
		if (action === "send" || action === "schedule" || action === "resume") {
			const stop = await addon.beforeSend(db, me, brand, c, action);
			if (stop) return bad(stop);
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
		if (action === "resend") {
			if (c.status !== "sent") return bad("You can send again once this one has finished sending.");
			if (!brand.track_opens) return bad("Switch on opens under Settings, Tracking first, so we know who didn't open it.");
			const id = newId(8);
			const audience = { ...parseAudience(c.audience), activity: null, resend: { campaign: c.id } };
			await db.prepare("INSERT INTO campaigns (id, brand_id, name, subject, preheader, blocks, html, audience, from_name, from_email, reply_to, public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").bind(id, brand.id, `${c.name || c.subject} (didn't open)`, c.subject, c.preheader, c.blocks, c.html, JSON.stringify(audience), c.from_name ?? null, c.from_email ?? null, c.reply_to ?? null, iso(), iso()).run();
			return ok({ id });
		}
		if (action === "duplicate") {
			const id = newId(8);
			const ab = parseAb(c.ab);
			const abCopy = ab ? JSON.stringify({ b: ab.b, pct: ab.pct, hours: ab.hours, by: ab.by }) : null;
			await db.prepare("INSERT INTO campaigns (id, brand_id, name, subject, preheader, blocks, html, audience, from_name, from_email, reply_to, ab, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, brand.id, `${c.name || c.subject} (copy)`, c.subject, c.preheader, c.blocks, c.html, c.audience, c.from_name ?? null, c.from_email ?? null, c.reply_to ?? null, abCopy, iso(), iso()).run();
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
		return ok({ html: sanitise(await inlineStyleSheets(fixed, u)), title: /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text)?.[1]?.trim() ?? "" });
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

	// -- Referrals: switch them on, set the rewards, and see who's brought the most friends ---------------
	const rf = /^\/api\/lists\/([0-9a-f]{16})\/referrals$/.exec(path);
	if (rf) {
		const l = await db.prepare("SELECT * FROM lists WHERE id = ? AND brand_id = ?").bind(rf[1], brand.id).first<ListRow>();
		if (!l) return bad("That list has gone.", 404);
		if (method === "POST") {
			const r = cleanReferrals(await body(request));
			if (r.on && !r.rewards.length) return bad("Please add at least one reward, or switch referrals off.");
			await db.prepare("UPDATE lists SET referrals = ? WHERE id = ?").bind(JSON.stringify(r), l.id).run();
			return ok(r);
		}
		const [total, sent, top] = await db.batch([
			db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE list_id = ? AND referred_by IS NOT NULL AND status = 'active'").bind(l.id),
			db.prepare("SELECT COUNT(*) AS n FROM referral_rewards WHERE list_id = ?").bind(l.id),
			db.prepare(`SELECT s.id, s.email, s.name, COUNT(*) AS n FROM memberships m JOIN subscribers s ON s.id = m.referred_by
				WHERE m.list_id = ? AND m.status = 'active' AND m.referred_by IS NOT NULL GROUP BY s.id ORDER BY n DESC, s.email LIMIT 20`).bind(l.id),
		]);
		return ok({ settings: parseReferrals(l.referrals), double_optin: Boolean(l.double_optin), referred: (total.results[0] as any)?.n ?? 0, rewards_sent: (sent.results[0] as any)?.n ?? 0, top: top.results });
	}

	// -- Reports ---------------------------------------------------------------------------------------
	if (path === "/api/reports/growth") {
		// Everyone who was ever on the brand's lists (or one list): when they joined, and when they left or bounced.
		// Each person is counted once, so the running total ends exactly at today's subscriber count.
		const days = [30, 90, 365].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 90;
		const list = url.searchParams.get("list");
		const one = list && /^[0-9a-f]{8,40}$/.test(list) ? list : null;
		const { results } = await db.prepare(`WITH p AS (SELECT s.suppressed, substr(s.suppressed_at, 1, 10) AS sd, MIN(substr(COALESCE(m.confirmed_at, m.created_at), 1, 10)) AS jd,
				MAX(m.status = 'active') AS act, MAX(substr(m.left_at, 1, 10)) AS ld
				FROM subscribers s JOIN memberships m ON m.subscriber_id = s.id JOIN lists l ON l.id = m.list_id
				WHERE l.brand_id = ? ${one ? "AND l.id = ?" : ""} AND m.status != 'pending' GROUP BY s.id)
			SELECT jd AS d, 'joined' AS k, COUNT(*) AS n FROM p GROUP BY jd
			UNION ALL SELECT COALESCE(sd, jd), 'lost', COUNT(*) FROM p WHERE suppressed IS NOT NULL GROUP BY COALESCE(sd, jd)
			UNION ALL SELECT COALESCE(ld, jd), 'left', COUNT(*) FROM p WHERE suppressed IS NULL AND act = 0 GROUP BY COALESCE(ld, jd)`).bind(brand.id, ...(one ? [one] : [])).all<{ d: string; k: "joined" | "lost" | "left"; n: number }>();
		const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
		let total = 0;
		const by = new Map<string, number>();
		for (const r of results) {
			if (r.d < from) total += r.k === "joined" ? r.n : -r.n;
			else by.set(`${r.d}|${r.k}`, (by.get(`${r.d}|${r.k}`) ?? 0) + r.n);
		}
		const out: { d: string; total: number; joined: number; left: number; lost: number }[] = [];
		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
			const day = { d, total: 0, joined: by.get(`${d}|joined`) ?? 0, left: by.get(`${d}|left`) ?? 0, lost: by.get(`${d}|lost`) ?? 0 };
			total += day.joined - day.left - day.lost;
			out.push({ ...day, total });
		}
		return ok({ days: out });
	}
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
		return ok({ emails: await withKept(db, emails.results as any[]), problems: problems.results, tracking: { opens: Boolean(brand.track_opens), clicks: Boolean(brand.track_clicks) } });
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
	// Older than the newsletter's retention: the rows are gone, so use the totals saved before they went.
	const kept = await keptOne(db, id);
	if (kept) return kept.stats as unknown as Awaited<ReturnType<typeof countStats>>;
	return countStats(db, id);
}

/** A campaign's totals, links and countries, saved before its per-person rows are cleared (retention.ts). */
export async function reportTotals(db: D1Database, id: string): Promise<Omit<Kept, "cleared_at">> {
	const [stats, links, countries] = await Promise.all([
		countStats(db, id),
		db.prepare("SELECT l.n, l.url, l.clicks, (SELECT COUNT(*) FROM link_clicks k WHERE k.campaign_id = l.campaign_id AND k.n = l.n) AS people FROM links l WHERE l.campaign_id = ? ORDER BY people DESC, l.clicks DESC LIMIT 50").bind(id).all<any>(),
		db.prepare("SELECT country, COUNT(*) AS n FROM sends WHERE campaign_id = ? AND country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 10").bind(id).all<any>(),
	]);
	return { stats, links: links.results, countries: countries.results };
}

async function countStats(db: D1Database, id: string) {
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
