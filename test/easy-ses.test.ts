import { test } from "node:test";
import assert from "node:assert/strict";
import { addRecords, findZone } from "../src/cloudflare.ts";
import { askForProduction, sesRecords } from "../src/settings.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const keys = { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "secretsecretsecret", region: "eu-west-1" };

test("finds the Cloudflare zone from a subdomain upwards", async () => {
	const asked: string[] = [];
	const f = (async (url: string) => {
		asked.push(new URL(url).searchParams.get("name")!);
		return json({ success: true, result: url.includes("name=example.co.uk") ? [{ id: "z1", name: "example.co.uk" }] : [] });
	}) as typeof fetch;
	assert.deepEqual(await findZone("t".repeat(40), "news.example.co.uk", f), { id: "z1", name: "example.co.uk" });
	assert.deepEqual(asked, ["news.example.co.uk", "example.co.uk"]);
	const none = await findZone("t".repeat(40), "other.com", (async () => json({ success: true, result: [] })) as typeof fetch);
	assert.ok("error" in none);
});

test("adds SES records unproxied, keeps an existing DMARC record and counts repeats", async () => {
	const made: any[] = [];
	const f = (async (url: string, init: RequestInit) => {
		if (init.method === "GET") return json({ success: true, result: [{ content: "v=DMARC1; p=quarantine" }] });
		const b = JSON.parse(String(init.body));
		made.push(b);
		if (b.type === "TXT" && b.name.startsWith("bounce")) return json({ success: false, errors: [{ code: 81058, message: "An identical record already exists." }] }, 400);
		return json({ success: true, result: {} });
	}) as typeof fetch;
	const r = await addRecords("t".repeat(40), "z1", sesRecords("example.com", ["a", "b", "c"], "eu-west-1"), f);
	assert.deepEqual(r, { added: 4, there: 2, failed: [] });
	assert.ok(made.filter((x) => x.type === "CNAME").every((x) => x.proxied === false));
	assert.equal(made.find((x) => x.type === "MX").priority, 10);
	assert.ok(!made.some((x) => x.name.startsWith("_dmarc")));
});

test("asks Amazon for production access only when still in the sandbox", async () => {
	const calls: { method: string; url: string; body: any }[] = [];
	const sandbox = (async (url: string, init: RequestInit) => {
		calls.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : null });
		return init.method === "GET" ? json({ ProductionAccessEnabled: false }) : json({});
	}) as typeof fetch;
	const r = await askForProduction(keys, { name: "Thursday Fun" }, "example.com", sandbox);
	assert.ok("step" in r && /Asked Amazon/.test(r.step));
	const put = calls.find((c) => c.method === "POST")!;
	assert.match(put.url, /\/v2\/email\/account\/details$/);
	assert.equal(put.body.MailType, "MARKETING");
	assert.equal(put.body.WebsiteURL, "https://example.com");
	assert.equal(put.body.ProductionAccessEnabled, true);
	assert.match(put.body.UseCaseDescription, /Thursday Fun/);

	const live = (async () => json({ ProductionAccessEnabled: true })) as typeof fetch;
	const r2 = await askForProduction(keys, { name: "x" }, "example.com", live);
	assert.ok("step" in r2 && /already send to anyone/.test(r2.step));
});

test("counts a domain Amazon already has as there, from the error header", async () => {
	const { alreadyThere, ses } = await import("../src/aws.ts");
	const f = (async () => new Response(JSON.stringify({ message: "Email identity example.com already exist." }), { status: 400, headers: { "x-amzn-ErrorType": "AlreadyExistsException:http://internal.amazon.com/coral/com.amazonaws.sesv2/" } })) as typeof fetch;
	assert.ok(alreadyThere(await ses(keys, "POST", "/identities", { EmailIdentity: "example.com" }, f)));
	const other = (async () => new Response(JSON.stringify({ message: "Nope" }), { status: 400, headers: { "x-amzn-ErrorType": "BadRequestException" } })) as typeof fetch;
	assert.ok(!alreadyThere(await ses(keys, "POST", "/identities", { EmailIdentity: "example.com" }, other)));
});

test("spots a domain on Cloudflare from its nameservers, walking up from a subdomain", async () => {
	const { dnsHost } = await import("../src/cloudflare.ts");
	const f = (async (url: string) => {
		const name = new URL(url).searchParams.get("name");
		const answer = name === "example.co.uk" ? [{ type: 2, data: "ada.ns.cloudflare.com." }, { type: 2, data: "bob.ns.cloudflare.com." }] : [];
		return json({ Status: 0, Answer: answer });
	}) as typeof fetch;
	const r = await dnsHost("news.example.co.uk", f);
	assert.ok(!("error" in r) && r.cloudflare && r.zone === "example.co.uk");
	const g = (async () => json({ Status: 0, Answer: [{ type: 2, data: "ns01.domaincontrol.com." }] })) as typeof fetch;
	const r2 = await dnsHost("example.com", g);
	assert.ok(!("error" in r2) && !r2.cloudflare && r2.host === "GoDaddy");
});
