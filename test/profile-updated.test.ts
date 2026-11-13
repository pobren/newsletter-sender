// Automations that start when someone changes their details, and start again next time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { cleanTrigger, fire, matches } from "../src/automations.ts";

const L = "0123456789abcdef";
const M = "fedcba9876543210";

test("the updated trigger keeps its list and matches people on it", () => {
	assert.deepEqual(cleanTrigger({ kind: "updated", list: L, campaign: "x" }), { kind: "updated", list: L });
	assert.equal(matches({ kind: "updated", list: "" }, { kind: "updated", lists: [] }), true);
	assert.equal(matches({ kind: "updated", list: L }, { kind: "updated", lists: [M, L] }), true);
	assert.equal(matches({ kind: "updated", list: L }, { kind: "updated", lists: [M] }), false);
	assert.equal(matches({ kind: "joined", list: "" }, { kind: "updated", lists: [L] }), false);
});

test("an update starts a run, and starts it again once the last one is over", async () => {
	const db = memoryD1([
		"CREATE TABLE automations (id TEXT PRIMARY KEY, brand_id TEXT, name TEXT, trigger TEXT, steps TEXT, enabled INTEGER)",
		"CREATE TABLE automation_runs (id INTEGER PRIMARY KEY, automation_id TEXT, subscriber_id TEXT, step INTEGER, due_at TEXT, status TEXT, created_at TEXT, UNIQUE (automation_id, subscriber_id))",
	]);
	const steps = JSON.stringify([{ wait: 0, do: "tag", tag: "changed" }]);
	await db.prepare("INSERT INTO automations VALUES ('a1', 'b1', 'Tag', ?, ?, 1)").bind(JSON.stringify({ kind: "updated", list: "" }), steps).run();
	await db.prepare("INSERT INTO automations VALUES ('a2', 'b1', 'Welcome', ?, ?, 1)").bind(JSON.stringify({ kind: "joined", list: "" }), steps).run();
	await fire(db, "b1", "s1", { kind: "updated", lists: [L], changed: ["name"] });
	const runs = async () => (await db.prepare("SELECT automation_id, status FROM automation_runs ORDER BY id").all<any>()).results;
	assert.deepEqual(await runs(), [{ automation_id: "a1", status: "waiting" }]);
	// Still waiting: a second change doesn't start a second run.
	await fire(db, "b1", "s1", { kind: "updated", lists: [L], changed: ["lists"] });
	assert.equal((await runs()).length, 1);
	await db.prepare("UPDATE automation_runs SET status = 'done', step = 1").run();
	await fire(db, "b1", "s1", { kind: "updated", lists: [L], changed: ["name"] });
	assert.deepEqual(await runs(), [{ automation_id: "a1", status: "waiting" }]);
	assert.equal((await db.prepare("SELECT step FROM automation_runs").first<any>()).step, 0);
});
