// Blog posts to newsletter drafts: reading RSS and Atom, and making drafts only for new posts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryD1 } from "./d1.ts";
import { checkFeed, draftHtml, parseFeed, readFeed, saveFeed, shorten, textOf } from "../src/blogfeed.ts";

const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Bakery blog</title>${items}</channel></rss>`;
const item = (n: number, extra = "") => `<item><title><![CDATA[Post ${n}: bread &amp; butter]]></title><link>https://blog.example/post-${n}</link><guid>https://blog.example/?p=${n}</guid><description>&lt;p&gt;All about &lt;b&gt;loaf ${n}&lt;/b&gt;.&lt;/p&gt;</description>${extra}</item>`;

test("RSS: title, link, id, summary and the picture", () => {
	const posts = parseFeed(rss(item(2, `<media:content url="https://blog.example/2.jpg" medium="image"/>`) + item(1, `<content:encoded><![CDATA[<p><img src="/img/1.png"> Hello</p>]]></content:encoded>`)), "https://blog.example/feed");
	assert.equal(posts.length, 2);
	assert.deepEqual(posts[0], { id: "https://blog.example/?p=2", title: "Post 2: bread & butter", link: "https://blog.example/post-2", summary: "All about loaf 2.", image: "https://blog.example/2.jpg", date: null });
	assert.equal(posts[1].image, "https://blog.example/img/1.png");
});

test("Atom: the alternate link and the id", () => {
	const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">A &lt;i&gt;new&lt;/i&gt; post</title><link rel="self" href="https://b.example/self"/><link rel="alternate" href="https://b.example/new"/><id>tag:b.example,2026:1</id><updated>2026-11-12T10:00:00Z</updated><summary>Short one</summary></entry></feed>`;
	const [p] = parseFeed(xml, "https://b.example/atom.xml");
	assert.equal(p.title, "A new post");
	assert.equal(p.link, "https://b.example/new");
	assert.equal(p.id, "tag:b.example,2026:1");
	assert.equal(p.summary, "Short one");
});

test("text and summaries are tidy", () => {
	assert.equal(textOf("<p>Fish &amp; chips&#33; <script>x()</script>&nbsp;now</p>"), "Fish & chips! now");
	assert.equal(shorten("one two three four", 3), "one two three…");
	const html = draftHtml({ id: "1", title: "A <b>bold</b> post", link: "https://b.example/x", summary: "Hi", image: null, date: null }, "#a3195b");
	assert.match(html, /A &lt;b&gt;bold&lt;\/b&gt; post/);
	assert.match(html, /Read the full post/);
});

test("a blog home page leads to its feed", async () => {
	const f = (async (url: string) => (url === "https://b.example/" ? new Response(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`) : new Response(rss(item(1))))) as unknown as typeof fetch;
	const r = await readFeed("https://b.example/", f);
	assert.ok("posts" in r);
	assert.equal((r as any).feedUrl, "https://b.example/feed.xml");
	assert.ok("error" in (await readFeed("https://b.example/", (async () => new Response("<html></html>")) as unknown as typeof fetch)));
});

test("the first check only remembers; later checks make drafts for new posts only", async () => {
	const db = memoryD1([
		"CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
		"CREATE TABLE campaigns (id TEXT PRIMARY KEY, brand_id TEXT, name TEXT, subject TEXT, preheader TEXT, blocks TEXT, html TEXT, audience TEXT, created_at TEXT, updated_at TEXT)",
		"CREATE TABLE events (id INTEGER PRIMARY KEY, brand_id TEXT, kind TEXT, subscriber_id TEXT, campaign_id TEXT, detail TEXT, at TEXT)",
	]);
	await saveFeed(db, "b1", { url: "https://blog.example/feed", on: true, lists: ["l1"], seen: [], checked_at: null, error: null, made: 0 });
	let feed = rss(item(2) + item(1));
	const f = (async () => new Response(feed)) as unknown as typeof fetch;
	const brand = { id: "b1", colour: "#a3195b" };
	assert.deepEqual((await checkFeed(db, brand, f)).made, []);
	feed = rss(item(4) + item(3) + item(2) + item(1));
	const made = (await checkFeed(db, brand, f)).made;
	assert.equal(made.length, 2);
	const { results } = await db.prepare("SELECT subject, audience FROM campaigns ORDER BY created_at, rowid").all<any>();
	assert.deepEqual(results.map((r) => r.subject), ["Post 3: bread & butter", "Post 4: bread & butter"]);
	assert.deepEqual(JSON.parse(results[0].audience), { lists: ["l1"], tags: [] });
	assert.deepEqual((await checkFeed(db, brand, f)).made, []);
});
