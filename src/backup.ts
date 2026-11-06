// Daily backups: every night a copy of the whole database goes into your own R2 bucket (the one pictures use, under
// backups/), and the last 30 are kept. Each one is gzipped JSON lines: a header, then one line per row.
// Secrets never go in a backup (the key that unlocks your sending keys, the sign in key, saved tokens), so a
// downloaded copy is safe to keep anywhere. After a restore, sending keys saved since then need entering again only
// if the install itself is new.

import { getMeta, iso, setMeta, type Env } from "./db.ts";

const PREFIX = "backups/";
export const KEEP = 30;
/** Meta rows that stay out of backups: secrets, and short lived sign up rate limits. */
const PRIVATE = /^(seal_key|session_key|links_token:|rl:|loadtest|backup_)/;
const PAGE = 2000;

export interface BackupInfo { name: string; size: number; at: string; rows: number | null }

export const backupName = (d: Date, extra = "") => `newsletter-sender-${d.toISOString().slice(0, 10)}${extra}.ndjson.gz`;
const okName = (n: string) => /^newsletter-sender-\d{4}-\d{2}-\d{2}(-[a-z0-9-]{1,30})?\.ndjson\.gz$/.test(n);

async function tableNames(db: D1Database): Promise<string[]> {
	const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name").all<{ name: string }>();
	return results.map((r) => r.name);
}

/** Makes a backup now and keeps the newest 30. */
export async function makeBackup(env: Env, now = new Date(), extra = ""): Promise<BackupInfo> {
	if (!env.IMAGES) throw new Error("Backups need the R2 bucket. See the README.");
	const db = env.DB;
	const gz = new CompressionStream("gzip");
	const w = gz.writable.getWriter();
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	const reading = (async () => {
		const r = gz.readable.getReader();
		for (;;) {
			const { done, value } = await r.read();
			if (done) break;
			parts.push(value);
		}
	})();
	let rows = 0;
	await w.write(enc.encode(JSON.stringify({ newsletterSender: 1, schema: await getMeta(db, "schema"), at: now.toISOString() }) + "\n"));
	for (const t of await tableNames(db)) {
		let last = -Infinity;
		for (;;) {
			const { results } = await db.prepare(`SELECT rowid AS _rowid_, * FROM "${t}" WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`).bind(last === -Infinity ? -9e15 : last).all<Record<string, unknown>>();
			let buf = "";
			for (const row of results) {
				last = Number(row._rowid_);
				delete row._rowid_;
				if (t === "meta" && PRIVATE.test(String(row.key))) continue;
				buf += JSON.stringify({ t, r: row }) + "\n";
				rows++;
			}
			if (buf) await w.write(enc.encode(buf));
			if (results.length < PAGE) break;
		}
	}
	await w.close();
	await reading;
	const size = parts.reduce((n, p) => n + p.length, 0);
	const all = new Uint8Array(size);
	let at = 0;
	for (const p of parts) (all.set(p, at), (at += p.length));
	const name = backupName(now, extra);
	await env.IMAGES.put(PREFIX + name, all, { httpMetadata: { contentType: "application/gzip" }, customMetadata: { rows: String(rows) } });
	for (const old of (await listBackups(env)).slice(KEEP)) await env.IMAGES.delete(PREFIX + old.name);
	return { name, size, at: now.toISOString(), rows };
}

/** Newest first. */
export async function listBackups(env: Env): Promise<BackupInfo[]> {
	if (!env.IMAGES) return [];
	const out: BackupInfo[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.IMAGES.list({ prefix: PREFIX, cursor, include: ["customMetadata"] } as R2ListOptions);
		for (const o of page.objects) out.push({ name: o.key.slice(PREFIX.length), size: o.size, at: o.uploaded.toISOString(), rows: o.customMetadata?.rows ? Number(o.customMetadata.rows) : null });
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

export async function getBackup(env: Env, name: string): Promise<R2ObjectBody | null> {
	if (!env.IMAGES || !okName(name)) return null;
	return env.IMAGES.get(PREFIX + name);
}

/** Once a day, from 2am UTC, on the minute cron. */
export async function backupIfDue(env: Env, now = new Date()): Promise<void> {
	if (!env.IMAGES || now.getUTCHours() < 2) return;
	const day = now.toISOString().slice(0, 10);
	if ((await getMeta(env.DB, "backup_day")) === day) return;
	await setMeta(env.DB, "backup_day", day);
	try {
		await makeBackup(env, now);
		await setMeta(env.DB, "backup_error", null);
	} catch (e) {
		await setMeta(env.DB, "backup_error", `${iso()} ${(e as Error).message}`.slice(0, 300));
		throw e;
	}
}

/**
 * Puts a backup back. A fresh backup of things as they are now is made first, so a restore can be undone. Tables in
 * the backup are emptied and refilled; secrets stay as they are. Refuses while a campaign is sending.
 */
export async function restoreBackup(env: Env, name: string): Promise<{ rows: number; before: string } | { error: string }> {
	const db = env.DB;
	const obj = await getBackup(env, name);
	if (!obj) return { error: "That backup has gone." };
	if (await db.prepare("SELECT 1 FROM campaigns WHERE status = 'sending' LIMIT 1").first()) return { error: "A campaign is sending. Please pause it or let it finish first." };
	const before = await makeBackup(env, new Date(), "-before-restore");
	const have = new Set(await tableNames(db));
	const cols = new Map<string, Set<string>>();
	const cleared = new Set<string>();
	const pending: D1PreparedStatement[] = [];
	const flush = async () => { if (pending.length) await db.batch(pending.splice(0)); };
	let rows = 0, header = true, rest = "";
	const reader = obj.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
	const line = async (text: string) => {
		if (!text) return;
		const item = JSON.parse(text);
		if (header) {
			header = false;
			if (item?.newsletterSender !== 1) throw new Error("That file isn't a Newsletter Sender backup.");
			return;
		}
		const t = String(item.t);
		if (!have.has(t) || !item.r || typeof item.r !== "object") return;
		if (!cols.has(t)) cols.set(t, new Set((await db.prepare(`SELECT name FROM pragma_table_info('${t.replace(/'/g, "")}')`).all<{ name: string }>()).results.map((c) => c.name)));
		if (t !== "meta" && !cleared.has(t)) {
			await flush();
			await db.prepare(`DELETE FROM "${t}"`).run();
			cleared.add(t);
		}
		// Secrets stay as they are, and so does the schema version (this install's tables are already up to date).
		if (t === "meta" && (PRIVATE.test(String(item.r.key)) || item.r.key === "schema")) return;
		const keys = Object.keys(item.r).filter((k) => cols.get(t)!.has(k));
		if (!keys.length) return;
		pending.push(db.prepare(`INSERT OR REPLACE INTO "${t}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => item.r[k])));
		rows++;
		if (pending.length >= 200) await flush();
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const lines = (rest + value).split("\n");
		rest = lines.pop() ?? "";
		for (const l of lines) await line(l);
	}
	await line(rest);
	await flush();
	return { rows, before: before.name };
}
