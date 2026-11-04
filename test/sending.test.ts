import { test } from "node:test";
import assert from "node:assert/strict";
import { batches, paced, parseAudience, sendTime, shareOfRate } from "../src/sending.ts";

test("send rows are split into queue batches", () => {
	assert.deepEqual(batches(1, 120, 50), [[1, 50], [51, 100], [101, 120]]);
	assert.deepEqual(batches(5, 5, 50), [[5, 5]]);
});

test("each worker gets a share of the rate", () => {
	assert.equal(shareOfRate(14, 10), 1.4);
	assert.equal(shareOfRate(1, 10), 0.2);
});

test("how long a send takes", () => {
	assert.equal(sendTime(10000, 14), "about 12 minutes");
	assert.equal(sendTime(20, 14), "about 2 seconds");
});

test("audiences only keep real ids and tags", () => {
	assert.deepEqual(parseAudience('{"lists":["abcdef1234567890","x; DROP"],"tags":["vip","Bad Tag"]}'), { lists: ["abcdef1234567890"], tags: ["vip"] });
	assert.deepEqual(parseAudience(null), { lists: [], tags: [] });
});

function fakeClock() {
	let t = 0;
	return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

test("sends are spread out at the rate", async () => {
	const clock = fakeClock();
	const starts: number[] = [];
	const r = await paced([1, 2, 3, 4, 5], 2, async () => { starts.push(clock.now()); return { ok: true }; }, clock);
	assert.equal(r.done.length, 5);
	assert.equal(r.throttled, false);
	assert.ok(Math.max(...starts) >= 2000, "five emails at two a second take at least two seconds");
});

test("sending stops when the service says slow down", async () => {
	const clock = fakeClock();
	let n = 0;
	const r = await paced(Array.from({ length: 20 }, (_, i) => i), 100, async () => (++n === 3 ? { ok: false, throttled: true } : { ok: true }), clock);
	assert.equal(r.throttled, true);
	assert.ok(r.done.length < 20);
});
