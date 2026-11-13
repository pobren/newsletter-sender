// Open and click log retention: save the totals, then clear old campaigns' per-person rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { cleanKeep, clearOld, getKeep, keptOne, olderThan, saveKeep, withKept } from "../src/retention.ts";

const NOW = Date.parse("2026-11-12T09:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function setup() {
	const db = memoryD1([
		"CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		"CREATE TABLE campaigns (id TEXT PRIMARY KEY, brand_id TEXT, finished_at TEXT)",
		"CREATE TABLE sends (id INTEGER PRIMARY KEY, campaign_id TEXT, subscriber_id TEXT, status TEXT, opened_at TEXT, clicked_at TEXT, country TEXT)",
		"CREATE TABLE link_clicks (campaign_id TEXT, n INTEGER, send_id INTEGER, at TEXT, PRIMARY KEY (campaign_id, n, send_id))",
	]);
	await db.prepare("INSERT INTO campaigns VALUES ('old', 'b1', ?), ('new', 'b1', ?), ('other', 'b2', ?), ('draft', 'b1', NULL)").bind(ago(800), ago(30), ago(800)).run();
	for (const c of ["old", "new", "other"]) for (let i = 0; i < 12; i++) await db.prepare("INSERT INTO sends (campaign_id, subscriber_id, status, opened_at) VALUES (?, ?, 'sent', ?)").bind(c, `s${i}`, i % 2 ? ago(10) : null).run();
	await db.prepare("INSERT INTO link_clicks VALUES ('old', 1, 1, 'x'), ('old', 2, 1, 'x'), ('new', 1, 13, 'x')").run();
	return db;
}
const snapshot = (db: D1Database) => async (id: string) => ({ stats: { sent: (await db.prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ?").bind(id).first<any>()).n, opens: 6 }, links: [], countries: [] });

test("forever unless chosen; only the set choices", async () => {
	const db = await setup();
	assert.equal(await getKeep(db, "b1"), 0);
	assert.equal(cleanKeep("730"), 730);
	assert.equal(cleanKeep(30), 0);
	assert.deepEqual(await olderThan(db, "b1", 730, NOW), { campaigns: 1, rows: 12 });
	assert.deepEqual(await olderThan(db, "b1", 0, NOW), { campaigns: 0, rows: 0 });
});

test("nothing is cleared while it's forever", async () => {
	const db = await setup();
	assert.equal(await clearOld(db, snapshot(db), NOW), 0);
});

test("old campaigns keep their totals and lose their rows, a chunk at a time", async () => {
	const db = await setup();
	await saveKeep(db, "b1", 730);
	// A small budget: it stops part way and carries on next time.
	assert.equal(await clearOld(db, snapshot(db), NOW, 5, 5), 7);
	const k1 = await keptOne(db, "old");
	assert.equal(k1?.stats.sent, 12);
	assert.equal(k1?.cleared_at, null);
	await clearOld(db, snapshot(db), NOW);
	const rows = async (c: string) => (await db.prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ?").bind(c).first<any>()).n;
	assert.equal(await rows("old"), 0);
	assert.equal(await rows("new"), 12);
	assert.equal(await rows("other"), 12, "another newsletter's own setting applies to it");
	const k = await keptOne(db, "old");
	assert.equal(k?.stats.sent, 12, "the totals were saved before anything went");
	assert.ok(k?.cleared_at);
	assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM link_clicks").first<any>()).n, 1);
	// Lists show the saved totals.
	assert.deepEqual(await withKept(db, [{ id: "old", sent: 0, opens: 0 }, { id: "new", sent: 12, opens: 6 }]), [{ id: "old", sent: 12, opens: 6 }, { id: "new", sent: 12, opens: 6 }]);
	// Done: nothing more to do.
	assert.equal(await clearOld(db, snapshot(db), NOW), 0);
});
