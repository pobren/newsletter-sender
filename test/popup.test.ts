import { test } from "node:test";
import assert from "node:assert/strict";
import { popupScript, popupTestPage } from "../src/popup.ts";

test("the pop up script is valid and keeps list text safe", () => {
	const js = popupScript({ endpoint: "https://x.test/s/news", listName: "News </script><script>alert(1)</script>", colour: "#a3195b", siteKey: null, fields: [], key: "ns_popup_news" });
	assert.doesNotThrow(() => new Function(js));
	assert.doesNotMatch(js, /<\/script>/i);
});

test("the try it page escapes the settings", () => {
	const page = popupTestPage("https://x.test/s/news/popup.js", new URLSearchParams({ title: `"><img src=x onerror=alert(1)>` }));
	assert.doesNotMatch(page, /<img src=x/);
	assert.match(page, /data-every="0"/);
});
