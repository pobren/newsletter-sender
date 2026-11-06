// Moving from another service. Mailchimp is read through its API (the key is used for the one request and never kept);
// Sendy and everything else come in as CSV files through the normal importer.

export type ImportStatus = "active" | "unsubscribed" | "bounced" | "complained";

/** Reads the status words other services use in their exports. Anything unknown counts as subscribed. */
export function importStatus(x: unknown): ImportStatus {
	const s = String(x ?? "").trim().toLowerCase();
	if (/^(unsub|opted.?out|optout|left|removed)/.test(s)) return "unsubscribed";
	if (/(spam|complain|abuse)/.test(s)) return "complained";
	if (/^(bounce|clean|hard|invalid|undeliverable)/.test(s)) return "bounced";
	return "active";
}

/** A join date from an export, as ISO, when it's a real date in the past. */
export function pastDate(x: unknown, now = Date.now()): string | null {
	if (x === undefined || x === null || x === "") return null;
	const raw = String(x).trim();
	// Sendy gives Unix seconds.
	const n = /^\d{9,11}$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw.replace(/^(\d{4}-\d\d-\d\d) /, "$1T"));
	if (!Number.isFinite(n) || n > now || n < Date.UTC(1995, 0, 1)) return null;
	return new Date(n).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const KEY = /^[0-9a-f]{32}-([a-z]{2,4}\d{1,3})$/;

export function mailchimpDc(key: string): string | null {
	return KEY.exec(key.trim())?.[1] ?? null;
}

const MC_STATUS: Record<string, ImportStatus | undefined> = { subscribed: "active", unsubscribed: "unsubscribed", cleaned: "bounced" };

export function mailchimpRow(m: any): { email: string; name: string; fields: Record<string, string>; tags: string[]; status: ImportStatus; joined: string } | null {
	const status = MC_STATUS[m?.status];
	if (!status || typeof m.email_address !== "string") return null;
	const merge = m.merge_fields ?? {};
	const name = [merge.FNAME, merge.LNAME].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
	const fields: Record<string, string> = {};
	for (const [k, v] of Object.entries(merge)) if (!["FNAME", "LNAME"].includes(k) && typeof v === "string" && v.trim()) fields[k.toLowerCase()] = v;
	const tags = Array.isArray(m.tags) ? m.tags.map((t: any) => String(t?.name ?? "")).filter(Boolean) : [];
	return { email: m.email_address, name, fields, tags, status, joined: m.timestamp_opt || m.timestamp_signup || "" };
}

const PAGE = 1000;

export async function mailchimp(key: string, audience: string | null, offset: number, fetcher: typeof fetch = fetch): Promise<any> {
	const dc = mailchimpDc(key);
	if (!dc) return { error: "That doesn't look like a Mailchimp API key. It ends with something like -us21." };
	const get = async (path: string) => {
		const res = await fetcher(`https://${dc}.api.mailchimp.com/3.0${path}`, { headers: { authorization: `Basic ${btoa(`move:${key.trim()}`)}` } });
		const data: any = await res.json().catch(() => ({}));
		if (res.status === 401 || res.status === 403) throw new Error("Mailchimp didn't accept that key. Please check you copied all of it.");
		if (!res.ok) throw new Error(data?.detail || "Mailchimp didn't answer just now. Please try again in a minute.");
		return data;
	};
	try {
		if (!audience) {
			const d = await get("/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count,lists.stats.unsubscribe_count,lists.stats.cleaned_count");
			return { audiences: (d.lists ?? []).map((l: any) => ({ id: l.id, name: l.name, subscribed: l.stats?.member_count ?? 0, unsubscribed: l.stats?.unsubscribe_count ?? 0, cleaned: l.stats?.cleaned_count ?? 0 })) };
		}
		if (!/^[0-9a-z]{1,20}$/i.test(audience)) return { error: "Please choose an audience." };
		const d = await get(`/lists/${audience}/members?count=${PAGE}&offset=${Math.max(0, offset | 0)}&fields=total_items,members.email_address,members.status,members.merge_fields,members.tags,members.timestamp_opt,members.timestamp_signup`);
		const rows = (d.members ?? []).map(mailchimpRow).filter(Boolean);
		const next = offset + PAGE < (d.total_items ?? 0) ? offset + PAGE : null;
		return { rows, total: d.total_items ?? 0, next, skipped: (d.members ?? []).length - rows.length };
	} catch (e) {
		return { error: (e as Error).message };
	}
}
