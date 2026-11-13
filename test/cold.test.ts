// Cold contact clean up: who's cold, tagging, untagging, and taking them off the lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { cleanCold, coldDue, DEFAULT_POLICY, lookCold, removeCold, saveCold, tagCold } from "../src/cold.ts";

const NOW = Date.parse("2026-11-12T09:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function setup() {
	const db = memoryD1([
		"CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		"CREATE TABLE lists (id TEXT PRIMARY KEY, brand_id TEXT, name TEXT)",
		"CREATE TABLE subscribers (id TEXT PRIMARY KEY, brand_id TEXT, email TEXT, tags TEXT NOT NULL DEFAULT '[]', suppressed TEXT, created_at TEXT)",
		"CREATE TABLE memberships (list_id TEXT, subscriber_id TEXT, status TEXT, left_at TEXT, PRIMARY KEY (list_id, subscriber_id))",
		"CREATE TABLE campaigns (id TEXT PRIMARY KEY, brand_id TEXT, started_at TEXT)",
		"CREATE TABLE sends (id INTEGER PRIMARY KEY, campaign_id TEXT, subscriber_id TEXT, status TEXT, sent_at TEXT, opened_at TEXT, clicked_at TEXT)",
		"CREATE TABLE events (id INTEGER PRIMARY KEY, brand_id TEXT, at TEXT, kind TEXT, subscriber_id TEXT, campaign_id TEXT, detail TEXT)",
	]);
	await db.prepare("INSERT INTO lists VALUES ('l1', 'b1', 'News')").run();
	// cold: got everything, read nothing. reader: opened one. newbie: joined lately. gone: unsubscribed.
	for (const [id, created] of [["cold", 400], ["reader", 400], ["newbie", 20], ["gone", 400]] as const) {
		await db.prepare("INSERT INTO subscribers (id, brand_id, email, created_at) VALUES (?, 'b1', ?, ?)").bind(id, `${id}@example.com`, ago(created)).run();
		await db.prepare("INSERT INTO memberships VALUES ('l1', ?, ?, NULL)").bind(id, id === "gone" ? "unsubscribed" : "active").run();
	}
	// Five tracked campaigns (someone opened each), and two from before tracking was on (nobody opened).
	for (let i = 1; i <= 7; i++) {
		await db.prepare("INSERT INTO campaigns VALUES (?, 'b1', ?)").bind(`c${i}`, ago(i * 10)).run();
		for (const s of ["cold", "reader", "newbie", "gone"]) await db.prepare("INSERT INTO sends (campaign_id, subscriber_id, status, sent_at, opened_at) VALUES (?, ?, 'sent', ?, ?)").bind(`c${i}`, s, ago(i * 10), s === "reader" && i <= 5 ? ago(i * 10) : null).run();
	}
	return db;
}

test("the policy is tidied; off by default", () => {
	assert.deepEqual(cleanCold({}), DEFAULT_POLICY);
	assert.deepEqual(cleanCold({ on: true, days: "90", min: 99, remove: true }), { on: true, days: 90, min: 20, remove: true });
	assert.equal(cleanCold({ on: false, remove: true }).remove, false);
});

test("cold, by the numbers", async () => {
	const db = await setup();
	const l = await lookCold(db, "b1", { days: 180, min: 5 }, NOW);
	assert.equal(l.campaigns, 5);
	assert.equal(l.count, 1);
	assert.deepEqual(l.sample, ["cold@example.com"]);
	// Needing six tracked emails: only five were tracked, so nobody.
	assert.equal((await lookCold(db, "b1", { days: 180, min: 6 }, NOW)).count, 0);
});

test("tag, untag when they read something, and take off after a month", async () => {
	const db = await setup();
	assert.deepEqual(await tagCold(db, "b1", { days: 180, min: 5 }, NOW), { tagged: 1, warmed: 0 });
	assert.deepEqual(await tagCold(db, "b1", { days: 180, min: 5 }, NOW), { tagged: 0, warmed: 0 });
	const tags = async (id: string) => JSON.parse((await db.prepare("SELECT tags FROM subscribers WHERE id = ?").bind(id).first<any>()).tags);
	assert.deepEqual(await tags("cold"), ["cold"]);
	// Not yet a month: the automatic clean up leaves them.
	assert.equal(await removeCold(db, "b1", { days: 180, min: 5 }, { afterGrace: true }, NOW + 10 * 86_400_000), 0);
	assert.equal(await removeCold(db, "b1", { days: 180, min: 5 }, { afterGrace: true }, NOW + 31 * 86_400_000), 1);
	const st = await db.prepare("SELECT status FROM memberships WHERE subscriber_id = 'cold'").first<any>();
	assert.equal(st.status, "unsubscribed");
	assert.match((await db.prepare("SELECT detail FROM events WHERE kind = 'unsubscribed'").first<any>()).detail, /Cold contact clean up/);
});

test("someone who opens the win back email loses the tag", async () => {
	const db = await setup();
	await tagCold(db, "b1", { days: 180, min: 5 }, NOW);
	await db.prepare("INSERT INTO campaigns VALUES ('wb', 'b1', ?)").bind(ago(-1)).run();
	await db.prepare("INSERT INTO sends (campaign_id, subscriber_id, status, sent_at, opened_at) VALUES ('wb', 'cold', 'sent', ?, ?)").bind(ago(-1), ago(-1)).run();
	assert.deepEqual(await tagCold(db, "b1", { days: 180, min: 5 }, NOW + 2 * 86_400_000), { tagged: 0, warmed: 1 });
	assert.deepEqual(JSON.parse((await db.prepare("SELECT tags FROM subscribers WHERE id = 'cold'").first<any>()).tags), []);
});

test("by hand: take everyone cold off now; the daily run happens once a day", async () => {
	const db = await setup();
	assert.equal(await removeCold(db, "b1", { days: 180, min: 5 }, { afterGrace: false }, NOW), 1);
	const db2 = await setup();
	await saveCold(db2, "b1", { on: true, days: 180, min: 5, remove: false });
	await coldDue(db2, NOW);
	await db2.prepare("UPDATE subscribers SET tags = '[]'").run();
	await coldDue(db2, NOW + 3_600_000);
	assert.equal((await db2.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'cold'").first<any>()).n, 1);
});
