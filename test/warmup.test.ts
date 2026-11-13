// Domain warm up: the daily numbers, sharing them between queue workers, and carrying on the next day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { allowance, carryOnTomorrow, dailyLimit, getWarmup, plan, reserve, saveWarmup, usedToday, waitForTomorrow } from "../src/warmup.ts";

const schema = [
	"CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	"CREATE TABLE campaigns (id TEXT PRIMARY KEY, brand_id TEXT, status TEXT, updated_at TEXT)",
	"CREATE TABLE events (id INTEGER PRIMARY KEY, brand_id TEXT, kind TEXT, subscriber_id TEXT, campaign_id TEXT, detail TEXT, at TEXT)",
];

test("the daily number grows by half each day, tidily, until it's warmed up", () => {
	const w = { start: "2026-11-12", first: 50 };
	assert.equal(dailyLimit(w, "2026-11-12"), 50);
	assert.equal(dailyLimit(w, "2026-11-13"), 75);
	assert.equal(dailyLimit(w, "2026-11-14"), 110);
	assert.equal(dailyLimit(w, "2026-11-20"), 1300);
	assert.equal(dailyLimit(w, "2027-01-01"), null);
	const p = plan(50);
	assert.equal(p[0], 50);
	assert.ok(p.length > 15 && p.length < 25);
	assert.ok(p.every((n, i) => i === 0 || n > p[i - 1]));
	assert.ok(p[p.length - 1] <= 50_000);
});

test("workers share the day's number and never go over it", async () => {
	const db = memoryD1(schema);
	const got = await Promise.all(Array.from({ length: 20 }, () => reserve(db, "b1", 10, 50, "2026-11-12")));
	assert.equal(got.reduce((a, b) => a + b, 0), 50);
	assert.equal(await reserve(db, "b1", 10, 50, "2026-11-12"), 0);
	assert.equal(await usedToday(db, "b1", "2026-11-12"), 50);
	assert.equal(await reserve(db, "b1", 10, 50, "2026-11-13"), 10);
});

test("no warm up means no limit; finishing switches it off", async () => {
	const db = memoryD1(schema);
	assert.equal(await allowance(db, "b1", 200), null);
	await saveWarmup(db, "b1", { on: true, start: "2020-01-01", first: 50, waiting: [] });
	assert.equal(await allowance(db, "b1", 200), null);
	const w = await getWarmup(db, "b1");
	assert.equal(w?.on, false);
	assert.equal(w?.done, true);
});

test("a campaign that reaches the day's number pauses, and carries on the next day", async () => {
	const db = memoryD1(schema);
	const day = new Date().toISOString().slice(0, 10);
	await saveWarmup(db, "b1", { on: true, start: day, first: 50, waiting: [] });
	await db.prepare("INSERT INTO campaigns (id, brand_id, status) VALUES ('c1', 'b1', 'sending')").run();
	assert.equal(await allowance(db, "b1", 200), 50);
	assert.equal(await allowance(db, "b1", 200), 0);
	await waitForTomorrow(db, { id: "c1", brand_id: "b1" } as any);
	assert.equal((await db.prepare("SELECT status FROM campaigns WHERE id = 'c1'").first<any>()).status, "paused");
	assert.deepEqual((await getWarmup(db, "b1"))?.waiting, ["c1"]);
	const resumed: string[] = [];
	const env = { DB: db } as any;
	await carryOnTomorrow(env, async (_e, c) => resumed.push(c.id));
	assert.deepEqual(resumed, []); // still the same day
	await carryOnTomorrow(env, async (_e, c) => resumed.push(c.id), new Date(Date.now() + 86_400_000));
	assert.deepEqual(resumed, ["c1"]);
	assert.deepEqual((await getWarmup(db, "b1"))?.waiting, []);
});
