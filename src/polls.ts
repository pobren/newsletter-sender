// One click polls. The editor puts in a box with the question and an answer link for each choice. Each link's address is
// {{poll:ID:N}}: poll ID's answer N. When the email goes out, every reader gets their own signed address for each
// answer, so one click records their answer (clicking another answer changes it). Nothing else about them is kept.

export const POLL_TAG = /\{\{\s*poll:([a-z0-9]{4,12}):(\d{1,2})\s*\}\}/gi;

export interface Poll {
	id: string;
	question: string;
	answers: { n: number; text: string }[];
}

const decode = (s: string) =>
	s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d{1,5});/g, (_m, n) => String.fromCharCode(Number(n))).replace(/\s+/g, " ").trim();

/** The polls in an email: each question (from data-poll-q) and its answers (the link words), in order. */
export function pollsIn(html: string | null | undefined): Poll[] {
	if (!html) return [];
	const polls = new Map<string, Poll>();
	for (const m of html.matchAll(/data-poll="([a-z0-9]{4,12})"[^>]*?data-poll-q="([^"]*)"/gi)) polls.set(m[1], { id: m[1], question: decode(m[2]), answers: [] });
	for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']\{\{\s*poll:([a-z0-9]{4,12}):(\d{1,2})\s*\}\}["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		const p = polls.get(m[1]) ?? { id: m[1], question: "", answers: [] };
		polls.set(m[1], p);
		if (!p.answers.some((a) => a.n === Number(m[2]))) p.answers.push({ n: Number(m[2]), text: decode(m[3]) || `Answer ${m[2]}` });
	}
	return [...polls.values()].filter((p) => p.answers.length);
}

export const hasPoll = (html: string | null | undefined) => !!html && /\{\{\s*poll:/i.test(html);

/** The poll box the editor puts in. Answer links look like buttons, and work in every email app. */
export function pollHtml(id: string, question: string, answers: string[], colour: string): string {
	const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	const col = /^#[0-9a-f]{6}$/i.test(colour) ? colour : "#a3195b";
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" data-poll="${id}" data-poll-q="${esc(question)}" style="margin:8px 0 24px;border:1px solid #eadfe5;border-radius:12px"><tr><td style="padding:18px 20px">`
		+ `<p style="margin:0 0 12px;font:700 18px/1.4 Helvetica,Arial,sans-serif;color:#1d1424">${esc(question)}</p>`
		+ answers.map((a, i) => `<a href="{{poll:${id}:${i + 1}}}" style="display:block;margin:0 0 8px;padding:12px 16px;border:2px solid ${col};border-radius:8px;font:600 16px Helvetica,Arial,sans-serif;color:${col};text-decoration:none">${esc(a)}</a>`).join("")
		+ `<p style="margin:8px 0 0;font:13px Helvetica,Arial,sans-serif;color:#6b5a73">One click and you're done.</p></td></tr></table><p><br></p>`;
}
