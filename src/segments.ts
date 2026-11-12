// Saved segments: name an audience filter once (such as "Active clickers": clicked a link in the last 60 days, tagged
// customer) and pick it in one click when setting up a campaign. A segment keeps the lists, tags and "did something
// lately" choice; it's filled in fresh each time, so the people in it change as they read.

import { getMeta, setMeta } from "./db.ts";
import { parseAudience, type Audience } from "./sending.ts";

export interface Segment {
	id: string;
	name: string;
	audience: Omit<Audience, "resend">;
}

/** Plenty for anyone, and keeps the meta row small. */
export const MAX_SEGMENTS = 50;

const key = (brand: string) => `segments:${brand}`;

export async function getSegments(db: D1Database, brand: string): Promise<Segment[]> {
	try {
		const v = JSON.parse((await getMeta(db, key(brand))) ?? "[]");
		return Array.isArray(v) ? v.filter((s) => s && typeof s.id === "string" && typeof s.name === "string") : [];
	} catch {
		return [];
	}
}

/** A segment from the editor: a name and the audience. Null when there's nothing worth saving. */
export function cleanSegment(v: any): { name: string; audience: Segment["audience"] } | null {
	const name = typeof v?.name === "string" ? v.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
	const { resend, ...audience } = parseAudience(v?.audience);
	if (!name || (!audience.lists.length && !audience.tags.length && !audience.activity)) return null;
	return { name, audience };
}

/** Save a segment. One with the same name (any case) is replaced, so saving again updates it. */
export async function saveSegment(db: D1Database, brand: string, s: { name: string; audience: Segment["audience"] }): Promise<Segment> {
	const all = await getSegments(db, brand);
	const old = all.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
	const seg: Segment = { id: old?.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 16), name: s.name, audience: s.audience };
	const next = old ? all.map((x) => (x.id === old.id ? seg : x)) : [...all, seg];
	if (next.length > MAX_SEGMENTS) throw new Error(`You can keep up to ${MAX_SEGMENTS} segments. Delete one you don't use first.`);
	next.sort((a, b) => a.name.localeCompare(b.name));
	await setMeta(db, key(brand), JSON.stringify(next));
	return seg;
}

export async function deleteSegment(db: D1Database, brand: string, id: string): Promise<void> {
	const all = await getSegments(db, brand);
	await setMeta(db, key(brand), JSON.stringify(all.filter((s) => s.id !== id)));
}

/** Lists a segment names that the brand no longer has are dropped when it's used. */
export function forLists(s: Segment, lists: string[]): Segment["audience"] {
	return { ...s.audience, lists: s.audience.lists.filter((id) => lists.includes(id)) };
}
