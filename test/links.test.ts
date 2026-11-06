import { test } from "node:test";
import assert from "node:assert/strict";
import { addWorkerDomain, linksNameProblem, workerName } from "../src/cloudflare.ts";
import { linkBase } from "../src/db.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const T = "t".repeat(40);
const zone = { id: "z1", accountId: "a1" };

test("links use the brand's own domain when it has one", () => {
	assert.equal(linkBase({ track_domain: "https://news.example.com/" }, "https://app.example.workers.dev"), "https://news.example.com");
	assert.equal(linkBase({ track_domain: null }, "https://app.example.workers.dev"), "https://app.example.workers.dev");
});

test("finds this Worker's name from its workers.dev address or its custom domain", async () => {
	assert.equal(await workerName(T, "a1", "newsletter-sender.me-511.workers.dev", (async () => { throw new Error("no call"); }) as any), "newsletter-sender");
	const f = (async () => json({ success: true, result: [{ hostname: "app.example.com", service: "my-news" }] })) as typeof fetch;
	assert.equal(await workerName(T, "a1", "app.example.com", f), "my-news");
});

test("adds the custom domain, or says it's already there", async () => {
	const put: any[] = [];
	const f = (async (url: string, init: RequestInit) => {
		if (init.method === "GET") return json({ success: true, result: [] });
		put.push({ url, body: JSON.parse(String(init.body)) });
		return json({ success: true, result: {} });
	}) as typeof fetch;
	assert.deepEqual(await addWorkerDomain(T, zone, "news.example.com", "newsletter-sender", f), { ok: true, already: false });
	assert.equal(put[0].url, "https://api.cloudflare.com/client/v4/accounts/a1/workers/domains");
	assert.deepEqual(put[0].body, { hostname: "news.example.com", service: "newsletter-sender", zone_id: "z1", environment: "production" });
	const there = (async () => json({ success: true, result: [{ hostname: "news.example.com", service: "newsletter-sender" }] })) as typeof fetch;
	assert.deepEqual(await addWorkerDomain(T, zone, "news.example.com", "newsletter-sender", there), { ok: true, already: true });
});

test("asks for a better token when this one can't add Worker domains", async () => {
	const f = (async () => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403)) as typeof fetch;
	const r = await addWorkerDomain(T, zone, "news.example.com", "newsletter-sender", f);
	assert.ok("error" in r && r.token);
});

test("won't take a name another Worker already uses", async () => {
	const f = (async () => json({ success: true, result: [{ hostname: "news.example.com", service: "shop" }] })) as typeof fetch;
	const r = await addWorkerDomain(T, zone, "news.example.com", "newsletter-sender", f);
	assert.ok("error" in r && !r.token && r.error.includes("shop"));
});

test("never uses the main domain, www, mail or a name that's already in use for links", async () => {
	const z = { id: "z1", name: "example.co.uk" };
	const none = (async () => json({ success: true, result: [] })) as typeof fetch;
	const some = (async () => json({ success: true, result: [{ type: "A", name: "promo.example.co.uk" }] })) as typeof fetch;
	assert.match((await linksNameProblem(T, z, "example.co.uk", none))!, /main domain.*news\.example\.co\.uk/);
	assert.match((await linksNameProblem(T, z, "www.example.co.uk", none))!, /website or email/);
	assert.match((await linksNameProblem(T, z, "mail.example.co.uk", none))!, /website or email/);
	assert.match((await linksNameProblem(T, z, "promo.example.co.uk", some))!, /already in use/);
	assert.equal(await linksNameProblem(T, z, "news.example.co.uk", none), null);
});
