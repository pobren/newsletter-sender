import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEmail } from "../src/check.ts";

const fake = (async (url: string) => new Response("", { status: url.includes("gone") ? 404 : url.includes("robots") ? 403 : 200 })) as unknown as typeof fetch;
const base = { colour: "#a3195b", brandName: "News" };

test("a good email passes", async () => {
	const items = await checkEmail({ ...base, subject: "Our autumn news", preheader: "Five things", content: `<p>Hi {{first_name|there}}</p><p><a href="https://example.com/a">Read</a></p><img src="https://example.com/p.png" alt="A view">` }, fake);
	assert.deepEqual(items.filter((x) => x.level !== "ok"), []);
	assert.ok(items.some((x) => x.title === "The link works"));
});

test("mistakes are found", async () => {
	const items = await checkEmail({ ...base, subject: "FREE OFFER NOW!!! {{first_name}}", preheader: null, content: `<p>Hi {{first_name}}, act now.</p><a href="https://example.com/gone">x</a><a href="https://example.com/robots">y</a><a href="#">z</a><img src="https://example.com/gone.png"><img src="http://example.com/p.png" alt="ok">` }, fake);
	const t = (s: string) => items.find((x) => x.title.startsWith(s));
	assert.equal(items[0].level, "bad");
	assert.deepEqual(t("A link doesn't")?.list, ["https://example.com/gone (404)"]);
	assert.ok(t("A picture doesn't"));
	assert.ok(t("A picture has no description"));
	assert.ok(t("Some pictures use http"));
	assert.ok(t("A link goes nowhere"));
	assert.ok(t("A name tag has no fallback"));
	assert.ok(t("There's no preview text"));
	assert.deepEqual(t("Some words")?.list, ["act now"]);
	assert.equal(t("The subject line")?.list?.length, 3);
});

test("no subject is a mistake", async () => {
	const items = await checkEmail({ ...base, subject: "Untitled email", preheader: null, content: "<p>Hi</p>" }, fake);
	assert.equal(items[0].title, "There's no subject line");
});
