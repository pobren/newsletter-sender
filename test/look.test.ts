import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyLook, cleanLook, contrast, readable } from "../src/agency/look.ts";
import { notAllowed, canOf } from "../src/agency/team.ts";

const page = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");

test("white label settings are checked", () => {
	assert.deepEqual(cleanLook({ name: "  Bright   Agency ", colour: "#1D4FA3", logo: "https://x.test/l.png", support: "help@bright.test", from_email: "Hello@Bright.test" }), { name: "Bright Agency", colour: "#1d4fa3", logo: "https://x.test/l.png", support: "mailto:help@bright.test", from_email: "hello@bright.test" });
	assert.equal(cleanLook({ name: "A", support: "https://bright.test/help" }).hasOwnProperty("error"), false);
	assert.match((cleanLook({ name: "" }) as any).error, /name/);
	assert.match((cleanLook({ name: "A", logo: "http://x.test/l.png" }) as any).error, /https/);
	assert.match((cleanLook({ name: "A", support: "ftp://nope" }) as any).error, /Help/);
	assert.match((cleanLook({ name: "A", from_email: "not an address" }) as any).error, /address/);
});

test("light colours are made dark enough for white button text", () => {
	for (const c of ["#ffee00", "#00e5ff", "#ffffff", "#a3195b", "#1d4fa3"]) assert.ok(contrast(readable(c)) >= 4.5, c);
	assert.equal(readable("#1d4fa3"), "#1d4fa3"); // already fine: unchanged
});

test("the page carries the agency's look and no Newsletter Sender name", () => {
	const out = applyLook(page.replace("{{ADDON}}", ""), { name: "Bright <Agency>", colour: "#ffee00", logo: "https://x.test/l.png", support: "mailto:help@bright.test", from_email: null });
	assert.match(out, /<title>Bright &lt;Agency&gt;<\/title>/);
	assert.match(out, /<link rel="icon" href="https:\/\/x.test\/l.png">/);
	assert.match(out, /<span id="appName">Bright &lt;Agency&gt;<\/span>/);
	assert.match(out, /window\.NS_LOOK=\{"name":"Bright \\u003cAgency>"/);
	assert.ok(!out.includes("{{LOOK}}"));
	// Outside the script, the only "Newsletter Sender" words left are in code the owner alone sees.
	const shown = out.replace(/<script[\s\S]*?<\/script>/g, "");
	assert.ok(!shown.includes("Newsletter Sender"), "no Newsletter Sender in the page outside scripts");
	assert.ok(!shown.includes("newslettersender.com"));
});

test("white label settings are the owner's", () => {
	const client = { role: "client" as const, limits: "{}" };
	assert.match(notAllowed(client, canOf(client), "/api/look", "GET")!, /owner/);
	assert.equal(notAllowed({ role: "owner" }, canOf({ role: "owner", limits: null }), "/api/look", "POST"), null);
});

test("an uploaded logo is kept as this install's own /img/ address", () => {
	assert.equal((cleanLook({ name: "A", logo: "/img/4953f43e7b924bd1.png" }) as any).logo, "/img/4953f43e7b924bd1.png");
	assert.match((cleanLook({ name: "A", logo: "/elsewhere/x.png" }) as any).error, /https/);
});
