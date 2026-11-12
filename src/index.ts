// Newsletter Sender: newsletters for solo writers, businesses and agencies, from your own Cloudflare account.
// Hosted on Cloudflare, sent with Amazon SES (or Postmark, Mailgun, Brevo, Resend, SendGrid, SparkPost or any SMTP server).
//
//   /                     the dashboard (set-up, sign in and the app are one page: ui.ts)
//   /api/*                its JSON (api.ts)
//   /api/v1/*             the public API, with keys made under Settings, API (v1.ts)
//   /s/<list>             sign up forms (public.ts), /c/<code> confirming, /u/<code> unsubscribing
//   /archive              past issues, when the archive is on
//   /img/*                pictures used in emails (R2)
//   /o/*, /l/*            opens and clicks, only when switched on
//   /hooks/<service>/*    bounces and spam complaints coming back from the sending service
//
// Every night from 2am UTC a backup of the database goes into the R2 bucket (backup.ts); the last 30 are kept.
//
// The queue (sending.ts) sends each campaign in batches at the sending service's full speed. Every minute the cron
// starts campaigns whose time has come.

import { runDue } from "./automations.ts";
import { backupIfDue } from "./backup.ts";
import { handleApi } from "./api.ts";
import { ensureSchema, type Env, type SendBatch } from "./db.ts";
import { handlePublic } from "./public.ts";
import { consume, resume, startDue } from "./sending.ts";
import { carryOnTomorrow } from "./warmup.ts";
import { checkFeedsDue } from "./blogfeed.ts";
import { installId } from "./settings.ts";
import { appPage } from "./ui.ts";
import { dispatchHooks, DOCS, handleV1 } from "./v1.ts";

import { VERSION } from "./update.ts";
import { checkLicenceIfDue } from "./agency/licence.ts";

const SECURITY = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
	const out = new Response(res.body, res);
	for (const [k, v] of Object.entries({ ...SECURITY, ...extra })) if (!out.headers.has(k)) out.headers.set(k, v);
	return out;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		if (!env.DB) return new Response("Newsletter Sender needs its D1 database: add a D1 binding called DB (see the README).", { status: 500 });
		await ensureSchema(env.DB);

		if (path === "/api/v1" || path.startsWith("/api/v1/")) {
			try {
				return withHeaders(await handleV1(request, env, url), { "x-frame-options": "DENY" });
			} catch (e) {
				console.error(e);
				return withHeaders(Response.json({ error: "Something went wrong on our side. Please try again.", docs: DOCS }, { status: 500 }));
			}
		}
		if (path.startsWith("/api/")) {
			try {
				return withHeaders(await handleApi(request, env, url), { "x-frame-options": url.pathname.endsWith("/preview") ? "SAMEORIGIN" : "DENY" });
			} catch (e) {
				console.error(e);
				return withHeaders(Response.json({ error: "Something went wrong on our side. Please try again." }, { status: 500 }));
			}
		}
		try {
			const pub = await handlePublic(request, env, url);
			if (pub) return withHeaders(pub);
		} catch (e) {
			console.error(e);
			return new Response("Something went wrong. Please try again in a moment.", { status: 500 });
		}
		if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
		if (["/", "/setup", "/signin"].includes(path)) {
			return withHeaders(new Response(appPage(VERSION), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }), { "x-frame-options": "DENY" });
		}
		if (path === "/.well-known/newsletter-sender") return new Response(await installId(env.DB), { headers: { "content-type": "text/plain", "cache-control": "no-store", "access-control-allow-origin": "*" } });
		if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\nAllow: /archive\nAllow: /s/\n", { headers: { "content-type": "text/plain" } });
		return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
	},

	async queue(batch: MessageBatch<SendBatch>, env: Env): Promise<void> {
		await ensureSchema(env.DB);
		await consume(batch, env);
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		await ensureSchema(env.DB);
		ctx.waitUntil(Promise.all([
			startDue(env),
			runDue(env).catch((e) => console.error("automations", e)),
			backupIfDue(env).catch((e) => console.error("backup", e)),
			dispatchHooks(env).catch((e) => console.error("webhooks", e)),
			// Domain warm up: campaigns paused at the day's number carry on the next day.
			carryOnTomorrow(env, resume).catch((e) => console.error("warm up", e)),
			// Blog posts to newsletter drafts: each blog's feed, once an hour.
			checkFeedsDue(env.DB).catch((e) => console.error("blog feeds", e)),
			// The agency licence's daily check with newslettersender.com (agency/licence.ts): only the licence id, the version and a short fingerprint of the key.
			checkLicenceIfDue(env.DB, VERSION).catch((e) => console.error("licence check", e)),
			// Sign up rate limits only matter for ten minutes.
			env.DB.prepare("DELETE FROM meta WHERE key LIKE 'rl:%' AND key < ?").bind(`rl:${Math.floor(Date.now() / 600_000) - 1}:`).run(),
		]));
	},
} satisfies ExportedHandler<Env, SendBatch>;
