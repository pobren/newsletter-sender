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
/** Big backups are stored in parts of this size (R2 wants every part but the last to be the same size, 5 MB or more). */
export const PART = 8 * 1024 * 1024;
const GZ = { contentType: "application/gzip" };
/** Where a backup's row count is kept when it was stored in parts (R2 only takes metadata at the start). */
const rowsKey = (name: string) => `backup_rows:${name}`;

/**
 * Stores a gzipped backup as it's made: in one go while it's small, in 8 MB parts once it outgrows that, so even a
 * backup of millions of rows never has to fit in the Worker's memory.
 */
class Store {
	private buf: Uint8Array[] = [];
	private len = 0;
	private upload?: R2MultipartUpload;
	private parts: R2UploadedPart[] = [];
	size = 0;
	private bucket: R2Bucket;
	private key: string;
	constructor(bucket: R2Bucket, key: string) {
		this.bucket = bucket;
		this.key = key;
	}
	async add(chunk: Uint8Array) {
		this.buf.push(chunk);
		this.len += chunk.length;
		this.size += chunk.length;
		while (this.len >= PART) await this.part(this.take(PART));
	}
	private take(n: number): Uint8Array {
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const c = this.buf[0];
			const need = n - at;
			if (c.length <= need) {
				out.set(c, at);
				at += c.length;
				this.buf.shift();
			} else {
				out.set(c.subarray(0, need), at);
				this.buf[0] = c.subarray(need);
				at += need;
			}
		}
		this.len -= n;
		return out;
	}
	private async part(bytes: Uint8Array) {
		this.upload ??= await this.bucket.createMultipartUpload(this.key, { httpMetadata: GZ });
		this.parts.push(await this.upload.uploadPart(this.parts.length + 1, bytes));
	}
	/** True when it went in parts, so the row count has to be kept elsewhere. */
	async finish(rows: number): Promise<boolean> {
		const rest = this.take(this.len);
		if (!this.upload) {
			await this.bucket.put(this.key, rest, { httpMetadata: GZ, customMetadata: { rows: String(rows) } });
			return false;
		}
		if (rest.length) await this.part(rest);
		await this.upload.complete(this.parts);
		return true;
	}
	async abort() {
		await this.upload?.abort().catch(() => {});
	}
}

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
	const name = backupName(now, extra);
	const store = new Store(env.IMAGES, PREFIX + name);
	const gz = new CompressionStream("gzip");
	const w = gz.writable.getWriter();
	const enc = new TextEncoder();
	const reading = (async () => {
		const r = gz.readable.getReader();
		for (;;) {
			const { done, value } = await r.read();
			if (done) break;
			await store.add(value);
		}
	})();
	let rows = 0;
	try {
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
		await setMeta(db, rowsKey(name), (await store.finish(rows)) ? String(rows) : null);
	} catch (e) {
		await store.abort();
		throw e;
	}
	for (const old of (await listBackups(env)).slice(KEEP)) await removeBackup(env, old.name);
	return { name, size: store.size, at: now.toISOString(), rows };
}

async function removeBackup(env: Env, name: string) {
	await env.IMAGES!.delete(PREFIX + name);
	await setMeta(env.DB, rowsKey(name), null);
}

/** Newest first. */
export async function listBackups(env: Env): Promise<BackupInfo[]> {
	if (!env.IMAGES) return [];
	const out: BackupInfo[] = [];
	const counts = new Map((await env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'backup_rows:%'").all<{ key: string; value: string }>()).results.map((r) => [r.key, Number(r.value)]));
	let cursor: string | undefined;
	do {
		const page = await env.IMAGES.list({ prefix: PREFIX, cursor, include: ["customMetadata"] } as R2ListOptions);
		for (const o of page.objects) out.push({ name: o.key.slice(PREFIX.length), size: o.size, at: o.uploaded.toISOString(), rows: o.customMetadata?.rows ? Number(o.customMetadata.rows) : counts.get(rowsKey(o.key.slice(PREFIX.length))) ?? null });
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
 * Restore from a file. The page sends the file in 8 MB parts (so it can be any size), straight into the backups list
 * as "Uploaded from a file". Then we check it really is a Newsletter Sender backup before it can be put back.
 */
export async function startUpload(env: Env, now = new Date()): Promise<{ name: string; id: string } | { error: string }> {
	if (!env.IMAGES) return { error: "Backups need the R2 bucket. See the README." };
	const name = backupName(now, `-uploaded-${now.toISOString().slice(11, 19).replace(/:/g, "")}`);
	const up = await env.IMAGES.createMultipartUpload(PREFIX + name, { httpMetadata: GZ });
	return { name, id: up.uploadId };
}

export async function uploadPart(env: Env, name: string, id: string, n: number, bytes: ArrayBuffer): Promise<R2UploadedPart | { error: string }> {
	if (!env.IMAGES || !okName(name) || !id || !(n >= 1 && n <= 10000)) return { error: "That upload isn't going any more. Please try again." };
	return env.IMAGES.resumeMultipartUpload(PREFIX + name, id).uploadPart(n, bytes);
}

const NOT_OURS = "That file isn't a Newsletter Sender backup. Please choose a file you downloaded from Backups (it ends .ndjson.gz).";

/** Reads a backup through to count its rows; an error if it isn't one of ours. */
export async function checkBackup(body: ReadableStream<Uint8Array>): Promise<{ rows: number } | { error: string }> {
	let rows = -1, rest = "";
	const see = (l: string) => {
		if (!l) return true;
		if (rows === -1) {
			if (JSON.parse(l)?.newsletterSender !== 1) return false;
			rows = 0;
		} else rows++;
		return true;
	};
	try {
		const reader = body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const lines = (rest + value).split("\n");
			rest = lines.pop() ?? "";
			for (const l of lines) if (!see(l)) return { error: NOT_OURS };
		}
		if (!see(rest)) return { error: NOT_OURS };
	} catch {
		return { error: NOT_OURS };
	}
	return rows === -1 ? { error: NOT_OURS } : { rows };
}

export async function finishUpload(env: Env, name: string, id: string, parts: R2UploadedPart[]): Promise<{ rows: number } | { error: string }> {
	if (!env.IMAGES || !okName(name) || !id || !Array.isArray(parts) || !parts.length) return { error: "That upload isn't going any more. Please try again." };
	await env.IMAGES.resumeMultipartUpload(PREFIX + name, id).complete(parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
	const obj = await env.IMAGES.get(PREFIX + name);
	const checked = obj ? await checkBackup(obj.body) : { error: NOT_OURS };
	if ("error" in checked) {
		await removeBackup(env, name);
		return checked;
	}
	await setMeta(env.DB, rowsKey(name), String(checked.rows));
	return checked;
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
