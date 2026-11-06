import assert from "node:assert/strict";
import test from "node:test";
import { fullCssUrls, inlineStyleSheets } from "../src/pagecss.ts";

const page = new URL("https://example.com/news/");
const sheet = (body: string, type = "text/css") => new Response(body, { headers: { "content-type": type } });

test("linked style sheets come into the page, with their own addresses made full", async () => {
	const asked: string[] = [];
	const html = `<html><head><link rel="stylesheet" href="/assets/site.css?v=1&amp;x=2"><link rel="icon" href="/fav.ico"></head><body><img src="https://example.com/a.png"></body></html>`;
	const out = await inlineStyleSheets(html, page, async (u) => {
		asked.push(u);
		return sheet(`body{background:url(../img/bg.png)}@font-face{src:url("/fonts/a.woff2")}`);
	});
	assert.deepEqual(asked, ["https://example.com/assets/site.css?v=1&x=2"]);
	assert.doesNotMatch(out, /rel="stylesheet"/);
	assert.match(out, /<link rel="icon"/);
	assert.match(out, /url\(https:\/\/example\.com\/img\/bg\.png\)/);
	assert.match(out, /url\("https:\/\/example\.com\/fonts\/a\.woff2"\)/);
	assert.match(out, /<head><style>img\{max-width:100%;height:auto\}<\/style>/);
});

test("a sheet that won't load is dropped, and only a few sheets are fetched", async () => {
	const links = Array.from({ length: 6 }, (_, i) => `<link href="/s${i}.css" rel='stylesheet'>`).join("");
	let calls = 0;
	const out = await inlineStyleSheets(`<head>${links}</head>`, page, async () => {
		calls++;
		return new Response("nope", { status: 404 });
	});
	assert.equal(calls, 4);
	assert.doesNotMatch(out, /<link/);
});

test("a sheet can't close its own style block early", async () => {
	const out = await inlineStyleSheets(`<link rel="stylesheet" href="a.css"><p>Hi</p>`, page, async () => sheet("p{color:red}</style><script>alert(1)</script>"));
	assert.equal(out.match(/<\/style>/g)?.length, 2);
	assert.match(out, /^<style>img/);
});

test("data and full addresses in a sheet are left alone", () => {
	assert.equal(fullCssUrls("a{background:url(data:image/png;base64,xx)}b{background:url('https://cdn.example/x.png')}", page), "a{background:url(data:image/png;base64,xx)}b{background:url('https://cdn.example/x.png')}");
});
