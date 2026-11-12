import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanHost, wrongAddress } from "../src/agency/address.ts";

test("an app address is a subdomain", () => {
	assert.equal(cleanHost(" https://Clients.BrightAgency.co.uk/path "), "clients.brightagency.co.uk");
	assert.equal(cleanHost("brightagency.com"), null); // the main domain would take over the website
	assert.equal(cleanHost("not a name"), null);
});

test("clients can be kept to the agency's address; the owner never is", () => {
	const a = { host: "clients.bright.example", only_here: true };
	assert.match(wrongAddress(a, { role: "client" }, "newsletter-sender.me.workers.dev")!, /https:\/\/clients\.bright\.example\//);
	assert.equal(wrongAddress(a, { role: "client" }, "clients.bright.example"), null);
	assert.equal(wrongAddress(a, { role: "owner" }, "newsletter-sender.me.workers.dev"), null);
	assert.equal(wrongAddress({ ...a, only_here: false }, { role: "client" }, "anywhere.example"), null);
	assert.equal(wrongAddress(null, { role: "client" }, "anywhere.example"), null);
});
