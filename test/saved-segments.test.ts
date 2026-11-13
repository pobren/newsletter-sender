// Saved segments: named audience filters to pick when setting up a campaign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { cleanSegment, deleteSegment, forLists, getSegments, MAX_SEGMENTS, saveSegment } from "../src/segments.ts";

const L = "0123456789abcdef";
const M = "fedcba9876543210";
const db = () => memoryD1(["CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"]);

test("a segment needs a name and something to filter by; resend is never kept", () => {
	assert.equal(cleanSegment({ name: " ", audience: { lists: [L] } }), null);
	assert.equal(cleanSegment({ name: "Everyone", audience: { lists: [] } }), null);
	assert.deepEqual(cleanSegment({ name: "  Active   clickers ", audience: { lists: [L], tags: ["customer", "Bad Tag"], activity: { kind: "clicked", days: 60 }, resend: { campaign: M } } }), {
		name: "Active clickers",
		audience: { lists: [L], tags: ["customer"], activity: { kind: "clicked", days: 60 } },
	});
	// A made up number of days isn't kept.
	assert.equal(cleanSegment({ name: "Odd", audience: { activity: { kind: "clicked", days: 61 } } }), null);
});

test("saving again by the same name updates it; delete removes it", async () => {
	const d = db();
	assert.deepEqual(await getSegments(d, "b1"), []);
	const a = await saveSegment(d, "b1", { name: "Active clickers", audience: { lists: [L], tags: [], activity: { kind: "clicked", days: 60 } } });
	await saveSegment(d, "b1", { name: "Customers", audience: { lists: [], tags: ["customer"] } });
	const again = await saveSegment(d, "b1", { name: "active CLICKERS", audience: { lists: [L], tags: [], activity: { kind: "clicked", days: 30 } } });
	assert.equal(again.id, a.id);
	const all = await getSegments(d, "b1");
	assert.deepEqual(all.map((s) => s.name), ["active CLICKERS", "Customers"]);
	assert.equal(all[0].audience.activity?.days, 30);
	assert.deepEqual(await getSegments(d, "b2"), []);
	await deleteSegment(d, "b1", a.id);
	assert.deepEqual((await getSegments(d, "b1")).map((s) => s.name), ["Customers"]);
});

test("there's a limit, and lists that have gone are dropped when used", async () => {
	const d = db();
	for (let i = 0; i < MAX_SEGMENTS; i++) await saveSegment(d, "b1", { name: `S${i}`, audience: { lists: [L], tags: [] } });
	await assert.rejects(saveSegment(d, "b1", { name: "One more", audience: { lists: [L], tags: [] } }), /up to 50/);
	const s = { id: "x", name: "Two lists", audience: { lists: [L, M], tags: [] } };
	assert.deepEqual(forLists(s, [M]).lists, [M]);
});
