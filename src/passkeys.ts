// Passkeys: sign in with Face ID, Touch ID, Windows Hello or a phone instead of a password. The password stays as a
// fallback. Each passkey belongs to one account and works on the address it was made on (passkeys are tied to a web
// address by the browser). The browser hands us the public key itself, so there's no attestation to check.

import { getMeta, setMeta } from "./db.ts";

const enc = new TextEncoder();
/** How long a passkey prompt can stay open before its challenge expires. */
const CHALLENGE_MS = 5 * 60_000;
/** The signing types we ask for: ES256 (nearly every passkey) and RS256 (some Windows Hello). */
export const ALGS = [-7, -257];

export const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function unb64url(s: string): Uint8Array {
	const t = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface PasskeyRow {
	id: string;
	account_id: string;
	name: string;
	public_key: string;
	alg: number;
	rp_id: string;
	sign_count: number;
	created_at: string;
	last_used_at: string | null;
}

/** A fresh one-use challenge, kept for five minutes. Old unused ones are cleared as new ones are made. */
export async function newChallenge(db: D1Database, purpose: "add" | "signin", accountId = ""): Promise<string> {
	const c = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const until = String(Date.now() + CHALLENGE_MS).padStart(15, "0");
	await db.prepare("DELETE FROM meta WHERE key LIKE 'pk_chal:%' AND value < ?").bind(String(Date.now()).padStart(15, "0")).run();
	await setMeta(db, `pk_chal:${c}`, `${until}|${purpose}|${accountId}`);
	return c;
}

/** Uses up a challenge: true only once, before it expires, for the same purpose (and account, when adding). */
export async function takeChallenge(db: D1Database, c: string, purpose: "add" | "signin", accountId = ""): Promise<boolean> {
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(c)) return false;
	const v = await getMeta(db, `pk_chal:${c}`);
	if (!v) return false;
	await setMeta(db, `pk_chal:${c}`, null);
	const [until, p, acct] = v.split("|");
	return Number(until) > Date.now() && p === purpose && acct === accountId;
}

/** Checks the browser's clientDataJSON: the right kind of prompt, our challenge and this app's own address. */
export function checkClientData(clientDataJSON: Uint8Array, type: "webauthn.create" | "webauthn.get", origin: string): { challenge: string } | { error: string } {
	let cd: any;
	try { cd = JSON.parse(new TextDecoder().decode(clientDataJSON)); } catch { return { error: "That passkey reply couldn't be read." }; }
	if (cd?.type !== type) return { error: "That passkey reply was for something else." };
	if (cd.origin !== origin) return { error: "That passkey reply came from another website." };
	if (typeof cd.challenge !== "string") return { error: "That passkey reply had no challenge." };
	return { challenge: cd.challenge };
}

/** ES256 signatures come DER wrapped; WebCrypto wants the two 32 byte numbers side by side. */
export function derToRaw(der: Uint8Array): Uint8Array {
	if (der[0] !== 0x30) return der;
	let i = 2;
	if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
	const part = () => {
		if (der[i] !== 0x02) throw new Error("bad signature");
		const len = der[i + 1];
		let n = der.slice(i + 2, i + 2 + len);
		i += 2 + len;
		while (n.length > 32 && n[0] === 0) n = n.slice(1);
		const out = new Uint8Array(32);
		out.set(n, 32 - n.length);
		return out;
	};
	const r = part(), s = part();
	const raw = new Uint8Array(64);
	raw.set(r, 0);
	raw.set(s, 32);
	return raw;
}

async function importKey(spki: Uint8Array, alg: number): Promise<CryptoKey> {
	if (alg === -7) return crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	if (alg === -257) return crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
	throw new Error("unsupported");
}

/** Whether a public key the browser gave us is one we can check signatures with. */
export async function keyUsable(spki: Uint8Array, alg: number): Promise<boolean> {
	return importKey(spki, alg).then(() => true, () => false);
}

/**
 * Checks a sign in: the authenticator data is for this app's address and the person was present, and the signature
 * over it (plus a hash of the client data) matches the saved public key. Returns the new signature counter.
 */
export async function verifyAssertion(p: { publicKey: Uint8Array; alg: number; rpId: string; authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array; storedCount: number }): Promise<{ count: number } | { error: string }> {
	const ad = p.authenticatorData;
	if (ad.length < 37) return { error: "That passkey reply was too short." };
	const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(p.rpId)));
	if (!rpHash.every((b, i) => b === ad[i])) return { error: "That passkey is for another website." };
	if (!(ad[32] & 0x01)) return { error: "The passkey didn't confirm you were there. Please try again." };
	const count = ((ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36]) >>> 0;
	if (count !== 0 && count <= p.storedCount) return { error: "That passkey looks like a copy. Please remove it in Settings and add it again." };
	const cdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", p.clientDataJSON));
	const signed = new Uint8Array(ad.length + cdHash.length);
	signed.set(ad, 0);
	signed.set(cdHash, ad.length);
	let good = false;
	try {
		const key = await importKey(p.publicKey, p.alg);
		good = p.alg === -7
			? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(p.signature), signed)
			: await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, p.signature, signed);
	} catch { good = false; }
	return good ? { count } : { error: "That passkey didn't match. Please try again or use your password." };
}

/** A friendly name for a new passkey, from the browser's description of the device. */
export function passkeyName(ua: string | null): string {
	const u = ua ?? "";
	const device = /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) ? "iPad" : /Android/.test(u) ? "Android" : /Mac OS X|Macintosh/.test(u) ? "Mac" : /Windows/.test(u) ? "Windows" : /Linux/.test(u) ? "Linux" : "This device";
	const browser = /Edg\//.test(u) ? "Edge" : /Firefox\//.test(u) ? "Firefox" : /Chrome\//.test(u) ? "Chrome" : /Safari\//.test(u) ? "Safari" : "";
	return browser ? `${device}, ${browser}` : device;
}
