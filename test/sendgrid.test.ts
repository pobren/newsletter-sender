// SendGrid: sending, bounce and complaint events, and adding our webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addWebhook, parseProvider, parseProviderEvents, providerRequest, sendOne } from "../src/providers.ts";

const mail = { to: "jo@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>", headers: { "List-Unsubscribe": "<https://n.example/u/x>" }, tags: { ns_campaign: "abcdef12", ns_sub: "12345678" }, replyTo: "help@e.com" };
const HOOK = "https://news.example.com/hooks/sendgrid/abc";

test("SendGrid set up keeps the region", () => {
	assert.equal((parseProvider({ provider: "sendgrid", key: "SG.abcdefghijklmnop", sendgridRegion: "eu" }, "a@b.com") as any).sendgridRegion, "eu");
	assert.equal((parseProvider({ provider: "sendgrid", key: "SG.abcdefghijklmnop" }, "a@b.com") as any).sendgridRegion, "us");
});

test("SendGrid emails carry our headers and tags, with SendGrid's own tracking off", () => {
	const r = providerRequest({ provider: "sendgrid", key: "SG.k" }, "Jo", "n@e.com", mail);
	assert.equal(r.url, "https://api.sendgrid.com/v3/mail/send");
	assert.equal((r.init.headers as any).authorization, "Bearer SG.k");
	const b = JSON.parse(String(r.init.body));
	assert.deepEqual(b.personalizations, [{ to: [{ email: "jo@example.com" }], custom_args: mail.tags }]);
	assert.deepEqual(b.from, { email: "n@e.com", name: "Jo" });
	assert.deepEqual(b.reply_to, { email: "help@e.com" });
	assert.equal(b.content[0].type, "text/plain");
	assert.equal(b.headers["List-Unsubscribe"], "<https://n.example/u/x>");
	assert.equal(b.tracking_settings.click_tracking.enable, false);
	assert.equal(b.tracking_settings.open_tracking.enable, false);
	assert.equal(b.tracking_settings.subscription_tracking.enable, false);
	assert.match(providerRequest({ provider: "sendgrid", key: "k", sendgridRegion: "eu" }, "Jo", "n@e.com", mail).url, /^https:\/\/api\.eu\.sendgrid\.com\//);
	assert.equal("headers" in JSON.parse(String(providerRequest({ provider: "sendgrid", key: "k" }, "Jo", "n@e.com", { ...mail, headers: {} }).init.body)), false);
});

test("SendGrid's 202 with no body counts as sent, with the id from the header", async () => {
	const f = (async () => new Response("", { status: 202, headers: { "x-message-id": "abc123" } })) as unknown as typeof fetch;
	assert.deepEqual(await sendOne({ provider: "sendgrid", key: "k" }, "Jo", "n@e.com", mail, f), { ok: true, id: "abc123" });
	const bad = (async () => new Response(JSON.stringify({ errors: [{ message: "Does not contain a valid address." }] }), { status: 400 })) as unknown as typeof fetch;
	assert.equal((await sendOne({ provider: "sendgrid", key: "k" }, "Jo", "n@e.com", mail, bad)).permanent, true);
});

test("SendGrid events: hard and soft bounces, complaints and drops, several in one post", () => {
	const es = parseProviderEvents("sendgrid", [
		{ event: "bounce", type: "bounce", email: "A@b.com", reason: "550 no such user", ns_sub: "12345678", ns_campaign: "abcdef12" },
		{ event: "bounce", type: "blocked", email: "c@d.com", reason: "421 try later" },
		{ event: "spamreport", email: "e@f.com" },
		{ event: "dropped", email: "g@h.com", reason: "Bounced Address" },
		{ event: "dropped", email: "i@j.com", reason: "Unsubscribed Address" },
		{ event: "delivered", email: "k@l.com" },
	]);
	assert.equal(es.length, 4);
	assert.deepEqual(es[0], { kind: "bounce", permanent: true, addresses: ["a@b.com"], detail: "550 no such user", sub: "12345678", campaign: "abcdef12" });
	assert.equal(es[1].permanent, false);
	assert.equal(es[2].kind, "complaint");
	assert.equal(es[3].permanent, true);
	assert.deepEqual(parseProviderEvents("sendgrid", { not: "a list" }), []);
	assert.equal(parseProviderEvents("brevo", { event: "hard_bounce", email: "a@b.com" }).length, 1);
});

function fake(answers: [number, unknown][]) {
	const calls: { url: string; method: string; body: string }[] = [];
	const f = (async (url: string, init: RequestInit = {}) => {
		calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
		const [status, data] = answers.shift() ?? [500, {}];
		return new Response(typeof data === "string" ? data : JSON.stringify(data), { status });
	}) as unknown as typeof fetch;
	return { f, calls };
}

test("SendGrid webhook: added alongside others, left alone when ours is there", async () => {
	let { f, calls } = fake([[200, { webhooks: [{ id: "w1", url: "https://other.example/x", enabled: true }] }], [201, { id: "w2" }]]);
	assert.deepEqual(await addWebhook({ provider: "sendgrid", key: "k".repeat(20) }, HOOK, f), { ok: true });
	assert.equal(calls[1].method, "POST");
	const b = JSON.parse(calls[1].body);
	assert.equal(b.url, HOOK);
	assert.equal(b.bounce && b.dropped && b.spam_report && b.enabled, true);
	assert.equal(b.open, false);
	({ f, calls } = fake([[200, { webhooks: [{ id: "w2", url: HOOK, enabled: true }] }]]));
	assert.deepEqual(await addWebhook({ provider: "sendgrid", key: "k".repeat(20) }, HOOK, f), { ok: true });
	assert.equal(calls.length, 1);
});

test("SendGrid webhook: a single webhook account is only taken over when it's empty", async () => {
	let { f, calls } = fake([[404, {}], [200, { url: "", enabled: false }], [200, {}]]);
	assert.deepEqual(await addWebhook({ provider: "sendgrid", key: "k".repeat(20) }, HOOK, f), { ok: true });
	assert.equal(calls[2].method, "PATCH");
	({ f } = fake([[404, {}], [200, { url: "https://other.example/x", enabled: true }]]));
	assert.ok("error" in (await addWebhook({ provider: "sendgrid", key: "k".repeat(20) }, HOOK, f)));
	({ f } = fake([[403, { errors: [{ message: "access forbidden" }] }]]));
	assert.match(((await addWebhook({ provider: "sendgrid", key: "k".repeat(20) }, HOOK, f)) as any).error, /Full Access/);
});
