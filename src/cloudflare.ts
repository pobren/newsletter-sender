// Adding DNS records for the owner when their domain is on Cloudflare, with an API token that can edit DNS.

import type { DnsRecord } from "./settings.ts";

const API = "https://api.cloudflare.com/client/v4";

async function cf(token: string, method: string, path: string, body: unknown, fetcher: typeof fetch): Promise<{ ok: boolean; data: any; message: string }> {
	const res = await fetcher(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const data: any = await res.json().catch(() => null);
	const message = data?.errors?.map((e: any) => e.message).join(" ") || (res.ok ? "" : `error ${res.status}`);
	return { ok: res.ok && data?.success !== false, data, message };
}

/** The Cloudflare zone a domain (or one of its subdomains) lives in, if this token can see it. */
export async function findZone(token: string, domain: string, fetcher: typeof fetch = fetch): Promise<{ id: string; name: string } | { error: string }> {
	const labels = domain.toLowerCase().split(".");
	for (let i = 0; i < labels.length - 1; i++) {
		const name = labels.slice(i).join(".");
		const r = await cf(token, "GET", `/zones?name=${encodeURIComponent(name)}`, null, fetcher);
		if (!r.ok) return { error: r.message.includes("Invalid") || r.message.includes("Authentication") ? "Cloudflare didn't accept that token. Please check you copied all of it." : `Cloudflare said: ${r.message}` };
		const z = r.data?.result?.[0];
		if (z?.id) return { id: z.id, name: z.name };
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

/** The Cloudflare page that makes a token with just DNS editing filled in. */
export const TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(JSON.stringify([{ key: "dns", type: "edit" }, { key: "zone", type: "read" }]))}&name=${encodeURIComponent("Newsletter Sender DNS")}`;
