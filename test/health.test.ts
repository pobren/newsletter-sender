import { test } from "node:test";
import assert from "node:assert/strict";
import { level, troubleWhy } from "../src/health.ts";
import { classify } from "../src/providers.ts";
import { foreignTags } from "../src/render.ts";

test("a send pauses for safety only when bounces or spam complaints really are too high", () => {
	assert.equal(troubleWhy({ sent: 50, bounced: 20, complained: 5 }), null, "too few sent to judge");
	assert.equal(troubleWhy({ sent: 1000, bounced: 40, complained: 1 }), null, "4% bounces is fine");
	assert.match(troubleWhy({ sent: 1000, bounced: 60, complained: 0 }) ?? "", /6% of this email bounced/);
	assert.equal(troubleWhy({ sent: 1000, bounced: 2, complained: 2 }), null, "two complaints is too few to act on");
	assert.match(troubleWhy({ sent: 1000, bounced: 0, complained: 3 }) ?? "", /3 people marked this email as spam/);
	assert.equal(troubleWhy({ sent: 100_000, bounced: 9, complained: 150 }), null, "0.15% complaints is under the pause line");
});

test("health levels follow what sending services expect", () => {
	assert.equal(level("bounce", 10, 1000), "good");
	assert.equal(level("bounce", 30, 1000), "ok");
	assert.equal(level("bounce", 60, 1000), "bad");
	assert.equal(level("complaint", 0, 10_000), "good");
	assert.equal(level("complaint", 7, 10_000), "ok");
	assert.equal(level("complaint", 12, 10_000), "bad");
	assert.equal(level("bounce", 5, 20), "few");
});

test("Amazon's daily limit stops the send instead of failing everyone", () => {
	const r = classify(400, "Daily message quota exceeded.");
	assert.equal(r.quota, true);
	assert.equal(r.throttled, true);
});

test("Sendy and Mailchimp merge tags work in designs brought over", () => {
	assert.equal(foreignTags("Hi [Name,fallback=there], <a href=\"[unsubscribe]\">x</a> [webversion]"), "Hi {{first_name|there}}, <a href=\"{{unsubscribe_url}}\">x</a> {{web_url}}");
	assert.equal(foreignTags("*|FNAME|* *|EMAIL|* *|UNSUB|* *|ARCHIVE|* *|LNAME|*"), "{{first_name}} {{email}} {{unsubscribe_url}} {{web_url}} *|LNAME|*");
	assert.equal(foreignTags("[Read more]"), "[Read more]");
});
