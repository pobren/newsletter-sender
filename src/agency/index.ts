// The agency edition: as many brands as the licence allows, logins for clients with limits, and every brand at a
// glance. It plugs into the app through addon.ts. Without a valid licence key it works as the free edition.

import type { Addon } from "../addon.ts";
import { audienceCount, parseAudience } from "../sending.ts";
import { currentLicence } from "./licence.ts";
import { currentLook } from "./look.ts";
import { currentAddress, wrongAddress } from "./address.ts";
import { lockedForEdit, needsSignoff } from "./signoff.ts";
import { agencyRoutes, openRoutes } from "./routes.ts";
import { brandsFor, canOf, monthUsed, notAllowed, pickBrand } from "./team.ts";
import script from "./agency.html";

export function agency(free: Addon): Addon {
	return {
		edition: "agency",
		open: openRoutes,
		brandsFor: async (db, me) => ((await currentLicence(db)) ? brandsFor(db, me) : free.brandsFor(db, me)),
		pickBrand,
		can: canOf,
		refuse: (me, path, method) => notAllowed(me, canOf(me), path, method),
		api: agencyRoutes,
		// A client's monthly limit.
		async beforeSend(db, me, brand, c, action) {
			if (!(await currentLicence(db))) return null;
			// Client sign off, when the brand asks for it.
			const signoff = await needsSignoff(db, brand, c, action);
			if (signoff) return signoff;
			const can = canOf(me);
			if (!can.month_limit) return null;
			const used = await monthUsed(db, brand.id);
			const more = action === "resume" ? Math.max(0, (c.total ?? 0) - used) : await audienceCount(db, brand.id, parseAudience(c.audience));
			return used + more > can.month_limit ? `That would go over your limit of ${can.month_limit.toLocaleString("en-GB")} emails this month (${used.toLocaleString("en-GB")} sent so far). Please ask the owner.` : null;
		},
		beforeEdit: async (db, _me, brand, c) => ((await currentLicence(db)) ? lockedForEdit(db, brand, c) : null),
		look: currentLook,
		here: async (db, me, host) => wrongAddress(await currentAddress(db), me, host),
		script,
	};
}
