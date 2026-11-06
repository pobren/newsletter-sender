// Referrals: each reader gets their own link to share. Friends who sign up through it (and confirm) count towards
// rewards the owner sets, such as "bring 3 friends, get the guide". Each reward is emailed once, automatically.
// Only people new to the list count, and a friend who later leaves stops counting.

import { esc } from "./render.ts";

export interface Reward {
	/** How many friends it takes. */
	at: number;
	/** What it is, shown on the reader's referral page: "The spring guide". */
	name: string;
	/** The email that gives it to them. */
	subject: string;
	text: string;
	/** Optional: a button in that email, such as a download link. */
	link?: string;
}

export interface Referrals {
	on: boolean;
	rewards: Reward[];
}

const MAX_REWARDS = 10;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : "");

/** Settings as saved: whole numbers from 1 up, one reward per number, lowest first. */
export function cleanReferrals(x: unknown): Referrals {
	const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
	const seen = new Set<number>();
	const rewards: Reward[] = [];
	for (const r of Array.isArray(o.rewards) ? o.rewards : []) {
		if (!r || typeof r !== "object") continue;
		const at = Math.floor(Number((r as any).at));
		const name = str((r as any).name, 80);
		if (!Number.isFinite(at) || at < 1 || at > 100_000 || !name || seen.has(at)) continue;
		seen.add(at);
		const link = str((r as any).link, 500);
		rewards.push({
			at,
			name,
			subject: str((r as any).subject, 150) || `Your reward: ${name}`,
			text: str((r as any).text, 3000) || `Thank you for sharing. You've brought ${at} ${at === 1 ? "friend" : "friends"}, so here's ${name}.`,
			...(/^https:\/\/[^\s"<>]+$/i.test(link) ? { link } : {}),
		});
		if (rewards.length >= MAX_REWARDS) break;
	}
	rewards.sort((a, b) => a.at - b.at);
	return { on: Boolean(o.on), rewards };
}

export function parseReferrals(s: string | null | undefined): Referrals {
	if (!s) return { on: false, rewards: [] };
	try {
		return cleanReferrals(JSON.parse(s));
	} catch {
		return { on: false, rewards: [] };
	}
}

/** The rewards someone has earned with this many friends and not been sent yet. */
export function dueRewards(r: Referrals, count: number, given: number[]): Reward[] {
	const had = new Set(given);
	return r.rewards.filter((x) => x.at <= count && !had.has(x.at));
}

/** The next reward to aim for, if there is one. */
export function nextReward(r: Referrals, count: number): Reward | null {
	return r.rewards.find((x) => x.at > count) ?? null;
}

async function sha(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A reader's own code: who they are plus a signature, so nobody can make up someone else's. */
export async function refCode(secret: string, subscriber: string): Promise<string> {
	return subscriber + (await sha(`ns-ref:${secret}:${subscriber}`)).slice(0, 10);
}

/** Who a code belongs to, or null when it's been tampered with. */
export async function refFrom(secret: string, code: unknown): Promise<string | null> {
	if (typeof code !== "string" || !/^[0-9a-f]{26}$/.test(code)) return null;
	const sub = code.slice(0, 16);
	return (await refCode(secret, sub)) === code ? sub : null;
}

const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_MAIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18v12H3z"/><path d="M3 7l9 6 9-6"/></svg>';
const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>';
const ICON_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/></svg>';
const ICON_TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_GIFT = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v9h14v-9M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5M12 8s1.5-5 4-5a2.5 2.5 0 0 1 0 5"/></svg>';

/** The reader's referral page: their link, ways to share it, how many friends so far and what's next. */
export function referralBody(o: { listName: string; brandName: string; link: string; count: number; settings: Referrals }): string {
	const { count, settings: r } = o;
	const next = nextReward(r, count);
	const msg = `I read ${o.listName} and thought you'd like it too. You can sign up here: ${o.link}`;
	const steps = r.rewards.map((x) => {
		const got = count >= x.at;
		return `<li class="${got ? "got" : ""}">${got ? ICON_TICK : ICON_GIFT}<span><b>${esc(x.name)}</b><span class="small">${got ? "Yours. We've emailed it to you." : `${x.at} ${x.at === 1 ? "friend" : "friends"}`}</span></span></li>`;
	}).join("");
	return `<div class="card"><h1>Share ${esc(o.listName)}</h1>
<p>${count ? `You've brought <b>${count}</b> ${count === 1 ? "friend" : "friends"} so far. Thank you!` : "Know someone who'd enjoy it? Send them your own link."}${next ? ` Bring ${next.at - count} more for <b>${esc(next.name)}</b>.` : ""}</p>
<label for="rl">Your link</label><input id="rl" value="${esc(o.link)}" readonly>
<div class="btns"><button type="button" id="cp">${ICON_COPY}Copy your link</button><a class="btn ghost" href="mailto:?subject=${encodeURIComponent(o.listName)}&amp;body=${encodeURIComponent(msg)}">${ICON_MAIL}Email a friend</a><a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">${ICON_CHAT}WhatsApp</a><button type="button" class="ghost" id="sh" hidden>${ICON_SHARE}Share</button></div>
${steps ? `<h2 style="font-size:20px;margin:28px 0 4px">Rewards</h2><ul class="rw">${steps}</ul>` : ""}
<p class="small" style="margin-top:18px">Friends count once they've confirmed their email address. We never tell them who you are.</p></div>
<style>.rw{list-style:none;padding:0;margin:0}.rw li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid #efe2e9}.rw li:last-child{border-bottom:0}.rw svg{flex:none;width:24px;height:24px;fill:none;stroke:#6b5a73;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin-top:2px}.rw li.got svg{stroke:#166534}.rw span{display:block}button.ghost{background:#fff;color:var(--c);border:2px solid #e6cfdb}</style>
<script>(function(){var i=document.getElementById("rl"),c=document.getElementById("cp"),s=document.getElementById("sh");i.onclick=function(){i.select()};c.onclick=function(){i.select();(navigator.clipboard?navigator.clipboard.writeText(i.value):Promise.reject()).catch(function(){document.execCommand("copy")});c.lastChild.textContent="Copied";};if(navigator.share){s.hidden=false;s.onclick=function(){navigator.share({title:${JSON.stringify(o.listName).replace(/</g, "\\u003c")},url:i.value}).catch(function(){})}}})()</script>`;
}
