// SparkPost: sending, bounce and complaint events, and adding our webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addWebhook, parseProvider, parseProviderEvents, providerRequest, sendOne } from "../src/providers.ts";

const mail = { to: "jo@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>", headers: { "List-Unsubscribe": "<https://n.example/u/x>" }, tags: { ns_campaign: "abcdef12", ns_sub: "12345678" }, replyTo: "help@e.com" };
const HOOK = "https://news.example.com/hooks/sparkpost/abc";

test("SparkPost set up keeps the region", () => {
	assert.equal((parseProvider({ provider: "sparkpost", key: "abcdefghijklmnop", sparkpostRegion: "eu" }, "a@b.com") as any).sparkpostRegion, "eu");
});

test("SparkPost emails carry our headers and tags, with its own tracking off", () => {
	const r = providerRequest({ provider: "sparkpost", key: "spk" }, "Jo", "n@e.com", mail);
	assert.equal(r.url, "https://api.sparkpost.com/api/v1/transmissions");
	assert.equal((r.init.headers as any).authorization, "spk");
	const b = JSON.parse(String(r.init.body));
	assert.deepEqual(b.options, { open_tracking: false, click_tracking: false, transactional: false });
	assert.deepEqual(b.recipients, [{ address: { email: "jo@example.com" }, metadata: mail.tags }]);
	assert.deepEqual(b.content.from, { email: "n@e.com", name: "Jo" });
	assert.equal(b.content.reply_to, "help@e.com");
	assert.equal(b.content.headers["List-Unsubscribe"], "<https://n.example/u/x>");
	assert.match(providerRequest({ provider: "sparkpost", key: "k", sparkpostRegion: "eu" }, "Jo", "n@e.com", mail).url, /^https:\/\/api\.eu\.sparkpost\.com\//);
});

test("SparkPost's answer gives the id", async () => {
	const f = (async () => new Response(JSON.stringify({ results: { id: "tx1", total_accepted_recipients: 1 } }), { status: 200 })) as unknown as typeof fetch;
	assert.deepEqual(await sendOne({ provider: "sparkpost", key: "k" }, "Jo", "n@e.com", mail, f), { ok: true, id: "tx1" });
});

test("SparkPost events: hard and soft bounces by class, complaints, and the test ping", () => {
	const ev = (e: object) => ({ msys: { message_event: e } });
	const es = parseProviderEvents("sparkpost", [
		ev({ type: "bounce", bounce_class: "10", rcpt_to: "A@b.com", reason: "550 5.1.1 no such user", rcpt_meta: { ns_sub: "12345678", ns_campaign: "abcdef12" } }),
		ev({ type: "bounce", bounce_class: "21", rcpt_to: "c@d.com", reason: "452 mailbox full" }),
		ev({ type: "out_of_band", bounce_class: "30", rcpt_to: "e@f.com" }),
		ev({ type: "spam_complaint", rcpt_to: "g@h.com" }),
		ev({ type: "delivery", rcpt_to: "i@j.com" }),
		{ msys: {} },
	]);
	assert.equal(es.length, 4);
	assert.deepEqual(es[0], { kind: "bounce", permanent: true, addresses: ["a@b.com"], detail: "550 5.1.1 no such user", sub: "12345678", campaign: "abcdef12" });
	assert.equal(es[1].permanent, false);
	assert.equal(es[2].permanent, true);
	assert.equal(es[3].kind, "complaint");
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

test("SparkPost webhook: added once, for bounces and complaints", async () => {
	let { f, calls } = fake([[200, { results: [] }], [200, { results: { id: "w1" } }]]);
	assert.deepEqual(await addWebhook({ provider: "sparkpost", key: "k".repeat(20) }, HOOK, f), { ok: true });
	const b = JSON.parse(calls[1].body);
	assert.equal(b.target, HOOK);
	assert.deepEqual(b.events, ["bounce", "out_of_band", "spam_complaint"]);
	({ f, calls } = fake([[200, { results: [{ id: "w1", target: HOOK }] }]]));
	assert.deepEqual(await addWebhook({ provider: "sparkpost", key: "k".repeat(20) }, HOOK, f), { ok: true });
	assert.equal(calls.length, 1);
	({ f } = fake([[403, { errors: [{ message: "Forbidden" }] }]]));
	assert.match(((await addWebhook({ provider: "sparkpost", key: "k".repeat(20) }, HOOK, f)) as any).error, /Event Webhooks/);
});
