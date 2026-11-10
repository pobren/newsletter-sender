import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { checkLicence } from "../src/agency/licence.ts";

// A key pair just for these tests, so the real signing key never has to be here.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url");
// Makes a key the way the licensor's tools do: "NSA-" + base64url JSON + "." + an Ed25519 signature.
const make = (to: string, brands = "0", until = "") => {
	const text = Buffer.from(JSON.stringify({ v: 1, id: randomBytes(6).toString("hex"), to, brands: Number(brands), until: until || null, at: "2026-11-06" })).toString("base64url");
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
