// The slot the agency features plug into.
//
// Without a licence key the app is one brand with one login. With an agency licence key (Settings, Licence) it also
// has more brands, client logins with limits, and every brand at a glance (src/agency/). Everything those need from
// the app goes through the Addon interface below.

import type { AccountRow, BrandRow, CampaignRow, Env } from "./db.ts";
import { agency } from "./agency/index.ts";

/** What a client may do. The owner may do everything. */
export interface Can { send: boolean; import: boolean; export: boolean; delete: boolean; settings: boolean; month_limit: number }
export const OWNER_CAN: Can = { send: true, import: true, export: true, delete: true, settings: true, month_limit: 0 };

export interface AddonContext { request: Request; env: Env; url: URL; path: string; method: string; secure: boolean; me: AccountRow; brands: BrandRow[]; brand: BrandRow }

export interface Addon {
	/** "free" or "agency": shown in Settings, Account. */
	edition: string;
	/** Routes answered before anyone signs in (such as a client's invite link), or null. */
	open(request: Request, env: Env, url: URL): Promise<Response | null>;
	/** The brands this login can open. */
	brandsFor(db: D1Database, me: AccountRow): Promise<BrandRow[]>;
	/** The brand the app is showing. */
	pickBrand(request: Request, brands: BrandRow[]): BrandRow;
	/** What this login may do. */
	can(me: AccountRow): Can;
	/** Why this login can't do this, or null when it can. */
	refuse(me: AccountRow, path: string, method: string): string | null;
	/** The add-on's own routes once signed in, or null. */
	api(ctx: AddonContext): Promise<Response | null>;
	/** Why this campaign can't be sent, scheduled or resumed now (such as a client's monthly limit), or null. */
	beforeSend(db: D1Database, me: AccountRow, brand: BrandRow, c: CampaignRow, action: string): Promise<string | null>;
	/** Extra script for the dashboard. It runs before the app's own and fills in window.NS_ADDON (see app.html). */
	script: string;
}

const FREE: Addon = {
	edition: "free",
	open: async () => null,
	// One brand: the first one made. A login for a client opens nothing here.
	brandsFor: async (db, me) => (me.role === "client" ? [] : (await db.prepare("SELECT * FROM brands ORDER BY created_at LIMIT 1").all<BrandRow>()).results),
	pickBrand: (_request, brands) => brands[0],
	can: () => OWNER_CAN,
	refuse: () => null,
	api: async () => null,
	beforeSend: async () => null,
	script: "",
};

// The agency features are built in and stay off until a licence key is pasted into Settings, Licence
// (src/agency/licence.ts). Without a key this is exactly the free edition: one brand, no client logins.
export const addon: Addon = agency(FREE);
