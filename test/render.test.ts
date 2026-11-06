import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanBlocks, hasContent, listHeaders, merge, renderEmail, slugify } from "../src/render.ts";

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
	assert.equal(slugify("!!!"), "campaign");
});

test("HTML from the editor gets the template, styles, merge tags and tracked links", () => {
	const html = `<p>Hi {{name|there}}, <a href="https://example.com/a?x=1&amp;y=2">read</a> <a href="mailto:a@b.com">mail</a></p><script>alert(1)</script><img src="x" onerror="alert(1)">`;
	const r = renderEmail("S", html, { ...look, track: { link: (_u, n) => `https://n.example/l/x/${n}`, pixel: null } }, { email: "a@b.com", name: "Jo <b>" });
	assert.ok(r.html.includes("Hi Jo &lt;b&gt;,"), "names are escaped");
	assert.ok(!r.html.includes("<script") && !r.html.includes("onerror"));
	assert.deepEqual(r.links, ["https://example.com/a?x=1&y=2"]);
	assert.ok(r.html.includes('href="https://n.example/l/x/1"'));
	assert.ok(r.html.includes('href="mailto:a@b.com"'));
	assert.ok(r.html.includes('<p style="margin:0 0 16px'));
	assert.ok(!r.html.includes("/o/"), "no open picture when opens are off");
	assert.ok(r.text.includes("read (https://example.com/a?x=1&y=2)"));
	assert.ok(r.html.includes("Unsubscribe"));
});

test("a whole designed email keeps its look, with its own or our unsubscribe link", () => {
	const doc = `<!doctype html><html><head><style>.x{color:red}</style></head><body><div class="x">Hello {{name}}</div><a href="{{unsubscribe_url}}">Leave</a></body></html>`;
	const r = renderEmail("S", doc, { ...look, preheader: "Peek" }, { email: "a@b.com", name: "Sam" });
	assert.ok(r.html.includes(".x{color:red}"));
	assert.ok(r.html.includes('href="https://n.example/u/abc"'));
	assert.ok(!r.html.includes("You're getting this because"), "their own unsubscribe link, so no footer added");
	assert.ok(r.html.includes("Peek"));
	const plain = renderEmail("S", "<html><body><p>Hi</p></body></html>", look, { email: "a@b.com" });
	assert.ok(plain.html.includes("You're getting this because"));
	assert.equal(hasContent("<p><br></p>"), false);
	assert.equal(hasContent("<p>Hi</p>"), true);
});
