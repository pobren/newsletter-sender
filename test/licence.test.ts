import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { askLicence, CHECK_URL, checkLicence, covers, GRACE_DAYS, notCovered, statusAllows } from "../src/agency/licence.ts";

// A key pair just for these tests, so the real signing key never has to be here.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url");
// Makes a key the way the licensor's tools do: "NSA-" + base64url JSON + "." + an Ed25519 signature.
const make = (to: string, brands = "0", until = "", updates?: string) => {
	const text = Buffer.from(JSON.stringify({ v: 1, id: randomBytes(6).toString("hex"), to, brands: Number(brands), until: until || null, ...(updates === undefined ? {} : { updates }), at: "2026-11-06" })).toString("base64url");
	return `NSA-${text}.${sign(null, Buffer.from(text), privateKey).toString("base64url")}`;
};

test("a good key works, and says who it's for", async () => {
	const key = make("Acme Agency", "10");
	const c = await checkLicence(key, "2026-11-06", pub);
	assert.ok(c.ok);
	assert.equal(c.ok && c.licence.to, "Acme Agency");
	assert.equal(c.ok && c.licence.brands, 10);
	// Pasted with line breaks or spaces, it still works.
	assert.ok((await checkLicence(` ${key.slice(0, 30)}\n${key.slice(30)} `, "2026-11-06", pub)).ok);
});

test("a changed key, someone else's key or rubbish doesn't", async () => {
	const key = make("Acme Agency", "10");
	const [head, sig] = key.slice(4).split(".");
	const more = Buffer.from(Buffer.from(head, "base64url").toString().replace('"brands":10', '"brands":0')).toString("base64url");
	assert.equal((await checkLicence(`NSA-${more}.${sig}`, "2026-11-06", pub)).ok, false);
	assert.equal((await checkLicence(key, "2026-11-06")).ok, false); // signed with a different key from the app's
	assert.equal((await checkLicence("hello", "2026-11-06", pub)).ok, false);
	assert.equal((await checkLicence(null, "2026-11-06", pub)).ok, false);
});

test("a key with an end date stops after it", async () => {
	const key = make("Short Ltd", "3", "2026-12-31");
	assert.ok((await checkLicence(key, "2026-12-31", pub)).ok);
	const c = await checkLicence(key, "2027-01-01", pub);
	assert.equal(c.ok, false);
	assert.match(!c.ok ? c.error : "", /ended on 2026-12-31/);
});

test("the daily check: cancelled stops it, and newslettersender.com being away is fine for 7 days", () => {
	const now = Date.parse("2026-11-20T12:00:00Z");
	const day = 86_400_000;
	const at = (n: number) => new Date(now - n * day).toISOString();
	assert.equal(GRACE_DAYS, 7);
	assert.equal(statusAllows(null, now), true); // no check yet
	assert.equal(statusAllows({ status: "active", ok_at: at(1), next_at: at(0) }, now), true);
	assert.equal(statusAllows({ status: "unknown", ok_at: at(6.9), next_at: at(0) }, now), true);
	assert.equal(statusAllows({ status: "active", ok_at: at(7.1), next_at: at(0) }, now), false);
	assert.equal(statusAllows({ status: "cancelled", ok_at: at(0), next_at: at(0) }, now), false);
});

test("the daily check sends only the licence id and the version", async () => {
	let asked = "";
	const answer = (body: object, status = 200) => (async (url: string) => { asked = url; return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
	assert.deepEqual(await askLicence("f15b243b205c", "0.3.0", answer({ status: "active" })), { status: "active" });
	assert.equal(asked, `${CHECK_URL}?id=f15b243b205c&v=0.3.0`);
	assert.deepEqual(await askLicence("f15b243b205c", "0.3.0", answer({ status: "cancelled", message: "Cancelled: fraud" })), { status: "cancelled", message: "Cancelled: fraud" });
	assert.deepEqual(await askLicence("f15b243b205c", "0.3.0", answer({ status: "unknown" })), { status: "unknown" });
	assert.equal(await askLicence("f15b243b205c", "0.3.0", answer({}, 503)), null);
	assert.equal(await askLicence("f15b243b205c", "0.3.0", (async () => { throw new Error("offline"); }) as unknown as typeof fetch), null);
});

test("updates: versions released up to the updates date are covered for good, later ones aren't", async () => {
	const c = await checkLicence(make("Acme Agency", "0", "", "2027-11-12"), "2030-01-01", pub);
	assert.ok(c.ok); // years later, the key itself still works
	const l = c.ok ? c.licence : null!;
	assert.equal(l.updates, "2027-11-12");
	assert.equal(l.until, null);
	assert.ok(covers(l, "2026-11-12"));
	assert.ok(covers(l, "2027-11-12")); // released on the last day
	assert.equal(covers(l, "2027-11-13"), false);
	assert.match(notCovered(l, "2028-01-05"), /up to 12 Nov 2027.*came out on 5 Jan 2028/);
});

test("updates: keys without a date (made before 0.3.1) cover every version", async () => {
	const c = await checkLicence(make("Old Key Ltd"), "2026-11-12", pub);
	assert.ok(c.ok);
	assert.equal(c.ok && c.licence.updates, null);
	assert.ok(c.ok && covers(c.licence, "2040-01-01"));
	// A malformed date is ignored rather than locking anyone out.
	const bad = await checkLicence(make("Typo Ltd", "0", "", "next year"), "2026-11-12", pub);
	assert.equal(bad.ok && bad.licence.updates, null);
});
