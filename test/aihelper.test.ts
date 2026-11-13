// The optional writing helper: off by default, tidy output, a daily cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { aiUse, AiError, DAILY_CAP, getAi, messages, MODEL, saveAi, textOf, tidyAiUse, tidyOutput, write } from "../src/aihelper.ts";
import { setMeta } from "../src/db.ts";

const brand = { id: "b1", name: "Harbour Bakery" };
const setup = () => memoryD1(["CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"]);

test("the email's words, without the HTML", () => {
	assert.equal(textOf("<style>p{}</style><h1>Hello &amp; welcome</h1><p>New <b>loaf</b> on Saturday.</p><p>See you&nbsp;soon</p>"), "Hello & welcome\n\nNew loaf on Saturday.\n\nSee you soon");
});

test("subject lines and paragraphs come back clean", () => {
	assert.deepEqual(tidyOutput("subjects", 'Here are 5 subject lines:\n\n1. "Our new sourdough"\n2) **Christmas orders open**\n- Closed 25 to 27 Dec\n\n'), ["Our new sourdough", "Christmas orders open", "Closed 25 to 27 Dec"]);
	assert.deepEqual(tidyOutput("draft", "Here's the draft:\n\nHello all.\nWe have news.\n\n## New loaf\n\nIt's lovely."), ["Hello all. We have news.", "New loaf", "It's lovely."]);
	assert.deepEqual(tidyOutput("tidy", ""), []);
});

test("the prompt asks for UK English and nothing made up", () => {
	const m = messages("tidy", "Some text", "Harbour Bakery");
	assert.match(m[0].content, /UK English/);
	assert.match(m[0].content, /don't add facts/);
	assert.match(m[1].content, /Some text/);
});

test("off by default; on, it runs, counts and stops at the cap", async () => {
	const db = setup();
	const calls: any[] = [];
	const AI = { run: async (model: string, input: any) => (calls.push({ model, input }), { response: "1. One\n2. Two" }) };
	const env = { DB: db, AI } as any;
	assert.deepEqual(await getAi(db, "b1"), { on: false });
	await assert.rejects(write(env, brand, "subjects", "<p>Hello there</p>"), (e) => e instanceof AiError && /off/.test(e.message));
	await saveAi(db, "b1", true);
	await assert.rejects(write({ DB: db } as any, brand, "subjects", "<p>Hello there</p>"), /isn't connected/);
	await assert.rejects(write(env, brand, "tidy", "  "), /Pick some/);
	const now = new Date("2026-11-12T10:00:00Z");
	assert.deepEqual(await write(env, brand, "subjects", "<p>Hello there</p>", now), ["One", "Two"]);
	assert.equal(calls[0].model, MODEL);
	assert.match(calls[0].input.messages[1].content, /Hello there/);
	assert.deepEqual(await aiUse(db, "b1", now), { today: 1, month: 1 });
	await setMeta(db, "aiday:b1:2026-11-12", String(DAILY_CAP));
	await assert.rejects(write(env, brand, "subjects", "<p>Hello</p>", now), /limit/);
	await tidyAiUse(db, new Date("2026-11-13T00:01:00Z"));
	assert.deepEqual(await aiUse(db, "b1", now), { today: 0, month: 1 });
});

test("a failed call says so and isn't counted", async () => {
	const db = setup();
	await saveAi(db, "b1", true);
	const env = { DB: db, AI: { run: async () => { throw new Error("3040"); } } } as any;
	await assert.rejects(write(env, brand, "draft", "new loaf"), /didn't answer/);
	assert.deepEqual(await aiUse(db, "b1"), { today: 0, month: 0 });
});
