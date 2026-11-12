import { test } from "node:test";
import assert from "node:assert/strict";
import { canOf, cleanCan, notAllowed } from "../src/agency/team.ts";

const client = { role: "client" as const, limits: JSON.stringify({ import: true, month_limit: 500 }) };

test("the owner can do everything", () => {
	const can = canOf({ role: "owner", limits: null });
	for (const [p, m] of [["/api/backups", "GET"], ["/api/people", "POST"], ["/api/brand", "POST"], ["/api/export", "GET"]]) assert.equal(notAllowed({ role: "owner" }, can, p, m), null);
});

test("a client only does what they're allowed", () => {
	const can = canOf(client);
	assert.deepEqual(can, { send: false, import: true, export: false, delete: false, settings: false, month_limit: 500, review: false });
	assert.match(notAllowed(client, can, "/api/backups", "GET")!, /owner/);
	assert.match(notAllowed(client, can, "/api/people", "GET")!, /owner/);
	assert.match(notAllowed(client, can, "/api/brands", "POST")!, /owner/);
	assert.equal(notAllowed(client, can, "/api/brands", "GET"), null);
	assert.match(notAllowed(client, can, "/api/campaigns/0123456789abcdef/send", "POST")!, /Sending/);
	assert.equal(notAllowed(client, can, "/api/campaigns/0123456789abcdef/test", "POST"), null);
	assert.equal(notAllowed(client, can, "/api/import", "POST"), null);
	assert.match(notAllowed(client, can, "/api/export", "GET")!, /Downloading/);
	assert.match(notAllowed(client, can, "/api/subscribers/0123456789abcdef", "DELETE")!, /Deleting/);
	assert.match(notAllowed(client, can, "/api/brand", "POST")!, /settings/);
	assert.match(notAllowed(client, can, "/api/developer", "GET")!, /settings/);
	assert.equal(notAllowed(client, can, "/api/brand", "GET"), null);
});

test("permissions are cleaned", () => {
	assert.deepEqual(cleanCan({ send: "yes", month_limit: -5, settings: true }), { send: false, import: false, export: false, delete: false, settings: true, month_limit: 0, review: false });
});
