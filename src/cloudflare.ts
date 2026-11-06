// Adding DNS records for the owner when their domain is on Cloudflare, with an API token that can edit DNS.

import type { DnsRecord } from "./settings.ts";

const API = "https://api.cloudflare.com/client/v4";

async function cf(token: string, method: string, path: string, body: unknown, fetcher: typeof fetch): Promise<{ ok: boolean; data: any; message: string }> {
	const res = await fetcher(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const data: any = await res.json().catch(() => null);
	const message = data?.errors?.map((e: any) => e.message).join(" ") || (res.ok ? "" : `error ${res.status}`);
	return { ok: res.ok && data?.success !== false, data, message };
}

/** The domains (zones) this token can see, by name. */
export async function listZones(token: string, fetcher: typeof fetch = fetch): Promise<string[]> {
	const r = await cf(token, "GET", "/zones?per_page=50&status=active", null, fetcher);
	return r.ok ? (r.data?.result ?? []).map((z: any) => String(z.name)).sort() : [];
}

/** The Cloudflare zone a domain (or one of its subdomains) lives in, if this token can see it. */
export async function findZone(token: string, domain: string, fetcher: typeof fetch = fetch): Promise<{ id: string; name: string; accountId: string } | { error: string }> {
	const labels = domain.toLowerCase().split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		const name = labels.slice(i).join(".");
		const r = await cf(token, "GET", `/zones?name=${encodeURIComponent(name)}`, null, fetcher);
		if (!r.ok) return { error: r.message.includes("Invalid") || r.message.includes("Authentication") ? "Cloudflare didn't accept that token. Please check you copied all of it." : `Cloudflare said: ${r.message}` };
		const z = r.data?.result?.[0];
		if (z?.id) return { id: z.id, name: z.name, accountId: z.account?.id ?? "" };
	}
	return { error: `That token can't see ${domain} in Cloudflare. Make sure the token covers this domain's zone, or that the domain is on Cloudflare.` };
}

/**
 * Adds the records to the zone, never proxied (Amazon must see them as they are). Records already there are left alone,
 * and the optional DMARC record is only added when the domain has none.
 */
export async function addRecords(token: string, zoneId: string, records: DnsRecord[], fetcher: typeof fetch = fetch): Promise<{ added: number; there: number; failed: string[] }> {
	let added = 0, there = 0;
	const failed: string[] = [];
	for (const r of records) {
		if (r.optional) {
			const have = await cf(token, "GET", `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(r.name)}`, null, fetcher);
			if (have.ok && (have.data?.result ?? []).some((x: any) => /^"?v=DMARC1/i.test(String(x.content)))) { there++; continue; }
		}
		const body: Record<string, unknown> = { type: r.type, name: r.name, content: r.value, ttl: 1, comment: "Added by Newsletter Sender for Amazon SES" };
		if (r.type === "CNAME") body.proxied = false;
		if (r.type === "MX") body.priority = r.priority ?? 10;
		const made = await cf(token, "POST", `/zones/${zoneId}/dns_records`, body, fetcher);
		if (made.ok) added++;
		else if (/already exists|identical record/i.test(made.message)) there++;
		else failed.push(`${r.type} ${r.name}: ${made.message}`);
	}
	return { added, there, failed };
}

/**
 * The Cloudflare page that makes one token for everything Newsletter Sender does in Cloudflare: Amazon SES's DNS records,
 * and pointing your own domain for links at this Worker.
 */
export const TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify([{ key: "dns", type: "edit" }, { key: "zone", type: "read" }, { key: "workers_routes", type: "edit" }, { key: "workers_scripts", type: "edit" }]))}&name=${encodeURIComponent("Newsletter Sender")}`;
export const LINKS_TOKEN_URL = TOKEN_URL;

/** Whether a token can add custom domains to Workers in this zone's account (tokens made before it could only do DNS). */
export async function canAddWorkerDomains(token: string, domain: string, fetcher: typeof fetch = fetch): Promise<boolean> {
	const zone = await findZone(token, domain, fetcher);
	if ("error" in zone || !zone.accountId) return false;
	return (await cf(token, "GET", `/accounts/${zone.accountId}/workers/domains?hostname=${encodeURIComponent(`check.${zone.name}`)}`, null, fetcher)).ok;
}

/** Which Worker is answering: the first part of a workers.dev address, or the Worker a custom domain points at. */
export async function workerName(token: string, accountId: string, host: string, fetcher: typeof fetch = fetch): Promise<string> {
	const dev = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/i.exec(host);
	if (dev) return dev[1].toLowerCase();
	const r = await cf(token, "GET", `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(host)}`, null, fetcher);
	return r.data?.result?.[0]?.service || "newsletter-sender";
}

/**
 * Points a hostname such as news.yourdomain.com at this Worker as a Cloudflare custom domain. Cloudflare makes the DNS
 * record and the certificate itself. Says plainly when the token can't do it, so the app can ask for a better one.
 */
/** Names that are nearly always in use for a website or email, so never offered for links. */
const BUSY = /^(www|mail|webmail|smtp|imap|pop|pop3|mx|autodiscover|autoconfig|ftp|cpanel|whm|webdisk|admin|shop|blog|app|api)\./;

/**
 * Why a name can't be used for links, or null when it's safe: never the main domain (that would take over the website),
 * never a name used for a website or email, and never a name that already has a DNS record.
 */
export async function linksNameProblem(token: string, zone: { id: string; name: string }, hostname: string, fetcher: typeof fetch = fetch): Promise<string | null> {
	const suggest = `news.${zone.name}`;
	if (hostname === zone.name) return `${hostname} is your main domain. Using it for links would stop your website working. Please use a new subdomain, such as ${suggest}.`;
	if (BUSY.test(hostname)) return `${hostname} is usually used for your website or email. Please use a new subdomain, such as ${suggest}.`;
	const have = await cf(token, "GET", `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`, null, fetcher);
	if (have.ok && (have.data?.result ?? []).length) return `${hostname} is already in use (it has a DNS record in Cloudflare), so we've left it alone. Please choose a new subdomain, such as ${suggest}.`;
	return null;
}

export async function addWorkerDomain(token: string, zone: { id: string; accountId: string }, hostname: string, service: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; already: boolean } | { error: string; token?: boolean }> {
	const have = await cf(token, "GET", `/accounts/${zone.accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`, null, fetcher);
	if (!have.ok) return { error: "This Cloudflare token can't add custom domains to Workers. Please press Make a Cloudflare token above, make the new token and paste it in.", token: true };
	const there = (have.data?.result ?? []).find((d: any) => d.hostname === hostname);
	if (there?.service === service) return { ok: true, already: true };
	if (there) return { error: `${hostname} already points at another Worker (${there.service}). Choose another name, such as links.${hostname.split(".").slice(1).join(".")}.` };
	const r = await cf(token, "PUT", `/accounts/${zone.accountId}/workers/domains`, { hostname, service, zone_id: zone.id, environment: "production" }, fetcher);
	if (r.ok) return { ok: true, already: false };
	if (/auth|permission|10000|9109/i.test(r.message)) return { error: "This Cloudflare token can't add custom domains to Workers. Please press Make a Cloudflare token above, make the new token and paste it in.", token: true };
	if (/record|cname|exist/i.test(r.message)) return { error: `There's already a DNS record for ${hostname}. Delete it in Cloudflare (DNS, Records), or choose another name, then try again.` };
	return { error: `Cloudflare said: ${r.message}` };
}

/** Well known DNS hosts, by the end of their nameserver names. */
const HOSTS: [RegExp, string][] = [
	[/\.ns\.cloudflare\.com$/, "Cloudflare"], [/domaincontrol\.com$/, "GoDaddy"], [/awsdns/, "Amazon Route 53"], [/googledomains\.com$|\.google\.com$/, "Google"],
	[/registrar-servers\.com$/, "Namecheap"], [/ui-dns\.|ionos/, "IONOS"], [/123-reg\.co\.uk$/, "123 Reg"], [/fasthosts\.net\.uk$|fasthosts\.co\.uk$/, "Fasthosts"],
	[/porkbun\.com$/, "Porkbun"], [/hover\.com$/, "Hover"], [/name\.com$/, "Name.com"], [/dnsimple\.com$/, "DNSimple"], [/digitalocean\.com$/, "DigitalOcean"],
	[/squarespacedns\.com$/, "Squarespace"], [/wixdns\.net$/, "Wix"], [/gandi\.net$/, "Gandi"], [/ovh\.net$/, "OVH"], [/hetzner/, "Hetzner"], [/vercel-dns\.com$/, "Vercel"], [/nsone\.net$/, "NS1"],
];

/**
 * Who runs a domain's DNS, from its nameservers (looked up over DNS over HTTPS, walking up from a subdomain).
 * Lets the wizard say "your domain is on Cloudflare" instead of asking.
 */
export async function dnsHost(domain: string, fetcher: typeof fetch = fetch): Promise<{ zone: string; nameservers: string[]; host: string | null; cloudflare: boolean } | { error: string }> {
	const labels = domain.toLowerCase().split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		const name = labels.slice(i).join(".");
		const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=NS`, { headers: { accept: "application/dns-json" } }).catch(() => null);
		if (!res || !res.ok) return { error: "We couldn't look up your domain's DNS just now." };
		const data: any = await res.json().catch(() => null);
		const ns = (data?.Answer ?? []).filter((a: any) => a.type === 2).map((a: any) => String(a.data).toLowerCase().replace(/\.$/, ""));
		if (ns.length) {
			const host = HOSTS.find(([re]) => ns.some((n: string) => re.test(n)))?.[1] ?? null;
			return { zone: name, nameservers: ns, host, cloudflare: host === "Cloudflare" };
		}
	}
	return { error: `We couldn't find the DNS for ${domain}.` };
}
