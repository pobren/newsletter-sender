import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitise } from "../src/render.ts";

test("sanitise takes out scripts however they're written", () => {
	for (const h of ['<img/onerror=alert(1) src=x>', '<svg/onload=alert(1)>', '<img src=x onerror="alert(1)">', "<b\"onclick='x'>"]) assert.doesNotMatch(sanitise(h), /on(error|load|click)/i, h);
	for (const h of ['<a href="java&#115;cript:alert(1)">x</a>', '<a href="java&#x73;cript:alert(1)">x</a>', '<a href="javascript&colon;alert(1)">x</a>', '<a href=" javascript:alert(1)">x</a>', '<a href="JaVaScRiPt:x">x</a>', '<a href="jav\tascript:x">x</a>', "<a href=javascript:x>x</a>"]) assert.match(sanitise(h), /href="#"/, h);
	assert.equal(sanitise("<script>x</script><p>Hi</p>"), "<p>Hi</p>");
});

test("sanitise leaves ordinary emails alone", () => {
	const h = '<p style="color:red">Hi <a href="https://example.com/?a=1&amp;b=2">there</a> <img src="https://example.com/a.png" alt="one"></p><p>Turn it on: click online now</p>';
	assert.equal(sanitise(h), h);
});
