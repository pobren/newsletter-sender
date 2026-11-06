// The dashboard page. The page itself is app.html (HTML, styles and script in one file, loaded as text by Wrangler).
// The agency edition's own script goes in where app.html says {{ADDON}} (addon.ts).

import page from "./app.html";
import { addon } from "./addon.ts";

export const appPage = (version: string) => (page as string).replaceAll("{{VERSION}}", version).replace("{{ADDON}}", () => addon.script);
