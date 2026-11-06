import { test } from "node:test";
import assert from "node:assert/strict";
import { b64url, checkClientData, derToRaw, keyUsable, passkeyName, unb64url, verifyAssertion } from "../src/passkeys.ts";

const enc = new TextEncoder();

/** Authenticator data as a device makes it: hash of the site, flags, then the counter. */
async function authData(rpId: string, flags: number, count: number): Promise<Uint8Array> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rpId)));
	const ad = new Uint8Array(37);
	ad.set(h, 0);
	ad[32] = flags;
	new DataView(ad.buffer).setUint32(33, count);
	return ad;
}

/** Wraps a raw ES256 signature the way devices send it (DER). */
function toDer(raw: Uint8Array): Uint8Array {
	const int = (n: Uint8Array) => { let i = 0; while (i < 31 && n[i] === 0) i++; let v = n.slice(i); if (v[0] & 0x80) v = Uint8Array.from([0, ...v]); return [0x02, v.length, ...v]; };
	const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
	return Uint8Array.from([0x30, body.length, ...body]);
}

async function signWith(alg: number) {
	const pair = alg === -7
		? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
		: await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
	const sign = async (ad: Uint8Array, cd: Uint8Array) => {
		const h = new Uint8Array(await crypto.subtle.digest("SHA-256", cd));
		const msg = Uint8Array.from([...ad, ...h]);
		const sig = new Uint8Array(await crypto.subtle.sign(alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, msg));
		return alg === -7 ? toDer(sig) : sig;
	};
	return { spki, sign };
}

for (const alg of [-7, -257]) {
	test(`a passkey sign in checks out (${alg === -7 ? "ES256" : "RS256"})`, async () => {
		const k = await signWith(alg);
		assert.equal(await keyUsable(k.spki, alg), true);
		const cd = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: "https://news.example.com" }));
		const ad = await authData("news.example.com", 0x05, 7);
		const sig = await k.sign(ad, cd);
		assert.deepEqual(await verifyAssertion({ publicKey: k.spki, alg, rpId: "news.example.com", authenticatorData: ad, clientDataJSON: cd, signature: sig, storedCount: 3 }), { count: 7 });
		// Another site, a changed message, a replayed counter and no user presence all fail.
		assert.ok("error" in (await verifyAssertion({ publicKey: k.spki, alg, rpId: "evil.example.com", authenticatorData: ad, clientDataJSON: cd, signature: sig, storedCount: 3 })));
		assert.ok("error" in (await verifyAssertion({ publicKey: k.spki, alg, rpId: "news.example.com", authenticatorData: ad, clientDataJSON: enc.encode("{}"), signature: sig, storedCount: 3 })));
		assert.ok("error" in (await verifyAssertion({ publicKey: k.spki, alg, rpId: "news.example.com", authenticatorData: ad, clientDataJSON: cd, signature: sig, storedCount: 7 })));
		const absent = await authData("news.example.com", 0x04, 8);
		assert.ok("error" in (await verifyAssertion({ publicKey: k.spki, alg, rpId: "news.example.com", authenticatorData: absent, clientDataJSON: cd, signature: await k.sign(absent, cd), storedCount: 0 })));
	});
}

test("devices that never count still sign in", async () => {
	const k = await signWith(-7);
	const cd = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: "abc", origin: "https://a.example" }));
	const ad = await authData("a.example", 0x01, 0);
	assert.deepEqual(await verifyAssertion({ publicKey: k.spki, alg: -7, rpId: "a.example", authenticatorData: ad, clientDataJSON: cd, signature: await k.sign(ad, cd), storedCount: 0 }), { count: 0 });
});

test("client data must be the right kind, from this app", () => {
	const cd = (o: object) => enc.encode(JSON.stringify(o));
	assert.deepEqual(checkClientData(cd({ type: "webauthn.create", challenge: "x", origin: "https://a.example" }), "webauthn.create", "https://a.example"), { challenge: "x" });
	assert.ok("error" in checkClientData(cd({ type: "webauthn.get", challenge: "x", origin: "https://a.example" }), "webauthn.create", "https://a.example"));
	assert.ok("error" in checkClientData(cd({ type: "webauthn.create", challenge: "x", origin: "https://b.example" }), "webauthn.create", "https://a.example"));
	assert.ok("error" in checkClientData(enc.encode("not json"), "webauthn.create", "https://a.example"));
});

test("base64url round trips and DER signatures unwrap", () => {
	const bytes = crypto.getRandomValues(new Uint8Array(65));
	assert.deepEqual(unb64url(b64url(bytes)), bytes);
	const raw = new Uint8Array(64).fill(0x80);
	assert.deepEqual(derToRaw(toDer(raw)), raw);
	assert.equal(passkeyName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone, Safari");
	assert.equal(passkeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"), "Mac, Chrome");
});
