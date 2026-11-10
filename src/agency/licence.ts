// Agency edition licence keys.
//
// A key is "NSA-" + the licence as base64url JSON + "." + an Ed25519 signature of that text, made with the private
// key only the licensor has (scripts/make-licence.mjs, run from the "Make a licence key" GitHub Action). The app
// checks it with the public key below, offline: nothing is sent anywhere.
//
// Without a valid key the agency edition works as the free edition (one brand, no client logins). Nothing is
// deleted: the other brands and logins come back as soon as a valid key is added.

import { getMeta, setMeta } from "../db.ts";

export const PUBLIC_KEY = "fTOc_d68Dwd-nW9JQnK-eeqJIqNgLOGsXcUe42AHv7A";
/** Keys bought on newslettersender.com are signed with this one (its private half lives only in that Worker). */
export const SHOP_PUBLIC_KEY = "PEW8tvk4sRS7u401cX1PdKxrD5eitgbPHbGODXcB_zI";
const KEYS = [PUBLIC_KEY, SHOP_PUBLIC_KEY];

export interface Licence {
	v: 1;
	/** The licence's own id, for support. */
	id: string;
	/** Who it's for: the agency's name. Shown in the app. */
	to: string;
	/** How many brands it allows; 0 for no limit. */
	brands: number;
	/** The last day it works (YYYY-MM-DD), or null for no end. */
	until: string | null;
	/** When it was made (YYYY-MM-DD). */
	at: string;
}

export type Checked = { ok: true; licence: Licence } | { ok: false; error: string };

const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

const imported = new Map<string, Promise<CryptoKey>>();
const publicKey = (raw = PUBLIC_KEY) => {
	if (!imported.has(raw)) imported.set(raw, crypto.subtle.importKey("raw", unb64(raw), { name: "Ed25519" }, false, ["verify"]));
	return imported.get(raw)!;
};

/** Checks a licence key. `today` and `raw` are for tests. */
export async function checkLicence(key: unknown, today = new Date().toISOString().slice(0, 10), raw = PUBLIC_KEY): Promise<Checked> {
	const m = typeof key === "string" ? /^NSA-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(key.replace(/\s+/g, "")) : null;
	if (!m) return { ok: false, error: "That doesn't look like a licence key. It starts NSA- and is one long line." };
	let good = false;
	for (const k of raw === PUBLIC_KEY ? KEYS : [raw]) {
		try {
			good = await crypto.subtle.verify({ name: "Ed25519" }, await publicKey(k), unb64(m[2]), new TextEncoder().encode(m[1]));
		} catch {
			good = false;
		}
		if (good) break;
	}
	if (!good) return { ok: false, error: "That licence key isn't right. Please copy it again, all of it." };
	let l: Licence;
	try {
		l = JSON.parse(new TextDecoder().decode(unb64(m[1])));
	} catch {
		return { ok: false, error: "That licence key isn't right. Please copy it again, all of it." };
	}
	if (l?.v !== 1 || typeof l.to !== "string") return { ok: false, error: "That licence key is for a different version. Please update Newsletter Sender." };
	if (l.until && l.until < today) return { ok: false, error: `That licence ended on ${l.until}.` };
	return { ok: true, licence: { v: 1, id: String(l.id ?? ""), to: l.to, brands: Math.max(0, Math.floor(Number(l.brands) || 0)), until: l.until ?? null, at: String(l.at ?? "") } };
}

// The key is checked once per Worker, then remembered for a few minutes (it can change from Settings at any time).
let cache: { key: string | null; at: number; licence: Licence | null } | null = null;

/** This install's licence, or null when there's no valid one. */
export async function currentLicence(db: D1Database): Promise<Licence | null> {
	if (cache && Date.now() - cache.at < 300_000) return cache.licence;
	const key = await getMeta(db, "agency_licence");
	const c = key ? await checkLicence(key) : null;
	cache = { key, at: Date.now(), licence: c?.ok ? c.licence : null };
	return cache.licence;
}

export async function saveLicence(db: D1Database, key: string | null): Promise<void> {
	await setMeta(db, "agency_licence", key);
	cache = null;
}
