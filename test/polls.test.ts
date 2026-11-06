import { test } from "node:test";
import assert from "node:assert/strict";
import { pollHtml, pollsIn } from "../src/polls.ts";
import { renderEmail } from "../src/render.ts";

const look = { brandName: "News", colour: "#a3195b", unsubscribeUrl: "https://x.test/u/t", track: null };

test("a poll box is read back, question and answers", () => {
	const html = `<p>Hi</p>${pollHtml("abc12345", `What's "next"?`, ["Recipes & tips", "Reviews"], "#123456")}`;
	assert.deepEqual(pollsIn(html), [{ id: "abc12345", question: `What's "next"?`, answers: [{ n: 1, text: "Recipes & tips" }, { n: 2, text: "Reviews" }] }]);
	assert.deepEqual(pollsIn("<p>No poll</p>"), []);
});

test("each reader gets their own answer links", () => {
	const html = pollHtml("abc12345", "Pick one", ["Yes", "No"], "#123456");
	const out = renderEmail("Hi", html, { ...look, poll: (id, n) => `https://x.test/v/9.sig/${id}/${n}` }, { email: "a@x.test" });
	assert.match(out.html, /href="https:\/\/x\.test\/v\/9\.sig\/abc12345\/1"/);
	assert.match(out.html, /href="https:\/\/x\.test\/v\/9\.sig\/abc12345\/2"/);
	assert.doesNotMatch(out.html, /\{\{poll/);
	assert.deepEqual(out.links, []);
	// A preview or the web version has no reader, so answers go to the web version (or nowhere).
	assert.match(renderEmail("Hi", html, look, { email: "a@x.test" }).html, /href="#"/);
});
