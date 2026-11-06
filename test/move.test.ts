import { test } from "node:test";
import assert from "node:assert/strict";
import { importStatus, mailchimp, mailchimpDc, mailchimpRow, pastDate } from "../src/move.ts";

test("status words from other services", () => {
	for (const [x, want] of [["subscribed", "active"], ["", "active"], ["Active", "active"], ["Unsubscribed", "unsubscribed"], ["opted-out", "unsubscribed"], ["cleaned", "bounced"], ["Bounced", "bounced"], ["Marked as spam", "complained"], ["complaint", "complained"]] as const)
		assert.equal(importStatus(x), want, x);
});

test("join dates must be real and in the past", () => {
	const now = Date.UTC(2026, 10, 6);
	assert.equal(pastDate("2024-05-01 10:20:30", now), "2024-05-01T10:20:30Z");
	assert.equal(pastDate("1700000000", now), new Date(1700000000000).toISOString().replace(".000", ""));
	assert.equal(pastDate("2030-01-01", now), null);
	assert.equal(pastDate("soon", now), null);
	assert.equal(pastDate("", now), null);
});

test("Mailchimp keys and members", async () => {
	assert.equal(mailchimpDc("0123456789abcdef0123456789abcdef-us21"), "us21");
	assert.equal(mailchimpDc("nope-us21"), null);
	const row = mailchimpRow({ email_address: "a@example.com", status: "cleaned", merge_fields: { FNAME: "Ann", LNAME: "Lee", COMPANY: "Acme", PHONE: "" }, tags: [{ name: "vip" }], timestamp_opt: "2023-01-02T03:04:05+00:00" });
	assert.deepEqual(row, { email: "a@example.com", name: "Ann Lee", fields: { company: "Acme" }, tags: ["vip"], status: "bounced", joined: "2023-01-02T03:04:05+00:00" });
	assert.equal(mailchimpRow({ email_address: "p@example.com", status: "pending" }), null);

	const seen: string[] = [];
	const fake = (async (url: string, init: any) => {
		seen.push(url);
		assert.match(init.headers.authorization, /^Basic /);
		if (url.includes("/members")) return Response.json({ total_items: 1500, members: [{ email_address: "b@example.com", status: "subscribed", merge_fields: {} }, { email_address: "c@example.com", status: "archived" }] });
		return Response.json({ lists: [{ id: "abc123", name: "Main", stats: { member_count: 10, unsubscribe_count: 2, cleaned_count: 1 } }] });
	}) as typeof fetch;
	const key = "0123456789abcdef0123456789abcdef-us21";
	assert.deepEqual(await mailchimp(key, null, 0, fake), { audiences: [{ id: "abc123", name: "Main", subscribed: 10, unsubscribed: 2, cleaned: 1 }] });
	const page = await mailchimp(key, "abc123", 0, fake);
	assert.equal(page.rows.length, 1);
	assert.equal(page.skipped, 1);
	assert.equal(page.next, 1000);
	assert.equal((await mailchimp(key, "abc123", 1000, fake)).next, null);
	assert.ok(seen.every((u) => u.startsWith("https://us21.api.mailchimp.com/3.0/")));
	const bad = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
	assert.match((await mailchimp(key, null, 0, bad)).error, /didn't accept/);
});
