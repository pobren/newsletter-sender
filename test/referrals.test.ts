import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanReferrals, dueRewards, nextReward, parseReferrals, refCode, referralBody, refFrom } from "../src/referrals.ts";
import { renderEmail } from "../src/render.ts";

test("referral settings are tidied: whole numbers, one reward each, lowest first, https links only", () => {
	const r = cleanReferrals({
		on: 1,
		rewards: [
			{ at: "5", name: "Mug", link: "javascript:alert(1)" },
			{ at: 2.7, name: "  Guide  ", subject: "Here it is", text: "Thanks!", link: "https://example.com/guide.pdf" },
			{ at: 2, name: "Same number twice" },
			{ at: 0, name: "Too few" },
			{ at: 3, name: "" },
			"nonsense",
		],
	});
	assert.equal(r.on, true);
	assert.deepEqual(r.rewards.map((x) => [x.at, x.name]), [[2, "Guide"], [5, "Mug"]]);
	assert.equal(r.rewards[0].link, "https://example.com/guide.pdf");
	assert.equal(r.rewards[1].link, undefined);
	assert.match(r.rewards[1].subject, /Mug/);
	assert.match(r.rewards[1].text, /5 friends/);
});

test("bad or missing settings mean referrals are off", () => {
	assert.deepEqual(parseReferrals(null), { on: false, rewards: [] });
	assert.deepEqual(parseReferrals("{nope"), { on: false, rewards: [] });
});

test("rewards are due once each, and the next one is the lowest still to reach", () => {
	const r = cleanReferrals({ on: true, rewards: [{ at: 1, name: "A" }, { at: 3, name: "B" }, { at: 10, name: "C" }] });
	assert.deepEqual(dueRewards(r, 3, []).map((x) => x.name), ["A", "B"]);
	assert.deepEqual(dueRewards(r, 3, [1]).map((x) => x.name), ["B"]);
	assert.deepEqual(dueRewards(r, 3, [1, 3]), []);
	assert.equal(nextReward(r, 0)?.name, "A");
	assert.equal(nextReward(r, 3)?.name, "C");
	assert.equal(nextReward(r, 10), null);
});

test("referral codes can't be made up", async () => {
	const code = await refCode("secret", "0123456789abcdef");
	assert.match(code, /^0123456789abcdef[0-9a-f]{10}$/);
	assert.equal(await refFrom("secret", code), "0123456789abcdef");
	assert.equal(await refFrom("other secret", code), null);
	assert.equal(await refFrom("secret", "fedcba9876543210" + code.slice(16)), null);
	assert.equal(await refFrom("secret", 42), null);
});

test("emails fill in each reader's referral link and count", () => {
	const look = { brandName: "The Friday Letter", colour: "#a3195b", unsubscribeUrl: "https://n.example/u/abc", referralUrl: "https://n.example/r/news/abc", referralCount: 4 };
	const out = renderEmail("Hi", `<p>You've brought {{referral_count}}. <a href="{{referral_url}}">Share</a></p>`, look, { email: "a@b.com" });
	assert.match(out.html, /You've brought 4\./);
	assert.match(out.html, /href="https:\/\/n\.example\/r\/news\/abc"/);
	assert.match(out.text, /You've brought 4\./);
	// Not a counted click link.
	assert.equal(out.links.length, 0);
});

test("the referral page shows the link, progress and what's next", () => {
	const settings = cleanReferrals({ on: true, rewards: [{ at: 1, name: "Stickers" }, { at: 3, name: "The <guide>" }] });
	const h = referralBody({ listName: "News", brandName: "Paul", link: "https://n.example/s/news?r=abc", count: 1, settings });
	assert.match(h, /brought <b>1<\/b> friend so far/);
	assert.match(h, /Bring 2 more for <b>The &lt;guide&gt;<\/b>/);
	assert.match(h, /Yours\. We've emailed it to you\./);
	assert.match(h, /value="https:\/\/n\.example\/s\/news\?r=abc"/);
});
