// The writing helper (Settings, Writing helper): optional, and off unless the owner switches it on. It suggests subject
// lines, tidies up or shortens a bit of the email someone has picked, and turns rough notes into a first draft.
//
// It uses Cloudflare's own AI (Workers AI) on the owner's Cloudflare account, so nothing goes to any other company and
// there's no key to set up. Cloudflare gives every account a free allowance each day (about 80 uses of this helper);
// past that it's billed to the owner's Cloudflare account at about £1 per 1,000 uses. A daily cap stops a runaway bill.

import { getMeta, setMeta, type Env } from "./db.ts";

/** Good at plain, natural UK English and quick enough to wait for. */
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** At most this many uses a day for each newsletter (about 30p at Cloudflare's prices). */
export const DAILY_CAP = 300;
/** The most text we send in one go. */
export const MAX_TEXT = 6000;

export const TASKS = ["subjects", "tidy", "shorter", "friendlier", "draft"] as const;
export type Task = (typeof TASKS)[number];

const key = (brand: string) => `ai:${brand}`;
const dayKey = (brand: string, day: string) => `aiday:${brand}:${day}`;
const monthKey = (brand: string, month: string) => `aimonth:${brand}:${month}`;

export async function getAi(db: D1Database, brand: string): Promise<{ on: boolean }> {
	try {
		return { on: JSON.parse((await getMeta(db, key(brand))) ?? "null")?.on === true };
	} catch {
		return { on: false };
	}
}
export const saveAi = (db: D1Database, brand: string, on: boolean) => setMeta(db, key(brand), JSON.stringify({ on }));

export async function aiUse(db: D1Database, brand: string, now = new Date()): Promise<{ today: number; month: number }> {
	const d = now.toISOString().slice(0, 10);
	return { today: Number((await getMeta(db, dayKey(brand, d))) ?? 0), month: Number((await getMeta(db, monthKey(brand, d.slice(0, 7)))) ?? 0) };
}

/** The words of an email, without its HTML, for the helper to read. */
export function textOf(html: string): string {
	return html
		.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&rsquo;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, MAX_TEXT);
}

const STYLE = "Write in UK English (such as colour, organise, favourite). Use plain, warm, everyday words and short sentences. Don't use dashes of any kind to join clauses, don't use emojis, don't use exclamation marks unless the writer did, and don't add facts, names, prices, dates or links that aren't in the text.";

export function messages(task: Task, text: string, name: string): { role: "system" | "user"; content: string }[] {
	const who = `You help ${name} write their email newsletter. ${STYLE}`;
	const ask: Record<Task, string> = {
		subjects: "Suggest 5 subject lines for this newsletter email. Each under 60 characters, specific to what the email says, no clickbait and no capitals for every word. Reply with just the 5 subject lines, one a line, nothing else.",
		tidy: "Tidy up this part of a newsletter email: fix spelling, grammar and anything unclear, keeping the writer's voice, meaning and length. Reply with just the new text, nothing else.",
		shorter: "Make this part of a newsletter email about half as long, keeping what matters and the writer's voice. Reply with just the new text, nothing else.",
		friendlier: "Make this part of a newsletter email sound a little friendlier and more personal, keeping the meaning and about the same length. Reply with just the new text, nothing else.",
		draft: "Turn these rough notes into a first draft of a newsletter email: a short opening line, then a short paragraph for each point. No subject line, no greeting placeholder and no sign off. Reply with just the email text, nothing else.",
	};
	return [
		{ role: "system", content: who },
		{ role: "user", content: `${ask[task]}\n\n---\n${text}\n---` },
	];
}

/** What the model said, made safe to drop into the email: subject lines, or paragraphs. */
export function tidyOutput(task: Task, raw: string): string[] {
	const lines = String(raw ?? "")
		.replace(/\r/g, "")
		.replace(/\*\*|__|^#+\s*/gm, "")
		.trim()
		// Models sometimes start with "Here are..." or "Here's the new text:".
		.replace(/^(sure[,.!]?\s*)?here(?:'s| is| are)[^\n]*:\s*\n+/i, "");
	if (task === "subjects")
		return lines
			.split("\n")
			.map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").replace(/^["'“‘]|["'”’]$/g, "").trim())
			.filter((l) => l && l.length <= 120 && !/:$/.test(l))
			.slice(0, 5);
	return lines
		.replace(/^---\s*|\s*---$/g, "")
		.split(/\n{2,}/)
		.map((p) => p.replace(/\s*\n\s*/g, " ").trim())
		.filter(Boolean)
		.slice(0, 30);
}

export class AiError extends Error {}

/** Run one use of the helper for a newsletter. Throws AiError with a message for the person when it can't. */
export async function write(env: Env, brand: { id: string; name: string }, task: Task, input: string, now = new Date()): Promise<string[]> {
	if (!(await getAi(env.DB, brand.id)).on) throw new AiError("The writing helper is off. Switch it on under Settings, Writing helper.");
	if (!env.AI) throw new AiError("The writing helper isn't connected to Cloudflare's AI yet. Update to the latest version and it connects by itself.");
	const text = (task === "subjects" ? textOf(input) : input.replace(/\r/g, "").trim()).slice(0, MAX_TEXT);
	if (text.length < 3) throw new AiError(task === "draft" ? "Type a few notes first." : task === "subjects" ? "Write the email first, then we can suggest subject lines for it." : "Pick some of the email's text first.");
	const used = await aiUse(env.DB, brand.id, now);
	if (used.today >= DAILY_CAP) throw new AiError(`That's the writing helper's limit of ${DAILY_CAP} uses for today. It starts again tomorrow.`);
	let out: any;
	try {
		out = await env.AI.run(MODEL, { messages: messages(task, text, brand.name), max_tokens: task === "draft" ? 900 : 600, temperature: task === "subjects" ? 0.8 : 0.4 });
	} catch (e) {
		console.error("writing helper", e);
		throw new AiError("Cloudflare's AI didn't answer just then. Please try again in a minute.");
	}
	const d = now.toISOString().slice(0, 10);
	await setMeta(env.DB, dayKey(brand.id, d), String(used.today + 1));
	await setMeta(env.DB, monthKey(brand.id, d.slice(0, 7)), String(used.month + 1));
	const result = tidyOutput(task, typeof out?.response === "string" ? out.response : "");
	if (!result.length) throw new AiError("The helper didn't come up with anything that time. Please try again.");
	return result;
}

/** Old daily counters can go (the cron calls this; it's one query). Monthly ones stay for the record. */
export async function tidyAiUse(db: D1Database, now = new Date()): Promise<void> {
	await db.prepare("DELETE FROM meta WHERE key LIKE 'aiday:%' AND substr(key, -10) < ?").bind(now.toISOString().slice(0, 10)).run();
}
