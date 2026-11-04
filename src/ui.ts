// The dashboard page. The page itself is app.html (HTML, styles and script in one file, loaded as text by Wrangler).

import page from "./app.html";

export const appPage = (version: string) => (page as string).replaceAll("{{VERSION}}", version);
