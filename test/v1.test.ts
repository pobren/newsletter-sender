import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanHookUrl, EVENTS } from "../src/v1.ts";

test("webhooks only go to public https addresses", () => {
	assert.equal(cleanHookUrl("https://shop.example.com/hooks/news"), "https://shop.example.com/hooks/news");
	for (const bad of ["http://shop.example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.2/x", "https://user:pw@example.com/x", "not a url", 42]) assert.equal(cleanHookUrl(bad), null, String(bad));
});

test("webhook events are the documented set", () => {
	assert.deepEqual([...EVENTS], ["subscriber.subscribed", "subscriber.pending", "subscriber.unsubscribed", "subscriber.bounced", "subscriber.complained", "campaign.started", "campaign.sent", "campaign.paused"]);
});
