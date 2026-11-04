// Bringing a list in and taking it out. Reads a CSV from any newsletter tool (Mailchimp, Sendy, Substack, Kit and
// spreadsheets all work): it finds the email column by itself, joins first and last names, and keeps any other
// column as a custom field.

/** Rows of cells from CSV text: quoted cells, commas or semicolons or tabs, Windows or Unix line ends. */
export function parseCsv(text: string): string[][] {
	const src = text.replace(/^﻿/, "");
	const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
	const sep = [",", ";", "\t"].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"' && src[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === sep) {
			row.push(cell);
			cell = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && src[i + 1] === "\n") i++;
			row.push(cell);
			if (row.some((x) => x.trim())) rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	row.push(cell);
	if (row.some((x) => x.trim())) rows.push(row);
	return rows;
}

export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

export const cleanEmail = (x: unknown): string | null => {
	const t = typeof x === "string" ? x.trim().toLowerCase() : "";
	return t.length <= 254 && EMAIL_RE.test(t) ? t : null;
};

/** A field key from a column heading: "Company Name" becomes "company_name". */
export const fieldKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export interface ImportRow {
	email: string;
	name: string | null;
	fields: Record<string, string>;
	tags: string[];
}

/** Columns we read ourselves rather than keep as fields. */
const SKIP = new Set(["email", "email_address", "e_mail", "name", "full_name", "first_name", "firstname", "fname", "last_name", "lastname", "surname", "lname", "tags", "status", "member_rating", "optin_time", "optin_ip", "confirm_time", "confirm_ip", "latitude", "longitude", "gmtoff", "dstoff", "timezone", "cc", "region", "last_changed", "leid", "euid", "notes", "date_added", "date_created", "signup_date", "unsubscribed", "bounced", "complaint", "joined", "subscribed", "list"]);

/** Reads the rows of a CSV into subscribers. Rows without a good email are counted, not kept. */
export function readImport(rows: string[][]): { rows: ImportRow[]; skipped: number; columns: string[] } {
	if (!rows.length) return { rows: [], skipped: 0, columns: [] };
	const head = rows[0].map(fieldKey);
	let emailCol = head.findIndex((h) => ["email", "email_address", "e_mail", "mail"].includes(h));
	let start = 1;
	if (emailCol < 0) {
		// No heading row: the first column that looks like an email.
		emailCol = rows[0].findIndex((c) => cleanEmail(c));
		start = 0;
		if (emailCol < 0) return { rows: [], skipped: rows.length, columns: [] };
	}
	const col = (...names: string[]) => (start ? head.findIndex((h) => names.includes(h)) : -1);
	const nameCol = col("name", "full_name");
	const firstCol = col("first_name", "firstname", "fname");
	const lastCol = col("last_name", "lastname", "surname", "lname");
	const tagCol = col("tags");
	const extra = start ? head.map((h, i) => ({ h, i })).filter(({ h, i }) => h && !SKIP.has(h) && i !== emailCol) : [];
	const seen = new Set<string>();
	const out: ImportRow[] = [];
	let skipped = 0;
	for (const r of rows.slice(start)) {
		const email = cleanEmail(r[emailCol]);
		if (!email || seen.has(email)) {
			skipped++;
			continue;
		}
		seen.add(email);
		const joined = [r[firstCol] ?? "", r[lastCol] ?? ""].map((s) => s.trim()).filter(Boolean).join(" ");
		const name = ((nameCol >= 0 ? r[nameCol] : "") || joined || "").trim().slice(0, 120) || null;
		const fields: Record<string, string> = {};
		for (const { h, i } of extra) if ((r[i] ?? "").trim()) fields[h] = r[i].trim().slice(0, 500);
		const tags = tagCol >= 0 ? (r[tagCol] ?? "").split(/[,;|]/).map((t) => cleanTag(t)).filter((t): t is string => !!t).slice(0, 20) : [];
		out.push({ email, name, fields, tags });
	}
	return { rows: out, skipped, columns: extra.map((e) => e.h) };
}

export const cleanTag = (x: unknown): string | null => {
	const t = typeof x === "string" ? x.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 40) : "";
	return t || null;
};

/** One CSV cell, quoted when it needs to be, and safe to open in a spreadsheet (no formulas). */
export function csvCell(v: unknown): string {
	let s = v === null || v === undefined ? "" : String(v);
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");
