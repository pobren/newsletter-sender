import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAudience } from "../src/sending.ts";

test("sending again keeps the earlier campaign, and nothing odd", () => {
	assert.deepEqual(parseAudience({ lists: ["abcdef12"], tags: [], resend: { campaign: "0123abcd4567ef89" } }), { lists: ["abcdef12"], tags: [], resend: { campaign: "0123abcd4567ef89" } });
	assert.deepEqual(parseAudience({ lists: ["abcdef12"], tags: [], resend: { campaign: "x'; DROP" } }), { lists: ["abcdef12"], tags: [] });
	assert.deepEqual(parseAudience(JSON.stringify({ lists: [], tags: [], resend: null })), { lists: [], tags: [] });
});
