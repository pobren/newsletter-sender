// Agency edition licence keys.
//
// A key is "NSA-" + the licence as base64url JSON + "." + an Ed25519 signature of that text, made with the private
// key only the licensor has. The app checks the signature with the public keys below.
//
// Once a day the app also asks newslettersender.com whether the licence is still active, sending only the licence id
// and the app version (Paul, 10 Nov 2026: so a licence bought by fraud can be cancelled). A cancelled licence turns the
// agency features off. If newslettersender.com can't be reached, the licence keeps working for GRACE_DAYS after the
// last good answer. Keys that site never sold answer "unknown", which counts as active.
//
// Without a valid key the agency edition works as the free edition (one brand, no client logins). Nothing is
// deleted: the other brands and logins come back as soon as a valid key is added.
//
// Updates (Paul, 11 Nov 2026): a licence includes 12 months of updates and email support. The key's `updates` date
// says until when. Every version released on or before that date keeps the agency features for good; a version
// released after it runs as the free edition until a renewed key is added (or Undo goes back). A key with no
// `updates` date covers every version.

import { getMeta, setMeta } from "../db.ts";
import { RELEASED } from "../update.ts";

/** Where an owner renews updates and email support. */
export const RENEW_URL = "https://newslettersender.com/contact/?topic=agency";

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
	/** The last day it works at all (YYYY-MM-DD), or null for no end. Bought keys have none. */
	until: string | null;
	/** Updates until (YYYY-MM-DD): versions released on or before this day are covered. Null for every version. */
	updates: string | null;
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
	const updates = typeof (l as any).updates === "string" && /^\d{4}-\d{2}-\d{2}$/.test((l as any).updates) ? (l as any).updates : null;
	return { ok: true, licence: { v: 1, id: String(l.id ?? ""), to: l.to, brands: Math.max(0, Math.floor(Number(l.brands) || 0)), until: l.until ?? null, updates, at: String(l.at ?? "") } };
}

/** Whether the licence's updates cover a version released on `released` (YYYY-MM-DD). */
export function covers(l: Pick<Licence, "updates">, released: string = RELEASED): boolean {
	return !l.updates || !released || released <= l.updates;
}

/** "12 Nov 2027" from "2027-11-12". */
export const longDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** What to tell the owner when this version came out after their updates ended. */
export const notCovered = (l: Pick<Licence, "updates">, released: string = RELEASED) =>
	`Your licence covers versions released up to ${longDate(l.updates!)}, and this version came out on ${longDate(released)}. The agency features are off until you renew, or you can go back to the previous version under Settings, Updates. Nothing has been deleted.`;

// ---- The daily check -------------------------------------------------------------------------------------------

export const CHECK_URL = "https://newslettersender.com/api/licence/check";
export const GRACE_DAYS = 7;
const DAY = 86_400_000;
const STATUS = "agency_licence_status";

export interface LicenceStatus {
	/** The last answer: "active", "cancelled" or "unknown" (a key newslettersender.com didn't sell). */
	status: "active" | "cancelled" | "unknown";
	message?: string;
	/** When newslettersender.com last answered (or the key was saved). */
	ok_at: string;
	/** When to ask next. */
	next_at: string;
}

export async function licenceStatus(db: D1Database): Promise<LicenceStatus | null> {
	try {
		return JSON.parse((await getMeta(db, STATUS)) ?? "null");
	} catch {
		return null;
	}
}

/** Whether the daily check lets the licence work: not cancelled, and answered within GRACE_DAYS. */
export function statusAllows(s: LicenceStatus | null, now = Date.now()): boolean {
	if (!s) return true;
	if (s.status === "cancelled") return false;
	return now - Date.parse(s.ok_at) <= GRACE_DAYS * DAY;
}

/** Asks newslettersender.com about this licence. Null when it couldn't be reached. */
export async function askLicence(id: string, version: string, fetcher: typeof fetch = fetch): Promise<Pick<LicenceStatus, "status" | "message"> | null> {
	try {
		const res = await fetcher(`${CHECK_URL}?id=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": `NewsletterSender/${version}` } });
		if (res.status >= 500) return null;
		const d = (await res.json()) as { status?: string; message?: string };
		if (d.status === "cancelled") return { status: "cancelled", message: typeof d.message === "string" ? d.message.slice(0, 300) : undefined };
		return { status: d.status === "active" ? "active" : "unknown" };
	} catch {
		return null;
	}
}

/** Called every minute by the cron: asks once a day (once an hour after a failed try). */
export async function checkLicenceIfDue(db: D1Database, version: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<void> {
	const key = await getMeta(db, "agency_licence");
	if (!key) return;
	const s = await licenceStatus(db);
	if (s && Date.parse(s.next_at) > now) return;
	const c = await checkLicence(key);
	if (!c.ok) return;
	const answer = await askLicence(c.licence.id, version, fetcher);
	const at = new Date(now).toISOString();
	const next: LicenceStatus = answer
		? { ...answer, ok_at: at, next_at: new Date(now + DAY).toISOString() }
		: { status: s?.status ?? "unknown", message: s?.message, ok_at: s?.ok_at ?? at, next_at: new Date(now + DAY / 24).toISOString() };
	await setMeta(db, STATUS, JSON.stringify(next));
	cache = null;
}

// The key is checked once per Worker, then remembered for a few minutes (it can change from Settings at any time).
let cache: { key: string | null; at: number; licence: Licence | null } | null = null;

/** This install's licence, or null when there's no valid one (or it's been cancelled). */
export async function currentLicence(db: D1Database): Promise<Licence | null> {
	if (cache && Date.now() - cache.at < 300_000) return cache.licence;
	const key = await getMeta(db, "agency_licence");
	const c = key ? await checkLicence(key) : null;
	const allowed = c?.ok ? covers(c.licence) && statusAllows(await licenceStatus(db)) : false;
	cache = { key, at: Date.now(), licence: c?.ok && allowed ? c.licence : null };
	return cache.licence;
}

/** Saves (or removes) the key. `answer` is newslettersender.com's answer when it was asked just now. */
export async function saveLicence(db: D1Database, key: string | null, answer?: Pick<LicenceStatus, "status" | "message"> | null): Promise<void> {
	await setMeta(db, "agency_licence", key);
	const now = Date.now();
	await setMeta(db, STATUS, key ? JSON.stringify({ status: answer?.status ?? "unknown", message: answer?.message, ok_at: new Date(now).toISOString(), next_at: new Date(now + (answer ? DAY : DAY / 24)).toISOString() } satisfies LicenceStatus) : null);
	cache = null;
}
