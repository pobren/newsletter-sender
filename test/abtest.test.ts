import { test } from "node:test";
import assert from "node:assert/strict";
import { abSplit, cleanAb, parseAb, sendableTo, subjectFor, winnerOf } from "../src/abtest.ts";

test("subject line test settings are cleaned", () => {
	const on = { opens: true, clicks: false };
	assert.equal(cleanAb({ on: false, subject: "B" }, on), null);
	assert.equal(cleanAb({ on: true, subject: "  " }, on), null);
	assert.equal(cleanAb({ on: true, subject: "B" }, { opens: false, clicks: false }), null);
	assert.deepEqual(cleanAb({ on: true, subject: "B", pct: "30", hours: "8", by: "clicks" }, on), { b: "B", pct: 30, hours: 8, by: "opens" });
	assert.deepEqual(cleanAb({ on: true, subject: "B", pct: 99, hours: 1000 }, { opens: false, clicks: true }), { b: "B", pct: 20, hours: 4, by: "clicks" });
	assert.equal(parseAb("not json"), null);
	assert.equal(parseAb('{"b":""}'), null);
});

test("test groups and who gets which subject", () => {
	assert.equal(abSplit(1, 19, 20), null);
	assert.deepEqual(abSplit(101, 1000, 20), { aTo: 200, bTo: 300 });
	assert.deepEqual(abSplit(1, 20, 10), { aTo: 1, bTo: 2 });
	const ab = { b: "Subject B", pct: 20, hours: 4, by: "opens" as const, aTo: 200, bTo: 300 };
	const c = { subject: "Subject A" };
	assert.equal(subjectFor(c, ab, 150), "Subject A");
	assert.equal(subjectFor(c, ab, 250), "Subject B");
	assert.equal(subjectFor(c, ab, 900), "Subject A");
	assert.equal(subjectFor(c, { ...ab, winner: "b" }, 900), "Subject B");
	assert.equal(subjectFor(c, null, 5), "Subject A");
	assert.equal(sendableTo(ab, 1100), 300);
	assert.equal(sendableTo({ ...ab, winner: "a" }, 1100), 1100);
	assert.equal(sendableTo(null, 1100), 1100);
});

test("the winner", () => {
	assert.equal(winnerOf({ a: { sent: 100, opens: 20, clicks: 1 }, b: { sent: 100, opens: 30, clicks: 0 } }, "opens"), "b");
	assert.equal(winnerOf({ a: { sent: 100, opens: 20, clicks: 1 }, b: { sent: 100, opens: 30, clicks: 0 } }, "clicks"), "a");
	assert.equal(winnerOf({ a: { sent: 100, opens: 20, clicks: 0 }, b: { sent: 100, opens: 20, clicks: 0 } }, "opens"), "a");
	assert.equal(winnerOf({ a: { sent: 0, opens: 0, clicks: 0 }, b: { sent: 0, opens: 0, clicks: 0 } }, "opens"), "a");
});
