import { test } from "node:test";
import assert from "node:assert/strict";
import { stateOf, versionOf } from "../src/agency/signoff.ts";
import { canOf, cleanCan, notAllowed } from "../src/agency/team.ts";

const c = { subject: "Autumn news", preheader: null, html: "<p>Hi</p>", blocks: "[]", audience: '{"lists":["a"],"tags":[]}', from_name: null, from_email: null, reply_to: null, ab: null };

test("any change to what the client approved changes the fingerprint", async () => {
	const v = await versionOf(c);
	assert.equal(v, await versionOf({ ...c }));
	for (const change of [{ subject: "Autumn news!" }, { html: "<p>Hi there</p>" }, { audience: '{"lists":["b"],"tags":[]}' }, { from_email: "x@y.example" }, { preheader: "New" }])
		assert.notEqual(await versionOf({ ...c, ...change }), v, JSON.stringify(change));
});

test("where a campaign is up to", () => {
	assert.equal(stateOf(null, "v1"), "none");
	assert.equal(stateOf({ kind: "asked", version: "v1" }, "v1"), "waiting");
	assert.equal(stateOf({ kind: "approved", version: "v1" }, "v1"), "approved");
	assert.equal(stateOf({ kind: "approved", version: "v1" }, "v2"), "stale");
	assert.equal(stateOf({ kind: "changes", version: "v1" }, "v1"), "changes");
	assert.equal(stateOf({ kind: "withdrawn", version: "v1" }, "v1"), "none");
});

test("a reviewer can look, test and approve, and nothing else", () => {
	const r = { role: "client" as const, limits: JSON.stringify({ review: true, send: true, export: true }) };
	const can = canOf(r);
	assert.deepEqual(can, cleanCan({ review: true }));
	assert.equal(can.send || can.export || can.import, false);
	const id = "0123456789abcdef";
	for (const [p, m] of [[`/api/campaigns/${id}`, "GET"], [`/api/campaigns/${id}/preview`, "GET"], [`/api/campaigns/${id}/test`, "POST"], [`/api/campaigns/${id}/signoff/decide`, "POST"], ["/api/audience", "POST"], ["/api/account/password", "POST"]])
		assert.equal(notAllowed(r, can, p, m), null, `${m} ${p}`);
	for (const [p, m] of [[`/api/campaigns/${id}`, "POST"], [`/api/campaigns/${id}/send`, "POST"], [`/api/campaigns/${id}/signoff/ask`, "POST"], [`/api/campaigns/${id}/signoff/withdraw`, "POST"], ["/api/campaigns", "POST"], ["/api/lists", "POST"], ["/api/export", "GET"]])
		assert.ok(notAllowed(r, can, p, m), `${m} ${p}`);
	assert.match(notAllowed(r, can, "/api/signoff", "POST")!, /owner/);
});
