// Brands and client logins. The owner sees every brand and can do everything. A client signs in to one brand and can
// only do what the owner allowed: send, import, export, delete, change settings, and up to so many emails a month.
// Backups, people and new brands are always the owner's.

import { iso, type AccountRow, type BrandRow } from "../db.ts";
import type { Can } from "../addon.ts";

export type { Can };
export const OWNER_CAN: Can = { send: true, import: true, export: true, delete: true, settings: true, month_limit: 0 };

export const CLIENT_START: Can = { send: false, import: true, export: false, delete: false, settings: false, month_limit: 0 };

export function cleanCan(v: unknown): Can {
	const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	const n = Math.floor(Number(o.month_limit));
	return { send: o.send === true, import: o.import === true, export: o.export === true, delete: o.delete === true, settings: o.settings === true, month_limit: Number.isFinite(n) && n > 0 ? Math.min(n, 100_000_000) : 0 };
}

export function canOf(a: Pick<AccountRow, "role" | "limits">): Can {
	if (a.role !== "client") return OWNER_CAN;
	try {
		return cleanCan(JSON.parse(a.limits ?? "{}"));
	} catch {
		return cleanCan({});
	}
}

/** The brands this account can open: all of them for the owner, just theirs for a client. */
export async function brandsFor(db: D1Database, a: Pick<AccountRow, "role" | "brand_id">): Promise<BrandRow[]> {
	if (a.role !== "client") return (await db.prepare("SELECT * FROM brands ORDER BY created_at").all<BrandRow>()).results;
	if (!a.brand_id) return [];
	const b = await db.prepare("SELECT * FROM brands WHERE id = ?").bind(a.brand_id).first<BrandRow>();
	return b ? [b] : [];
}

const BRAND_COOKIE = "ns_brand";
export const brandCookie = (id: string, secure: boolean) => `${BRAND_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;

/** The brand the app is showing: the one chosen last (if this account may open it), otherwise the first. */
export function pickBrand(request: Request, brands: BrandRow[]): BrandRow {
	const want = new RegExp(`(?:^|;\\s*)${BRAND_COOKIE}=([0-9a-f]{16})`).exec(request.headers.get("cookie") ?? "")?.[1];
	return brands.find((b) => b.id === want) ?? brands[0];
}

/** Why a client can't do this, or null when they can. */
export function notAllowed(a: Pick<AccountRow, "role">, can: Can, path: string, method: string): string | null {
	if (a.role !== "client") return null;
	const write = method !== "GET" && method !== "HEAD";
	if (/^\/api\/(backups|people|licence)(\/|$)/.test(path) || (path === "/api/brands" && write)) return "Only the owner can do that.";
	if (!can.settings && ((path === "/api/brand" && write) || /^\/api\/developer(\/|$)/.test(path) || (/^\/api\/(sending|sending\/cloudflare|sending\/ses-setup|sending\/warmup|links)$/.test(path) && write)))
		return "Changing settings is switched off for your login. Please ask the owner.";
	if (!can.send && ((/^\/api\/campaigns\/[0-9a-f]{16}\/(send|schedule|resume)$/.test(path) && write) || (/^\/api\/automations(\/|$)/.test(path) && write)))
		return "Sending is switched off for your login. You can still write and test campaigns: the owner sends them.";
	if (!can.import && (path === "/api/import" || path.startsWith("/api/move/")) && write) return "Importing is switched off for your login. Please ask the owner.";
	if (!can.export && (path === "/api/export" || path === "/api/blocklist/export" || (/^\/api\/campaigns\/[0-9a-f]{16}\/people$/.test(path) && !write)))
		return "Downloading subscribers is switched off for your login. Please ask the owner.";
	if (!can.delete && ((/^\/api\/(subscribers|lists)\/[0-9a-f]{16}$/.test(path) && method === "DELETE") || /^\/api\/lists\/[0-9a-f]{16}\/(delete|remove)$/.test(path)))
		return "Deleting is switched off for your login. Please ask the owner.";
	return null;
}

/** Emails sent this calendar month (UTC) for a brand, for a client's monthly limit. */
export async function monthUsed(db: D1Database, brandId: string, now = new Date()): Promise<number> {
	const start = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
	return (await db.prepare("SELECT COUNT(*) AS n FROM sends x JOIN campaigns c ON c.id = x.campaign_id WHERE c.brand_id = ? AND x.status = 'sent' AND x.sent_at >= ?").bind(brandId, start).first<{ n: number }>())?.n ?? 0;
}
