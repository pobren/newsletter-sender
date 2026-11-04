// The brand's sending set-up: saving the owner's keys (encrypted), and for Amazon SES doing the set-up for them:
// the domain with its DKIM signing, a bounce subdomain, and a configuration set that reports every bounce and spam
// complaint straight back to this Worker through Amazon SNS.

import { awsError, ses, sesAccount, sns, xmlValue } from "./aws.ts";
import { getMeta, iso, newId, origin, setMeta, type BrandRow } from "./db.ts";
import { seal, sesKeys, unseal, type ProviderConfig } from "./providers.ts";

/** The key that encrypts sending keys in the database, made once per install. */
export async function sealSecret(db: D1Database): Promise<string> {
	let key = await getMeta(db, "seal_key");
	if (!key) {
		key = newId(32);
		await setMeta(db, "seal_key", key);
	}
	return key;
}

export async function loadProvider(db: D1Database, brand: BrandRow): Promise<ProviderConfig | null> {
	return unseal(await sealSecret(db), brand.provider);
}

export async function saveProvider(db: D1Database, brandId: string, c: ProviderConfig | null, rate: number): Promise<void> {
	await db.prepare("UPDATE brands SET provider = ?, rate = ? WHERE id = ?").bind(c ? await seal(await sealSecret(db), c) : null, rate, brandId).run();
}

export const CONFIG_SET = "newsletter-sender";
export const TOPIC = "newsletter-sender-events";

export interface DnsRecord {
	type: "CNAME" | "MX" | "TXT";
	name: string;
	value: string;
	priority?: number;
	why: string;
	optional?: boolean;
}

/** The records that let Amazon SES send for a domain, with bounces kept on their own subdomain. */
export function sesRecords(domain: string, tokens: string[], region: string): DnsRecord[] {
	return [
		...tokens.map((t): DnsRecord => ({ type: "CNAME", name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com`, why: "Signs your emails (DKIM), so inboxes know they're really from you." })),
		{ type: "MX", name: `bounce.${domain}`, value: `feedback-smtp.${region}.amazonses.com`, priority: 10, why: "Bounces come back to Amazon here, not to your inbox." },
		{ type: "TXT", name: `bounce.${domain}`, value: "v=spf1 include:amazonses.com ~all", why: "Says Amazon SES may send for your bounce address (SPF)." },
		{ type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none;", why: "Only if your domain has no DMARC record yet. If it has one, keep yours.", optional: true },
	];
}

export interface SesSetup {
	domain: string;
	region: string;
	tokens: string[];
	topicArn: string | null;
	at: string;
}

const setupKey = (brandId: string) => `ses_setup:${brandId}`;

export async function sesSetup(db: D1Database, brandId: string): Promise<SesSetup | null> {
	try {
		return JSON.parse((await getMeta(db, setupKey(brandId))) ?? "null");
	} catch {
		return null;
	}
}

/**
 * Sets Amazon SES up for the brand's sending domain. Safe to run again: anything already there is kept.
 * Returns the DNS records to add, or what went wrong.
 */
export async function setUpSes(db: D1Database, brand: BrandRow, c: ProviderConfig, request: Request, fetcher: typeof fetch = fetch): Promise<{ records: DnsRecord[]; steps: string[] } | { error: string }> {
	const keys = sesKeys(c);
	const domain = brand.from_email.split("@")[1]?.toLowerCase();
	if (!domain) return { error: "Please set the address you send from first." };
	const steps: string[] = [];

	// 1. The domain, with Easy DKIM.
	let tokens: string[] = [];
	const made = await ses(keys, "POST", "/identities", { EmailIdentity: domain }, fetcher);
	if (made.ok) {
		tokens = made.data?.DkimAttributes?.Tokens ?? [];
		steps.push(`Added ${domain} to Amazon SES`);
	} else if (/AlreadyExists/i.test(made.text)) {
		const got = await ses(keys, "GET", `/identities/${encodeURIComponent(domain)}`, null, fetcher);
		if (!got.ok) return { error: awsError(got) };
		tokens = got.data?.DkimAttributes?.Tokens ?? [];
		steps.push(`${domain} was already in Amazon SES`);
	} else return { error: awsError(made) };

	// 2. Bounces on bounce.<domain>, so the domain's own mail isn't touched.
	const mf = await ses(keys, "PUT", `/identities/${encodeURIComponent(domain)}/mail-from`, { MailFromDomain: `bounce.${domain}`, BehaviorOnMxFailure: "USE_DEFAULT_VALUE" }, fetcher);
	if (!mf.ok) return { error: awsError(mf) };
	steps.push(`Bounces set to bounce.${domain}`);

	// 3. A configuration set whose bounces and complaints go to an SNS topic, and the topic to this Worker.
	const cs = await ses(keys, "POST", "/configuration-sets", { ConfigurationSetName: CONFIG_SET }, fetcher);
	if (!cs.ok && !/AlreadyExists/i.test(cs.text)) return { error: awsError(cs) };
	const topic = await sns(keys, { Action: "CreateTopic", Name: TOPIC }, fetcher);
	const topicArn = xmlValue(topic.text, "TopicArn");
	if (!topic.ok || !topicArn) return { error: awsError(topic) };
	const base = await origin(db, request);
	const sub = await sns(keys, { Action: "Subscribe", TopicArn: topicArn, Protocol: "https", Endpoint: `${base}/hooks/ses/${brand.hook_key}`, ReturnSubscriptionArn: "true" }, fetcher);
	if (!sub.ok) return { error: awsError(sub) };
	const dest = { EventDestinationName: "newsletter-sender", EventDestination: { Enabled: true, MatchingEventTypes: ["BOUNCE", "COMPLAINT"], SnsDestination: { TopicArn: topicArn } } };
	let ed = await ses(keys, "POST", `/configuration-sets/${CONFIG_SET}/event-destinations`, dest, fetcher);
	if (!ed.ok && /AlreadyExists/i.test(ed.text)) ed = await ses(keys, "PUT", `/configuration-sets/${CONFIG_SET}/event-destinations/newsletter-sender`, { EventDestination: dest.EventDestination }, fetcher);
	if (!ed.ok) return { error: awsError(ed) };
	steps.push("Bounces and spam complaints now come straight back to Newsletter Sender");

	await saveProvider(db, brand.id, { ...c, configSet: CONFIG_SET }, brand.rate);
	await setMeta(db, setupKey(brand.id), JSON.stringify({ domain, region: keys.region, tokens, topicArn, at: iso() } satisfies SesSetup));
	return { records: sesRecords(domain, tokens, keys.region), steps };
}

export interface SesStatus {
	domain: string;
	verified: boolean;
	dkim: string;
	bounceDomain: string;
	production: boolean;
	rate: number;
	max24: number;
	sent24: number;
}

/** Where the domain is up to in Amazon SES, and the account's limits. */
export async function sesStatus(c: ProviderConfig, domain: string, fetcher: typeof fetch = fetch): Promise<SesStatus | { error: string }> {
	const keys = sesKeys(c);
	const acct = await sesAccount(keys, fetcher);
	if ("error" in acct) return acct;
	const got = await ses(keys, "GET", `/identities/${encodeURIComponent(domain)}`, null, fetcher);
	if (!got.ok) return { error: /NotFound/i.test(got.text) ? `${domain} isn't in Amazon SES yet. Press Set up Amazon SES for me.` : awsError(got) };
	return {
		domain,
		verified: Boolean(got.data?.VerifiedForSendingStatus),
		dkim: String(got.data?.DkimAttributes?.Status ?? "NOT_STARTED"),
		bounceDomain: String(got.data?.MailFromAttributes?.MailFromDomainStatus ?? "NOT_STARTED"),
		...acct,
	};
}
