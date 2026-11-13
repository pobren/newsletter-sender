// The dashboard page. The page itself is app.html (HTML, styles and script in one file, loaded as text by Wrangler).
// The agency edition's own script goes in where app.html says {{ADDON}} (addon.ts).

import page from "./app.html";
import { addon } from "./addon.ts";
import { applyLook, type Look } from "./agency/look.ts";

/** The page, with the agency's white label look when there is one (agency/look.ts). */
export function appPage(version: string, look: Look | null = null): string {
	const out = (page as string).replaceAll("{{VERSION}}", version).replace("{{ADDON}}", () => addon.script);
	return look ? applyLook(out, look) : out.replace("{{LOOK}}", "");
}
