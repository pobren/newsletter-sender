import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanBlocks, listHeaders, merge, renderEmail, slugify } from "../src/render.ts";

const look = { brandName: "The Friday Letter", colour: "#a3195b", unsubscribeUrl: "https://n.example/u/abc", footer: "1 High Street, Leeds" };

test("merge tags use the reader's details, with fallbacks", () => {
	assert.equal(merge("Hi {{first_name|there}}", { email: "a@b.com", name: "Jo Bloggs" }), "Hi Jo");
	assert.equal(merge("Hi {{first_name|there}}", { email: "a@b.com" }), "Hi there");
	assert.equal(merge("{{email}} {{company|none}}", { email: "a@b.com", fields: { company: "Acme" } }), "a@b.com Acme");
});

test("blocks are tidied: unknown and empty ones dropped", () => {
	const b = cleanBlocks([{ type: "heading", text: "Hi" }, { type: "text", text: "  " }, { type: "script", text: "x" }, { type: "divider" }, { type: "button", label: "Go", href: "" }]);
	assert.deepEqual(b, [{ type: "heading", text: "Hi" }, { type: "divider" }]);
	assert.deepEqual(cleanBlocks("nope"), []);
});

test("the email escapes what people type and keeps only safe links", () => {
	const r = renderEmail("Hello", [{ type: "text", text: "<b>x</b> **bold** [site](https://example.com) [bad](javascript:alert(1))" }], look, { email: "a@b.com" });
	assert.ok(r.html.includes("&lt;b&gt;x&lt;/b&gt;"));
	assert.ok(r.html.includes("<strong>bold</strong>"));
	assert.ok(r.html.includes('href="https://example.com"'));
	assert.ok(!r.html.includes("javascript:"));
	assert.deepEqual(r.links, ["https://example.com"]);
	assert.ok(r.text.includes("site (https://example.com)"));
	assert.ok(r.text.includes("Unsubscribe: https://n.example/u/abc"));
	assert.ok(r.html.includes("1 High Street, Leeds"));
});

test("tracking wraps links and adds the picture only when switched on", () => {
	const blocks = [{ type: "button" as const, label: "Read", href: "https://example.com/a" }];
	const off = renderEmail("S", blocks, look, { email: "a@b.com" });
	assert.ok(!off.html.includes("/o/"));
	const on = renderEmail("S", blocks, { ...look, track: { link: (_u, n) => `https://n.example/l/x/${n}`, pixel: "https://n.example/o/x" } }, { email: "a@b.com" });
	assert.ok(on.html.includes("https://n.example/l/x/1"));
	assert.ok(on.html.includes("https://n.example/o/x"));
});

test("every newsletter carries one click unsubscribe headers", () => {
	const h = listHeaders("https://n.example/u/abc", "list.n.example");
	assert.equal(h["List-Unsubscribe"], "<https://n.example/u/abc>");
	assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("slugs", () => {
	assert.equal(slugify("Spring news! Café opens"), "spring-news-cafe-opens");
	assert.equal(slugify("!!!"), "issue");
});
