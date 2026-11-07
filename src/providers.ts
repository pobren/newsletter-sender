// Sending services. Newsletters go out through Amazon SES (the main way, at the account's full speed) or the owner's
// own Postmark, Mailgun, Brevo or Resend. Cloudflare's own email service only sends sign up confirmations and other
// one off emails (Cloudflare describes it as for transactional email), never newsletters.
//
// The owner's keys are kept encrypted in the database (seal / unseal), and never shown again once saved.

import { ses, type AwsKeys } from "./aws.ts";

export type ProviderId = "ses" | "postmark" | "mailgun" | "brevo" | "resend";

export const PROVIDERS: { id: ProviderId; name: string; keyLabel: string; help: string }[] = [
	{ id: "ses", name: "Amazon SES", keyLabel: "Secret access key", help: "In AWS: IAM, Users, your sending user, Security credentials, Create access key." },
	{ id: "postmark", name: "Postmark", keyLabel: "Server API token", help: "In Postmark: your server, API Tokens. Newsletters go through its Broadcast stream." },
	{ id: "mailgun", name: "Mailgun", keyLabel: "Sending API key", help: "In Mailgun: Send, Sending, Domain settings, Sending keys." },
	{ id: "brevo", name: "Brevo", keyLabel: "API key", help: "In Brevo: your name, SMTP & API, API keys." },
	{ id: "resend", name: "Resend", keyLabel: "API key", help: "In Resend: API Keys, Create API key (Full access, so we can add the bounce webhook)." },
];
export const isProvider = (x: unknown): x is ProviderId => PROVIDERS.some((p) => p.id === x);
export const providerName = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!.name;

export interface ProviderConfig {
	provider: ProviderId;
	/** The API key, token or (for SES) secret access key. */
	key: string;
	/** Amazon SES only. */
	accessKeyId?: string;
	region?: string;
	/** Amazon SES only: the configuration set that reports bounces and complaints back to us. */
	configSet?: string;
	/** Amazon SES only: a Cloudflare API token that can edit DNS, so we add the records ourselves. */
	cfToken?: string;
	/** Mailgun only: the sending domain, and whether the account is in Mailgun's EU region. */
	mailgunDomain?: string;
	mailgunRegion?: "us" | "eu";
	/** Postmark, Mailgun, Brevo or Resend: we added our bounce and complaint webhook there ourselves. */
	hookAdded?: boolean;
}

export const sesKeys = (c: ProviderConfig): AwsKeys => ({ accessKeyId: c.accessKeyId ?? "", secretAccessKey: c.key, region: c.region ?? "eu-west-1" });

/** A tidy provider set-up from the form, or what's wrong with it. */
export function parseProvider(input: Record<string, unknown>, fromEmail: string): ProviderConfig | { error: string } {
	if (!isProvider(input.provider)) return { error: "Please choose how to send." };
	const key = typeof input.key === "string" ? input.key.trim() : "";
	if (key.length < 10 || key.length > 300 || /\s/.test(key)) return { error: "Please paste the whole key, with no spaces." };
	const out: ProviderConfig = { provider: input.provider, key };
	if (input.provider === "ses") {
		const id = typeof input.accessKeyId === "string" ? input.accessKeyId.trim() : "";
		if (!/^[A-Z0-9]{16,128}$/.test(id)) return { error: "Please paste the access key ID too. It starts with AKIA." };
		const region = typeof input.region === "string" ? input.region.trim() : "";
		if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) return { error: "Please choose the AWS region your SES account is in, such as eu-west-1." };
		out.accessKeyId = id;
		out.region = region;
	}
	if (input.provider === "mailgun") {
		const d = typeof input.mailgunDomain === "string" && input.mailgunDomain.trim() ? input.mailgunDomain.trim().toLowerCase() : fromEmail.split("@")[1] ?? "";
		if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { error: "Please enter your Mailgun sending domain, such as mg.example.com." };
		out.mailgunDomain = d;
		out.mailgunRegion = input.mailgunRegion === "eu" ? "eu" : "us";
	}
	return out;
}

/** What the owner sees about their sending set-up: never the key itself. */
export function providerSummary(c: ProviderConfig | null) {
	if (!c) return null;
	return { provider: c.provider, name: providerName(c.provider), region: c.region ?? null, mailgunDomain: c.mailgunDomain ?? null, keyEnd: c.key.slice(-4), bounces: c.provider === "ses" ? Boolean(c.configSet) : Boolean(c.hookAdded), cloudflareDns: Boolean(c.cfToken) };
}

export interface OutEmail {
	to: string;
	subject: string;
	text: string;
	html: string;
	headers: Record<string, string>;
	replyTo?: string | null;
	/** Tags that come back with SES bounce and complaint events. Letters, numbers, _ - . only. */
	tags?: Record<string, string>;
}

export interface Sent {
	ok: boolean;
	/** The provider's id for the email, when it gives one. */
	id?: string;
	/** "slow down": put it back and try again in a moment. */
	throttled?: boolean;
	/** A problem with this one address (it won't work next time either). */
	permanent?: boolean;
	/** The account's daily sending limit is used up. */
	quota?: boolean;
	error?: string;
}

const quoteName = (n: string) => `"${n.replace(/["\\\r\n]/g, "")}"`;

/** The HTTP call that sends one email through a key-based service (everything but SES). */
export function providerRequest(c: ProviderConfig, fromName: string, fromEmail: string, m: OutEmail): { url: string; init: RequestInit } {
	const from = `${quoteName(fromName)} <${fromEmail}>`;
	const headers = m.headers;
	// Brevo turns down an empty headers object ("headers is blank"), so leave it out when there are none.
	const someHeaders = Object.keys(headers).length > 0;
	if (c.provider === "mailgun") {
		const form = new URLSearchParams({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
		if (m.replyTo) form.set("h:Reply-To", m.replyTo);
		for (const [k, v] of Object.entries(headers)) form.set(`h:${k}`, v);
		for (const [k, v] of Object.entries(m.tags ?? {})) form.set(`v:${k}`, v);
		// We track opens and clicks ourselves, so ask Mailgun not to wrap our links or add its own pixel.
		form.set("o:tracking", "no");
		form.set("o:tracking-clicks", "no");
		form.set("o:tracking-opens", "no");
		const host = c.mailgunRegion === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
		return {
			url: `https://${host}/v3/${encodeURIComponent(c.mailgunDomain ?? fromEmail.split("@")[1])}/messages`,
			init: { method: "POST", headers: { authorization: `Basic ${btoa(`api:${c.key}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
		};
	}
	if (c.provider === "brevo") {
		// Brevo's send API has no switch for its own open and click tracking, so it wraps our links too.
		return {
			url: "https://api.brevo.com/v3/smtp/email",
			init: {
				method: "POST",
				headers: { "api-key": c.key, "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ sender: { name: fromName, email: fromEmail }, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html, ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}), ...(someHeaders ? { headers } : {}) }),
			},
		};
	}
	if (c.provider === "resend") {
		return {
			url: "https://api.resend.com/emails",
			init: {
				method: "POST",
				headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json" },
				body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html, ...(m.replyTo ? { reply_to: m.replyTo } : {}), ...(someHeaders ? { headers } : {}), ...(m.tags ? { tags: Object.entries(m.tags).map(([name, value]) => ({ name, value })) } : {}) }),
			},
		};
	}
	return {
		url: "https://api.postmarkapp.com/email",
		init: {
			method: "POST",
			headers: { "x-postmark-server-token": c.key, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ From: from, To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, ...(m.replyTo ? { ReplyTo: m.replyTo } : {}), Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })), Metadata: m.tags ?? {}, MessageStream: "broadcast", TrackOpens: false, TrackLinks: "None" }),
		},
	};
}

/** The SES v2 SendEmail body for one email. */
export function sesBody(c: ProviderConfig, fromName: string, fromEmail: string, m: OutEmail) {
	return {
		FromEmailAddress: `${quoteName(fromName)} <${fromEmail}>`,
		Destination: { ToAddresses: [m.to] },
		...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
		Content: {
			Simple: {
				Subject: { Data: m.subject, Charset: "UTF-8" },
				Body: { Text: { Data: m.text, Charset: "UTF-8" }, Html: { Data: m.html, Charset: "UTF-8" } },
				Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
			},
		},
		...(m.tags ? { EmailTags: Object.entries(m.tags).map(([Name, Value]) => ({ Name, Value })) } : {}),
		...(c.configSet ? { ConfigurationSetName: c.configSet } : {}),
	};
}

/** Sends one email and says how it went. Never throws. */
export async function sendOne(c: ProviderConfig, fromName: string, fromEmail: string, m: OutEmail, fetcher: typeof fetch = fetch): Promise<Sent> {
	try {
		if (c.provider === "ses") {
			const a = await ses(sesKeys(c), "POST", "/outbound-emails", sesBody(c, fromName, fromEmail, m), fetcher);
			if (a.ok) return { ok: true, id: a.data?.MessageId };
			return classify(a.status, a.text);
		}
		const { url, init } = providerRequest(c, fromName, fromEmail, m);
		const res = await fetcher(url, init);
		const text = await res.text();
		if (res.ok) {
			let d: any = null;
			try {
				d = JSON.parse(text);
			} catch {}
			return { ok: true, id: d?.MessageID ?? d?.messageId ?? d?.id ?? undefined };
		}
		return classify(res.status, text);
	} catch (e) {
		return { ok: false, throttled: true, error: `Couldn't reach the sending service: ${(e as Error).message}` };
	}
}

/** Sorts a failed send into "slow down and retry", "this address won't work" or "something else is wrong". */
export function classify(status: number, text: string): Sent {
	const error = text.replace(/\s+/g, " ").slice(0, 240) || `Error ${status}`;
	if (/Daily message quota exceeded|daily (sending )?(quota|limit)/i.test(text)) return { ok: false, throttled: true, quota: true, error };
	if (status === 429 || /Throttl|TooManyRequests|Maximum sending rate exceeded|rate limit/i.test(text)) return { ok: false, throttled: true, error };
	if (status >= 500) return { ok: false, throttled: true, error };
	// An address the service refuses outright (on its suppression list, or not a valid address).
	if (/InvalidParameterValue.*(address|Destination)|Illegal address|inactive recipient|is not a valid email|suppress/i.test(text)) return { ok: false, permanent: true, error };
	return { ok: false, error };
}

// -- Keys kept sealed ---------------------------------------------------------------

async function sealKey(secret: string): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`newsletter-sender-provider:${secret}`));
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function seal(secret: string, c: ProviderConfig): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret), new TextEncoder().encode(JSON.stringify(c)));
	return `${b64(iv)}.${b64(new Uint8Array(out))}`;
}

/** Any other secret kept the same way, such as the Cloudflare token for your own link domain. */
export async function sealText(secret: string, text: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret), new TextEncoder().encode(text));
	return `${b64(iv)}.${b64(new Uint8Array(out))}`;
}

export async function unsealText(secret: string, sealed: string | null): Promise<string | null> {
	if (!sealed) return null;
	try {
		const [iv, data] = sealed.split(".");
		return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await sealKey(secret), unb64(data)));
	} catch {
		return null;
	}
}

export async function unseal(secret: string, sealed: string | null): Promise<ProviderConfig | null> {
	if (!sealed) return null;
	try {
		const [iv, data] = sealed.split(".");
		const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await sealKey(secret), unb64(data));
		const c = JSON.parse(new TextDecoder().decode(out));
		return isProvider(c?.provider) ? (c as ProviderConfig) : null;
	} catch {
		return null;
	}
}

// -- Bounces and complaints coming back ------------------------------------------------

export interface MailEvent {
	/** An unsubscribe comes from a service's own unsubscribe link (Postmark adds one until it lets us use ours). */
	kind: "bounce" | "complaint" | "unsubscribe";
	/** A hard bounce or a complaint: never email this address again. A soft bounce only counts. */
	permanent: boolean;
	addresses: string[];
	detail: string;
	/** The subscriber and campaign, when the service hands back the tags we sent. */
	sub?: string;
	campaign?: string;
}

const addrs = (list: unknown[]) => list.map((a) => String(typeof a === "object" && a ? (a as any).emailAddress ?? (a as any).email ?? "" : a).trim().toLowerCase()).filter((a) => a.includes("@")).slice(0, 50);
const tag = (x: unknown) => (typeof x === "string" && /^[0-9a-f]{8,40}$/.test(x) ? x : undefined);

/** An SES event (the Message inside an SNS notification). Null for anything we don't act on. */
export function parseSesEvent(message: any): MailEvent | null {
	const type = message?.eventType ?? message?.notificationType;
	const tags = message?.mail?.tags ?? {};
	const extra = { sub: tag(tags.ns_sub?.[0]), campaign: tag(tags.ns_campaign?.[0]) };
	if (type === "Bounce" && message.bounce) {
		const b = message.bounce;
		return { kind: "bounce", permanent: b.bounceType === "Permanent", addresses: addrs(b.bouncedRecipients ?? []), detail: [b.bounceType, b.bounceSubType].filter(Boolean).join(": "), ...extra };
	}
	if (type === "Complaint" && message.complaint) {
		return { kind: "complaint", permanent: true, addresses: addrs(message.complaint.complainedRecipients ?? []), detail: message.complaint.complaintFeedbackType ?? "Marked as spam", ...extra };
	}
	return null;
}

/** A bounce or complaint webhook from Postmark, Mailgun, Brevo or Resend. */
export function parseProviderEvent(provider: ProviderId, body: any): MailEvent | null {
	if (provider === "postmark") {
		if (body?.RecordType === "Bounce") {
			const hard = ["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "SpamNotification"].includes(body.Type);
			return { kind: "bounce", permanent: hard, addresses: addrs([body.Email]), detail: String(body.Type ?? "Bounce"), sub: tag(body.Metadata?.ns_sub), campaign: tag(body.Metadata?.ns_campaign) };
		}
		if (body?.RecordType === "SpamComplaint") return { kind: "complaint", permanent: true, addresses: addrs([body.Email]), detail: "Marked as spam", sub: tag(body.Metadata?.ns_sub), campaign: tag(body.Metadata?.ns_campaign) };
		// Someone pressed Postmark's own unsubscribe link. Bounces and complaints arrive on their own as well.
		if (body?.RecordType === "SubscriptionChange" && body.SuppressSending === true && body.SuppressionReason === "ManualSuppression") return { kind: "unsubscribe", permanent: false, addresses: addrs([body.Recipient]), detail: "Postmark unsubscribe link", sub: tag(body.Metadata?.ns_sub), campaign: tag(body.Metadata?.ns_campaign) };
		return null;
	}
	if (provider === "mailgun") {
		const e = body?.["event-data"];
		const vars = e?.["user-variables"] ?? {};
		if (e?.event === "failed") return { kind: "bounce", permanent: e.severity === "permanent", addresses: addrs([e.recipient]), detail: String(e["delivery-status"]?.description || e.reason || "Failed").slice(0, 120), sub: tag(vars.ns_sub), campaign: tag(vars.ns_campaign) };
		if (e?.event === "complained") return { kind: "complaint", permanent: true, addresses: addrs([e.recipient]), detail: "Marked as spam", sub: tag(vars.ns_sub), campaign: tag(vars.ns_campaign) };
		return null;
	}
	if (provider === "brevo") {
		if (body?.event === "hard_bounce" || body?.event === "soft_bounce" || body?.event === "invalid_email") return { kind: "bounce", permanent: body.event !== "soft_bounce", addresses: addrs([body.email]), detail: String(body.reason ?? body.event) };
		if (body?.event === "spam" || body?.event === "complaint") return { kind: "complaint", permanent: true, addresses: addrs([body.email]), detail: "Marked as spam" };
		return null;
	}
	if (provider === "resend") {
		const d = body?.data ?? {};
		const tags = Object.fromEntries((Array.isArray(d.tags) ? d.tags : []).map((t: any) => [t?.name, t?.value]));
		if (body?.type === "email.bounced") return { kind: "bounce", permanent: (d.bounce?.type ?? "Permanent") === "Permanent", addresses: addrs(Array.isArray(d.to) ? d.to : [d.to]), detail: String(d.bounce?.message ?? "Bounced").slice(0, 120), sub: tag(tags.ns_sub), campaign: tag(tags.ns_campaign) };
		if (body?.type === "email.complained") return { kind: "complaint", permanent: true, addresses: addrs(Array.isArray(d.to) ? d.to : [d.to]), detail: "Marked as spam", sub: tag(tags.ns_sub), campaign: tag(tags.ns_campaign) };
		return null;
	}
	return null;
}

/** Where SNS may send us to confirm a subscription: only Amazon's own SNS addresses. */
export function trustedSubscribeUrl(url: unknown): boolean {
	try {
		const u = new URL(String(url));
		return u.protocol === "https:" && /^sns\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com$/.test(u.hostname) && u.searchParams.get("Action") === "ConfirmSubscription";
	} catch {
		return false;
	}
}

// -- Bounce and complaint webhooks, added for the owner ----------------------------------------------------

/**
 * Adds our bounce and spam complaint webhook in Postmark, Mailgun, Brevo or Resend, with the key the owner has just
 * pasted, so they don't have to do it by hand. Leaves any webhooks they already have alone, and does nothing if ours is
 * already there. Never throws: says what went wrong instead, so the owner can add it themselves.
 */
export async function addWebhook(c: ProviderConfig, hookUrl: string, fetcher: typeof fetch = fetch): Promise<{ ok: true } | { error: string }> {
	const name = providerName(c.provider);
	const call = async (url: string, init: RequestInit) => {
		const res = await fetcher(url, init);
		const text = await res.text();
		let data: any = null;
		try {
			data = JSON.parse(text);
		} catch {}
		return { ok: res.ok, status: res.status, data, text };
	};
	const failed = (r: { status: number; text: string }) => {
		if (r.status === 401 || r.status === 403) return { error: `${name} didn't let this key add webhooks${c.provider === "resend" ? " (a Sending access key can't; a Full access key can)" : ""}. Add the address below in ${name} yourself.` };
		return { error: `${name} said: ${r.text.replace(/\s+/g, " ").slice(0, 160) || `error ${r.status}`}` };
	};
	try {
		if (c.provider === "postmark") {
			const h = { "x-postmark-server-token": c.key, accept: "application/json", "content-type": "application/json" };
			// Use our own unsubscribe link and header instead of Postmark's. Postmark only allows this once it has
			// approved the account; until then its link stays, and SubscriptionChange below tells us who used it.
			await call("https://api.postmarkapp.com/message-streams/broadcast", { method: "PATCH", headers: h, body: JSON.stringify({ SubscriptionManagementConfiguration: { UnsubscribeHandlingType: "Custom" } }) }).catch(() => null);
			const triggers = { Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false }, SubscriptionChange: { Enabled: true } };
			const list = await call("https://api.postmarkapp.com/webhooks?MessageStream=broadcast", { headers: h });
			if (!list.ok) return failed(list);
			const have = (list.data?.Webhooks ?? []).find((w: any) => w?.Url === hookUrl);
			const r = have
				? await call(`https://api.postmarkapp.com/webhooks/${encodeURIComponent(have.ID)}`, { method: "PUT", headers: h, body: JSON.stringify({ Url: hookUrl, Triggers: triggers }) })
				: await call("https://api.postmarkapp.com/webhooks", { method: "POST", headers: h, body: JSON.stringify({ Url: hookUrl, MessageStream: "broadcast", Triggers: triggers }) });
			return r.ok ? { ok: true } : failed(r);
		}
		if (c.provider === "mailgun") {
			const base = `https://${c.mailgunRegion === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net"}/v3/domains/${encodeURIComponent(c.mailgunDomain ?? "")}/webhooks`;
			const auth = { authorization: `Basic ${btoa(`api:${c.key}`)}` };
			const list = await call(base, { headers: auth });
			if (!list.ok) return failed(list);
			for (const id of ["permanent_fail", "temporary_fail", "complained"]) {
				const urls: string[] = list.data?.webhooks?.[id]?.urls ?? (list.data?.webhooks?.[id]?.url ? [list.data.webhooks[id].url] : []);
				if (urls.includes(hookUrl)) continue;
				if (urls.length >= 3) return { error: `Mailgun already has three addresses for ${id.replace("_", " ")} webhooks, which is its limit. Remove one, or add ours by hand.` };
				const form = new URLSearchParams();
				for (const u of [...urls, hookUrl]) form.append("url", u);
				const r = urls.length
					? await call(`${base}/${id}`, { method: "PUT", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })
					: await call(base, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: `id=${id}&${form.toString()}` });
				if (!r.ok) return failed(r);
			}
			return { ok: true };
		}
		if (c.provider === "brevo") {
			const h = { "api-key": c.key, accept: "application/json", "content-type": "application/json" };
			const list = await call("https://api.brevo.com/v3/webhooks?type=transactional", { headers: h });
			// Brevo answers "document_not_found: Webhook record does not exist" (as a 400 or 404) when the account has
			// no webhooks yet, which just means an empty list.
			if (!list.ok && list.status !== 404 && list.data?.code !== "document_not_found") return failed(list);
			if ((list.data?.webhooks ?? []).some((w: any) => w?.url === hookUrl)) return { ok: true };
			const r = await call("https://api.brevo.com/v3/webhooks", { method: "POST", headers: h, body: JSON.stringify({ url: hookUrl, description: "Newsletter Sender: bounces and spam complaints", events: ["hardBounce", "softBounce", "invalid", "spam"], type: "transactional" }) });
			if (r.ok) return { ok: true };
			const f = failed(r);
			return { error: f.error.replace("Brevo said:", "Brevo said, when adding the webhook:") };
		}
		if (c.provider === "resend") {
			const h = { authorization: `Bearer ${c.key}`, "content-type": "application/json" };
			const list = await call("https://api.resend.com/webhooks", { headers: h });
			if (!list.ok) return failed(list);
			if ((list.data?.data ?? []).some((w: any) => w?.endpoint === hookUrl)) return { ok: true };
			const r = await call("https://api.resend.com/webhooks", { method: "POST", headers: h, body: JSON.stringify({ endpoint: hookUrl, events: ["email.bounced", "email.complained"] }) });
			return r.ok ? { ok: true } : failed(r);
		}
		return { error: "Amazon SES reports bounces its own way." };
	} catch (e) {
		return { error: `Couldn't reach ${name}: ${(e as Error).message}` };
	}
}
