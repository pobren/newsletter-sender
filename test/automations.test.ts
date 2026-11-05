import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSteps, cleanTrigger, matches } from "../src/automations.ts";

const L = "0123456789abcdef";
const C = "fedcba9876543210";

test("triggers keep only what makes sense", () => {
	assert.equal(cleanTrigger(null), null);
	assert.equal(cleanTrigger({ kind: "bought" }), null);
	assert.deepEqual(cleanTrigger({ kind: "joined", list: L, campaign: C }), { kind: "joined", list: L });
	assert.deepEqual(cleanTrigger({ kind: "joined", list: "x; drop" }), { kind: "joined", list: "" });
	assert.deepEqual(cleanTrigger({ kind: "opened", campaign: C, link: 3 }), { kind: "opened", campaign: C });
	assert.deepEqual(cleanTrigger({ kind: "clicked", campaign: C, link: "2" }), { kind: "clicked", campaign: C, link: 2 });
	assert.deepEqual(cleanTrigger({ kind: "clicked", link: 9999 }), { kind: "clicked", campaign: "", link: 500 });
});

test("steps that can't run are left out", () => {
	assert.deepEqual(cleanSteps("nope"), []);
	const out = cleanSteps([
		{ wait: 0, do: "email", template: L, subject: "  Hello   {{name}} " },
		{ wait: 24, do: "email", template: L, subject: "" },
		{ wait: -5, do: "add_list", list: L },
		{ wait: 1, do: "remove_list", list: "" },
		{ wait: 99999, do: "tag", tag: "Hot Lead!" },
		{ wait: 1, do: "webhook", url: "http://insecure.example" },
		{ wait: 1, do: "webhook", url: "https://hooks.example.com/x" },
		{ wait: 1, do: "notify" },
		{ wait: 1, do: "explode" },
	]);
	assert.deepEqual(out, [
		{ wait: 0, do: "email", template: L, subject: "Hello {{name}}" },
		{ wait: 0, do: "add_list", list: L },
		{ wait: 8760, do: "tag", tag: "hotlead" },
		{ wait: 1, do: "webhook", url: "https://hooks.example.com/x" },
		{ wait: 1, do: "notify" },
	]);
	assert.equal(cleanSteps(Array.from({ length: 30 }, () => ({ do: "notify" }))).length, 20);
});

test("a trigger matches the right events", () => {
	assert.ok(matches({ kind: "joined", list: "" }, { kind: "joined", list: L }));
	assert.ok(matches({ kind: "joined", list: L }, { kind: "joined", list: L }));
	assert.ok(!matches({ kind: "joined", list: C }, { kind: "joined", list: L }));
	assert.ok(!matches({ kind: "joined", list: "" }, { kind: "unsubscribed", list: L }));
	assert.ok(matches({ kind: "opened", campaign: "" }, { kind: "opened", campaign: C }));
	assert.ok(!matches({ kind: "opened", campaign: L }, { kind: "opened", campaign: C }));
	assert.ok(matches({ kind: "clicked", campaign: C, link: 0 }, { kind: "clicked", campaign: C, link: 4 }));
	assert.ok(matches({ kind: "clicked", campaign: C, link: 4 }, { kind: "clicked", campaign: C, link: 4 }));
	assert.ok(!matches({ kind: "clicked", campaign: C, link: 2 }, { kind: "clicked", campaign: C, link: 4 }));
});
