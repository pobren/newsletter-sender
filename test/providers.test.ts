import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, parseProvider, parseProviderEvent, parseSesEvent, providerRequest, seal, sesBody, trustedSubscribeUrl, unseal } from "../src/providers.ts";
import { signAws } from "../src/aws.ts";

const mail = { to: "jo@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>", headers: { "List-Unsubscribe": "<https://n.example/u/x>" }, tags: { ns_campaign: "abcdef12", ns_sub: "12345678" } };

test("provider set-ups are checked", () => {
	assert.ok("error" in parseProvider({ provider: "ses", key: "secretsecretsecret" }, "a@b.com"));
	const ok = parseProvider({ provider: "ses", key: "secretsecretsecret", accessKeyId: "AKIAABCDEFGHIJKLMNOP", region: "eu-west-2" }, "a@b.com");
	assert.deepEqual(ok, { provider: "ses", key: "secretsecretsecret", accessKeyId: "AKIAABCDEFGHIJKLMNOP", region: "eu-west-2" });
	const mg = parseProvider({ provider: "mailgun", key: "key-1234567890" }, "news@example.com");
	assert.equal((mg as any).mailgunDomain, "example.com");
});

test("SES emails carry the unsubscribe headers, tags and configuration set", () => {
	const b = sesBody({ provider: "ses", key: "k", configSet: "newsletter-sender" }, "Jo", "news@example.com", mail) as any;
	assert.equal(b.ConfigurationSetName, "newsletter-sender");
	assert.ok(JSON.stringify(b).includes("List-Unsubscribe"));
	assert.ok(JSON.stringify(b).includes("ns_campaign"));
});

test("each provider gets a request for its own API", () => {
	assert.match(providerRequest({ provider: "postmark", key: "k" }, "Jo", "n@e.com", mail).url, /postmarkapp\.com/);
	assert.match(providerRequest({ provider: "mailgun", key: "k", mailgunDomain: "mg.e.com", mailgunRegion: "eu" }, "Jo", "n@e.com", mail).url, /api\.eu\.mailgun\.net\/v3\/mg\.e\.com/);
	assert.match(providerRequest({ provider: "brevo", key: "k" }, "Jo", "n@e.com", mail).url, /brevo\.com/);
	assert.match(providerRequest({ provider: "resend", key: "k" }, "Jo", "n@e.com", mail).url, /resend\.com/);
});

test("failures are sorted into slow down, bad address or other", () => {
	assert.equal(classify(429, "").throttled, true);
	assert.equal(classify(400, "Throttling: Maximum sending rate exceeded").throttled, true);
	assert.equal(classify(400, "InvalidParameterValue: Missing final '@domain' in address").permanent, true);
	assert.equal(classify(403, "Forbidden").permanent, undefined);
});

test("keys are sealed and only open with the right secret", async () => {
	const c = { provider: "postmark" as const, key: "server-token-123" };
	const s = await seal("one", c);
	assert.ok(!s.includes("server-token"));
	assert.deepEqual(await unseal("one", s), c);
	assert.equal(await unseal("two", s), null);
});

test("SES bounces and complaints are read", () => {
	const hard = parseSesEvent({ eventType: "Bounce", bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "Jo@Example.com" }] }, mail: { tags: { ns_sub: ["12345678"], ns_campaign: ["abcdef12"] } } });
	assert.deepEqual(hard, { kind: "bounce", permanent: true, addresses: ["jo@example.com"], detail: "Permanent: General", sub: "12345678", campaign: "abcdef12" });
	assert.equal(parseSesEvent({ eventType: "Bounce", bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "a@b.com" }] }, mail: {} })?.permanent, false);
	assert.equal(parseSesEvent({ eventType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "a@b.com" }] }, mail: {} })?.kind, "complaint");
	assert.equal(parseSesEvent({ eventType: "Delivery" }), null);
});

test("other providers' webhooks are read", () => {
	assert.equal(parseProviderEvent("postmark", { RecordType: "Bounce", Type: "HardBounce", Email: "a@b.com" })?.permanent, true);
	assert.equal(parseProviderEvent("postmark", { RecordType: "Bounce", Type: "SoftBounce", Email: "a@b.com" })?.permanent, false);
	assert.equal(parseProviderEvent("postmark", { RecordType: "SubscriptionChange", Recipient: "a@b.com", SuppressSending: true, SuppressionReason: "ManualSuppression" })?.kind, "unsubscribe");
	assert.equal(parseProviderEvent("postmark", { RecordType: "SubscriptionChange", Recipient: "a@b.com", SuppressSending: true, SuppressionReason: "HardBounce" }), null);
	assert.equal(parseProviderEvent("mailgun", { "event-data": { event: "complained", recipient: "a@b.com" } })?.kind, "complaint");
	assert.equal(parseProviderEvent("brevo", { event: "hard_bounce", email: "a@b.com" })?.permanent, true);
	assert.equal(parseProviderEvent("resend", { type: "email.bounced", data: { to: ["a@b.com"], bounce: { type: "Permanent" } } })?.addresses[0], "a@b.com");
	assert.equal(parseProviderEvent("resend", { type: "email.delivered", data: {} }), null);
});

test("only Amazon's own SNS addresses are trusted", () => {
	assert.equal(trustedSubscribeUrl("https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=x"), true);
	assert.equal(trustedSubscribeUrl("https://evil.example/?Action=ConfirmSubscription"), false);
	assert.equal(trustedSubscribeUrl("https://sns.eu-west-1.amazonaws.com.evil.example/?Action=ConfirmSubscription"), false);
});

test("AWS signing matches Amazon's published example", async () => {
	const h = await signAws(
		{ method: "GET", url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }, body: "", service: "iam", amzDate: "20150830T123600Z" },
		{ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
	);
	assert.match(h.authorization, /Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
});
