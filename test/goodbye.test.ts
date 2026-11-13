// The goodbye email and its one click way back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { cleanGoodbye, comeBack, DEFAULT_TEXT, getBack, getGoodbye, saveGoodbye, sayGoodbye } from "../src/goodbye.ts";

const schema = [
	"CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	"CREATE TABLE lists (id TEXT PRIMARY KEY, brand_id TEXT, name TEXT)",
	"CREATE TABLE memberships (list_id TEXT, subscriber_id TEXT, status TEXT, left_at TEXT, PRIMARY KEY (list_id, subscriber_id))",
	"CREATE TABLE events (id INTEGER PRIMARY KEY, brand_id TEXT, kind TEXT, subscriber_id TEXT, campaign_id TEXT, detail TEXT, at TEXT)",
];
const b = { id: "b1", name: "Harbour Bakery" } as any;
const s = { id: "s1", email: "jo@example.com", token: "t".repeat(32), suppressed: null } as any;

async function setup() {
	const db = memoryD1(schema);
	await db.prepare("INSERT INTO lists VALUES ('l1', 'b1', 'News'), ('l2', 'b1', 'Offers'), ('l3', 'b1', 'Events')").run();
	await db.prepare("INSERT INTO memberships VALUES ('l1', 's1', 'unsubscribed', '2026-11-12'), ('l2', 's1', 'unsubscribed', '2026-11-12'), ('l3', 's1', 'unsubscribed', '2026-01-01')").run();
	return db;
}

test("off unless switched on; text defaults and is tidied", async () => {
	const db = memoryD1(schema);
	assert.deepEqual(await getGoodbye(db, "b1"), { on: false, text: DEFAULT_TEXT });
	assert.deepEqual(cleanGoodbye({ on: true, text: "  " }), { on: true, text: DEFAULT_TEXT });
	assert.equal(cleanGoodbye({ on: "yes" }).on, false);
});

test("the goodbye goes once a month, with a button back", async () => {
	const db = await setup();
	const sent: any[] = [];
	const send = async (to: string, subject: string, paras: string[], button: any) => (sent.push({ to, subject, paras, button }), true);
	assert.equal(await sayGoodbye({ DB: db } as any, b, s, ["l1"], "News", send, "https://n.example"), false);
	await saveGoodbye(db, "b1", { on: true, text: "Bye for now.\n\nCome back any time." });
	assert.equal(await sayGoodbye({ DB: db } as any, b, s, ["l1"], "News", send, "https://n.example"), true);
	assert.deepEqual(sent[0], { to: "jo@example.com", subject: "You've unsubscribed from News", paras: ["Bye for now.", "Come back any time."], button: { label: "Put me back on", href: `https://n.example/u/${"t".repeat(32)}/back` } });
	assert.equal(await sayGoodbye({ DB: db } as any, b, s, ["l2"], "Offers", send, "https://n.example"), false);
	assert.equal(sent.length, 1);
	assert.deepEqual((await getBack(db, "s1"))?.lists, ["l1", "l2"]);
	assert.equal(await sayGoodbye({ DB: db } as any, b, { ...s, suppressed: "bounced" }, ["l1"], "News", send, "https://n.example"), false);
});

test("the way back restores just the lists they left, once", async () => {
	const db = await setup();
	await saveGoodbye(db, "b1", { on: true, text: "Bye" });
	await sayGoodbye({ DB: db } as any, b, s, ["l1", "l2"], "News", async () => true, "https://n.example");
	assert.deepEqual((await comeBack(db, b, s))?.sort(), ["l1", "l2"]);
	const { results } = await db.prepare("SELECT list_id, status FROM memberships ORDER BY list_id").all<any>();
	assert.deepEqual(results, [{ list_id: "l1", status: "active" }, { list_id: "l2", status: "active" }, { list_id: "l3", status: "unsubscribed" }]);
	assert.equal(await comeBack(db, b, s), null);
});
