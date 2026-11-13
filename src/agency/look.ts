// White label (Settings, White label): the agency's own name, logo, colour, support link and email address, in place
// of Newsletter Sender wherever clients look. The owner keeps updates, the licence and our guides.
//
// It needs the agency licence. Without one (or with nothing saved) the app looks like Newsletter Sender, as before.

import { getMeta, setMeta } from "../db.ts";
import { cleanEmail } from "../csv.ts";
import { currentLicence } from "./licence.ts";

export interface Look {
	/** The agency's name: the browser tab, the sign in page and the top of the app. */
	name: string;
	/** The main colour, such as #1d4fa3. Made darker where needed so white text on it is easy to read. */
	colour: string;
	/** The logo: /img/... when uploaded to this install's picture storage, or an https:// address anywhere else. */
	logo: string | null;
	/** Where clients go for help: a web address or an email address. */
	support: string | null;
	/** The address emails to clients (invites, sign off requests) come from. */
	from_email: string | null;
}

const KEY = "agency_look";

/** The saved look, licence or not (for Settings). */
export async function savedLook(db: D1Database): Promise<Look | null> {
	try {
		const v = JSON.parse((await getMeta(db, KEY)) ?? "null");
		return v && typeof v.name === "string" ? v : null;
	} catch {
		return null;
	}
}

/** The look clients see: only with a valid agency licence. */
export async function currentLook(db: D1Database): Promise<Look | null> {
	if (!(await currentLicence(db))) return null;
	return savedLook(db);
}

export async function saveLook(db: D1Database, look: Look | null): Promise<void> {
	await setMeta(db, KEY, look ? JSON.stringify(look) : null);
}

/** Checks what was typed in Settings, White label. */
export function cleanLook(v: unknown): Look | { error: string } {
	const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	const name = String(o.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
	if (!name) return { error: "Please give your agency's name." };
	const colour = typeof o.colour === "string" && /^#[0-9a-f]{6}$/i.test(o.colour) ? o.colour.toLowerCase() : "#a3195b";
	const logoIn = String(o.logo ?? "").trim();
	// A picture uploaded here is kept as /img/..., so it works on every address this install answers on.
	if (logoIn && !/^https:\/\/\S{1,1000}$/.test(logoIn) && !/^\/img\/[\w.-]{1,80}$/.test(logoIn)) return { error: "The logo should be a web address starting https://, or upload a picture." };
	const supIn = String(o.support ?? "").trim();
	let support: string | null = null;
	if (supIn) {
		const email = cleanEmail(supIn.replace(/^mailto:/i, ""));
		if (email && !/^https?:/i.test(supIn)) support = `mailto:${email}`;
		else if (/^https:\/\/\S{1,500}$/.test(supIn)) support = supIn;
		else return { error: "Help for clients should be an email address or a web address starting https://." };
	}
	const fromIn = String(o.from_email ?? "").trim();
	const from_email = fromIn ? cleanEmail(fromIn) : null;
	if (fromIn && !from_email) return { error: "Please check the address emails to clients come from." };
	return { name, colour, logo: logoIn || null, support, from_email };
}

// ---- Colours ----------------------------------------------------------------------------------------------------

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c: number[]) => `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;
function luminance(hex: string): number {
	const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Contrast against white, 1 to 21. */
export const contrast = (hex: string) => 1.05 / (luminance(hex) + 0.05);
const darken = (hex: string, f: number) => toHex(rgb(hex).map((v) => v * f));
const mix = (hex: string, white: number) => toHex(rgb(hex).map((v) => v + (255 - v) * white));

/** The colour made dark enough for white button text (WCAG AA, 4.5 to 1). */
export function readable(hex: string): string {
	let c = hex;
	for (let i = 0; i < 40 && contrast(c) < 4.5; i++) c = darken(c, 0.92);
	return c;
}

/** The app's colour settings for this look. */
export function lookColours(hex: string): Record<string, string> {
	const c = readable(hex);
	return { "--c": c, "--cd": darken(c, 0.78), "--pink": mix(c, 0.86), "--soft": mix(c, 0.95), "--edge": mix(c, 0.75), "--line": mix(c, 0.9), "--bg": mix(c, 0.97) };
}

// ---- The page -----------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A small square with the first letter, for when there's no logo. */
export function initialMark(name: string, colour: string): string {
	const letter = esc((name.trim().charAt(0) || "?").toUpperCase());
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="9" fill="${readable(colour)}"/><text x="18" y="25" text-anchor="middle" font-family="system-ui,sans-serif" font-size="20" font-weight="700" fill="#fff">${letter}</text></svg>`;
}

/** The dashboard page with the agency's look in place of Newsletter Sender's. */
export function applyLook(page: string, look: Look): string {
	const name = esc(look.name);
	const mark = look.logo ? `<img src="${esc(look.logo)}" alt="${name}" class="lookmark">` : initialMark(look.name, look.colour);
	const icon = look.logo ? `<link rel="icon" href="${esc(look.logo)}">` : `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(initialMark(look.name, look.colour))}">`;
	const vars = Object.entries(lookColours(look.colour)).map(([k, v]) => `${k}:${v}`).join(";");
	const help = look.support ? ` · <a href="${esc(look.support)}"${look.support.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>Help</a>` : "";
	const client = { name: look.name, colour: readable(look.colour), logo: look.logo, support: look.support, from_email: look.from_email };
	return page
		.replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
		.replace(/<link rel="icon"[^>]*>/, icon)
		.replace("</style>", `:root{${vars}}.lookmark{height:32px;width:auto;max-width:140px;object-fit:contain}</style>`)
		.replace(/(<a class="mark"[^>]*>)<svg[\s\S]*?<\/svg><span id="appName">[^<]*<\/span>/, `$1${mark}<span id="appName">${name}</span>`)
		.replace(/<p class="muted appver"[^>]*>[\s\S]*?<\/p>/, `<p class="muted appver" style="text-align:center;font-size:13px">${name}${help}</p>`)
		.replace("{{LOOK}}", () => `<script>window.NS_LOOK=${JSON.stringify(client).replace(/</g, "\\u003c")};</script>`);
}
