// We add our bounce and complaint webhook in the owner's sending service for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addWebhook, type ProviderConfig } from "../src/providers.ts";

const HOOK = "https://news.example.com/hooks/x/abc";
/** A fake service: answers each call from the list in turn and remembers what was asked. */
function fake(answers: [number, unknown][]) {
	const calls: { url: string; method: string; body: string }[] = [];
	const f = (async (url: string, init: RequestInit = {}) => {
		calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
		const [status, data] = answers.shift() ?? [500, {}];
		return new Response(typeof data === "string" ? data : JSON.stringify(data), { status });
	}) as unknown as typeof fetch;
	return { f, calls };
}

test("Postmark: asks to use our unsubscribe link, then adds a broadcast webhook for bounces, complaints and unsubscribes", async () => {
	const { f, calls } = fake([[422, { Message: "not approved" }], [200, { Webhooks: [] }], [200, { ID: 1 }]]);
	const r = await addWebhook({ provider: "postmark", key: "k".repeat(20) }, HOOK, f);
	assert.deepEqual(r, { ok: true });
	assert.equal(calls[0].method, "PATCH");
	assert.equal(JSON.parse(calls[0].body).SubscriptionManagementConfiguration.UnsubscribeHandlingType, "Custom");
	const b = JSON.parse(calls[2].body);
	assert.equal(b.Url, HOOK);
	assert.equal(b.MessageStream, "broadcast");
	assert.equal(b.Triggers.Bounce.Enabled, true);
	assert.equal(b.Triggers.SpamComplaint.Enabled, true);
	assert.equal(b.Triggers.SubscriptionChange.Enabled, true);
});

test("Postmark: brings ours up to date when it's already there", async () => {
	const { f, calls } = fake([[200, {}], [200, { Webhooks: [{ ID: 7, Url: HOOK }] }], [200, {}]]);
	assert.deepEqual(await addWebhook({ provider: "postmark", key: "k".repeat(20) }, HOOK, f), { ok: true });
	assert.equal(calls[2].method, "PUT");
	assert.match(calls[2].url, /\/webhooks\/7$/);
	assert.equal(JSON.parse(calls[2].body).Url, HOOK);
	assert.equal(JSON.parse(calls[2].body).Triggers.SubscriptionChange.Enabled, true);
});

test("Mailgun: keeps the owner's own webhook addresses and adds ours", async () => {
	const c: ProviderConfig = { provider: "mailgun", key: "k".repeat(20), mailgunDomain: "mg.example.com", mailgunRegion: "eu" };
	const { f, calls } = fake([[200, { webhooks: { permanent_fail: { urls: ["https://theirs.example/x"] } } }], [200, {}], [200, {}], [200, {}]]);
	assert.deepEqual(await addWebhook(c, HOOK, f), { ok: true });
	assert.match(calls[0].url, /^https:\/\/api\.eu\.mailgun\.net\/v3\/domains\/mg\.example\.com\/webhooks$/);
	assert.equal(calls[1].method, "PUT");
	assert.match(calls[1].url, /\/permanent_fail$/);
	assert.deepEqual(new URLSearchParams(calls[1].body).getAll("url"), ["https://theirs.example/x", HOOK]);
	assert.equal(calls[2].method, "POST");
	assert.equal(new URLSearchParams(calls[2].body).get("id"), "temporary_fail");
	assert.equal(new URLSearchParams(calls[3].body).get("id"), "complained");
});

test("Brevo: adds a transactional webhook", async () => {
	const { f, calls } = fake([[200, { webhooks: [] }], [201, { id: 5 }]]);
	assert.deepEqual(await addWebhook({ provider: "brevo", key: "k".repeat(20) }, HOOK, f), { ok: true });
	const b = JSON.parse(calls[1].body);
	assert.equal(b.type, "transactional");
	assert.deepEqual(b.events, ["hardBounce", "softBounce", "invalid", "spam"]);
});

test("Resend: a Sending access key can't, and we say so", async () => {
	const { f } = fake([[401, { name: "restricted_api_key" }]]);
	const r = await addWebhook({ provider: "resend", key: "k".repeat(20) }, HOOK, f);
	assert.ok("error" in r && /Full access/.test(r.error));
});

test("Resend: adds bounced and complained events", async () => {
	const { f, calls } = fake([[200, { data: [] }], [201, { id: "w" }]]);
	assert.deepEqual(await addWebhook({ provider: "resend", key: "k".repeat(20) }, HOOK, f), { ok: true });
	assert.deepEqual(JSON.parse(calls[1].body), { endpoint: HOOK, events: ["email.bounced", "email.complained"] });
});

test("Never throws when the service can't be reached", async () => {
	const f = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
	const r = await addWebhook({ provider: "brevo", key: "k".repeat(20) }, HOOK, f);
	assert.ok("error" in r && /offline/.test(r.error));
});
