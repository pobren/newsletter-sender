// The agency's own app address (Settings, White label): clients sign in at something like news.youragency.co.uk
// instead of the workers.dev address. It's a Cloudflare Workers custom domain on the agency's own account, added with
// the same token and button as "Your own domain for links", and Cloudflare makes the certificate itself.
//
// Optional: "Clients can only sign in at my address". The owner can always use any address.

import type { AddonContext } from "../addon.ts";
import type { AccountRow } from "../db.ts";
import { getMeta, setMeta } from "../db.ts";
import { bad, body, ok } from "../kit.ts";
import { addWorkerDomain, findZone, linksNameProblem, LINKS_TOKEN_URL, workerName } from "../cloudflare.ts";
import { sealText, unsealText } from "../providers.ts";
import { installId, linksToken, sealSecret } from "../settings.ts";
import { currentLicence } from "./licence.ts";

export interface Address {
	/** Such as news.youragency.co.uk. */
	host: string;
	/** Clients may only sign in and work at this address. */
	only_here: boolean;
}

const KEY = "agency_address";
const TOKEN = "agency_address_token";

export async function savedAddress(db: D1Database): Promise<Address | null> {
	try {
		const v = JSON.parse((await getMeta(db, KEY)) ?? "null");
		return v && typeof v.host === "string" ? { host: v.host, only_here: Boolean(v.only_here) } : null;
	} catch {
		return null;
	}
}

/** The address clients use, with the agency licence; null otherwise. */
export async function currentAddress(db: D1Database): Promise<Address | null> {
	return (await currentLicence(db)) ? savedAddress(db) : null;
}

/** Where invite and sign off links point: the agency's address when there is one, otherwise this one. */
export async function appBase(db: D1Database, url: URL): Promise<string> {
	const a = await currentAddress(db);
	return a ? `https://${a.host}` : url.origin;
}

/** Why this login can't work at this address, or null when it can. Only ever stops clients. */
export function wrongAddress(a: Address | null, me: Pick<AccountRow, "role">, host: string): string | null {
	if (!a || !a.only_here || me.role !== "client" || host === a.host) return null;
	return `Please sign in at https://${a.host}/ instead.`;
}

/** A name for an app address: a subdomain like news.youragency.co.uk. */
export function cleanHost(v: unknown): string | null {
	const h = String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h) && h.split(".").length >= 3 ? h : null;
}

export async function addressRoutes(x: AddonContext): Promise<Response | null> {
	const { request, env, url, path, method, brand } = x;
	const db = env.DB;
	if (!path.startsWith("/api/look/address")) return null;
	const a = await savedAddress(db);

	if (path === "/api/look/address" && method === "GET") {
		const own = (await unsealText(await sealSecret(db), await getMeta(db, TOKEN))) || (await linksToken(db, brand));
		const domain = (brand.from_email ?? "").split("@")[1] || "youragency.co.uk";
		return ok({ address: a, here: url.hostname, hasToken: Boolean(own), tokenUrl: LINKS_TOKEN_URL, suggest: `clients.${domain}`, appHost: url.hostname });
	}
	if (path === "/api/look/address" && method === "DELETE") {
		await setMeta(db, KEY, null);
		return ok();
	}
	if (path === "/api/look/address/only" && method === "POST") {
		if (!a) return bad("Please set up your app address first.");
		const on = (await body(request)).on === true;
		if (on && url.hostname !== a.host) return bad(`Please open https://${a.host}/ and switch this on from there, so you know it works first.`);
		await setMeta(db, KEY, JSON.stringify({ ...a, only_here: on }));
		return ok({ only_here: on });
	}
	if (path === "/api/look/address/check" && method === "GET") {
		if (!a) return ok({ live: false, message: "No app address yet." });
		const want = await installId(db);
		const got = await fetch(`https://${a.host}/.well-known/newsletter-sender`, { cf: { cacheTtl: 0 } } as RequestInit).then((r) => (r.ok ? r.text() : ""), () => "");
		// A Worker can't always reach its own custom domain, so the page checks from the browser too (want).
		return ok(got.trim() === want ? { live: true, message: `${a.host} is working.` } : { live: false, host: a.host, want, message: `Waiting for ${a.host}. Cloudflare usually takes a minute or two to make the certificate.` });
	}
	if (path === "/api/look/address" && method === "POST") {
		if (!(await currentLicence(db))) return bad("Your app address needs the agency licence. Add your key under Settings, Licence.", 403);
		const b = await body(request);
		const host = cleanHost(b.domain);
		if (!host) return bad("Please enter a subdomain of your agency's website, such as clients.youragency.co.uk.");
		if (host === url.hostname) {
			await setMeta(db, KEY, JSON.stringify({ host, only_here: a?.only_here ?? false }));
			return ok({ ok: true, domain: host, already: true });
		}
		let token = typeof b.token === "string" ? b.token.trim() : "";
		if (token && (token.length < 20 || token.length > 200 || /\s/.test(token))) return bad("Please paste the whole Cloudflare token, with no spaces.");
		const sealed = !token ? await unsealText(await sealSecret(db), await getMeta(db, TOKEN)) : null;
		if (!token) token = sealed || (await linksToken(db, brand)) || "";
		if (!token) return bad("Please make a Cloudflare token first, with the Make a Cloudflare token button.", 409);
		const zone = await findZone(token, host);
		if ("error" in zone) return bad(`${zone.error} Your agency's domain needs to be in this Cloudflare account.`);
		if (!zone.accountId) return bad("Cloudflare didn't tell us which account that domain is in. Please try again.");
		const problem = await linksNameProblem(token, zone, host);
		if (problem) return bad(problem);
		const r = await addWorkerDomain(token, zone, host, await workerName(token, zone.accountId, url.hostname));
		if ("error" in r) return r.token ? Response.json({ error: r.error, needToken: true }, { status: 409 }) : bad(r.error);
		if (b.token) await setMeta(db, TOKEN, await sealText(await sealSecret(db), token));
		await setMeta(db, KEY, JSON.stringify({ host, only_here: false }));
		return ok({ ok: true, domain: host, already: r.already });
	}
	return null;
}
