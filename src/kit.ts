// Small helpers the dashboard's JSON routes share (api.ts, and the agency edition's routes).

import { newId } from "./db.ts";
import { slugify } from "./render.ts";

export const ok = (data: unknown = { ok: true }, init: ResponseInit = {}) => Response.json(data, { ...init, headers: { "cache-control": "no-store", ...(init.headers ?? {}) } });
export const bad = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
export const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
export const multi = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");

export async function body(request: Request): Promise<Record<string, any>> {
	try {
		return ((await request.json()) as Record<string, any>) ?? {};
	} catch {
		return {};
	}
}

/** A list's web address part: unique across the install. */
export async function freeSlug(db: D1Database, want: string, self?: string): Promise<string> {
	const base = slugify(want).slice(0, 40);
	for (let i = 0; i < 50; i++) {
		const s = i ? `${base}-${i + 1}` : base;
		const hit = await db.prepare("SELECT id FROM lists WHERE slug = ?").bind(s).first<{ id: string }>();
		if (!hit || hit.id === self) return s;
	}
	return `${base}-${newId(3)}`;
}
