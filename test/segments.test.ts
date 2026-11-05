import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAudience } from "../src/sending.ts";

test("segments by activity keep only known choices", () => {
	assert.deepEqual(parseAudience({ lists: ["abcdef0123456789"], tags: [], activity: { kind: "not_opened", days: 90 } }).activity, { kind: "not_opened", days: 90 });
	assert.equal(parseAudience({ lists: [], tags: [], activity: { kind: "deleted", days: 90 } }).activity, undefined);
	assert.equal(parseAudience({ lists: [], tags: [], activity: { kind: "opened", days: 3 } }).activity, undefined);
	assert.equal(parseAudience({ lists: [], tags: [], activity: null }).activity, undefined);
});
