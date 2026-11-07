// Backups in parts: a big backup is stored in 8 MB parts as it's made, and an uploaded file is checked before use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBackup, makeBackup, PART } from "../src/backup.ts";

const gz = (text: string) => new Response(text).body!.pipeThrough(new CompressionStream("gzip"));

test("checkBackup counts the rows of a real backup", async () => {
	assert.deepEqual(await checkBackup(gz(`{"newsletterSender":1,"schema":"14"}\n{"t":"lists","r":{"id":"a"}}\n{"t":"lists","r":{"id":"b"}}`)), { rows: 2 });
});

test("checkBackup turns down anything else", async () => {
	for (const body of [gz(`{"something":"else"}\n`), new Response("not gzip at all").body!, gz("")]) {
		const r = await checkBackup(body);
		assert.ok("error" in r && /isn't a Newsletter Sender backup/.test(r.error));
	}
});

/** A pretend database with one table of big random rows, and a pretend R2 bucket that remembers what it was given. */
function fakes(rowCount: number) {
	const rows = Array.from({ length: rowCount }, (_, i) => ({ _rowid_: i + 1, id: i + 1, junk: [...crypto.getRandomValues(new Uint8Array(300))].map((b) => b.toString(16).padStart(2, "0")).join("") }));
	const meta = new Map<string, string>();
	const DB = {
		prepare(sql: string) {
			const st = { args: [] as unknown[], bind(...a: unknown[]) { st.args = a; return st; },
				async all() {
					if (sql.includes("sqlite_master")) return { results: [{ name: "things" }] };
					if (sql.includes("LIKE 'backup_rows:%'")) return { results: [...meta].map(([key, value]) => ({ key, value })) };
					const after = Number(st.args[0]);
					return { results: rows.filter((r) => r._rowid_ > after).slice(0, 2000).map((r) => ({ ...r })) };
				},
				async first() { return sql.includes("meta") ? null : null; },
				async run() { if (sql.startsWith("INSERT INTO meta")) meta.set(String(st.args[0]), String(st.args[1])); if (sql.startsWith("DELETE FROM meta")) meta.delete(String(st.args[0])); return {}; } };
			return st;
		},
	};
	const stored = new Map<string, { size: number; parts: number[]; rows?: string }>();
	const IMAGES = {
		async put(key: string, data: Uint8Array, o: any) { stored.set(key, { size: data.length, parts: [], rows: o?.customMetadata?.rows }); },
		async createMultipartUpload(key: string) {
			const sizes: number[] = [];
			return { uploadId: "u", async uploadPart(n: number, b: Uint8Array) { sizes[n - 1] = b.length; return { partNumber: n, etag: `e${n}` }; },
				async complete() { stored.set(key, { size: sizes.reduce((a, b) => a + b, 0), parts: sizes }); }, async abort() {} };
		},
		async list() { return { objects: [...stored].map(([key, v]) => ({ key, size: v.size, uploaded: new Date(), customMetadata: v.rows ? { rows: v.rows } : {} })), truncated: false }; },
		async delete(key: string) { stored.delete(key); },
	};
	return { env: { DB, IMAGES } as any, stored, meta };
}

test("a small backup goes in one piece with its row count", async () => {
	const { env, stored } = fakes(50);
	const b = await makeBackup(env, new Date("2026-11-07T17:00:00Z"));
	assert.equal(b.rows, 50);
	const s = stored.get(`backups/${b.name}`)!;
	assert.equal(s.parts.length, 0);
	assert.equal(s.rows, "50");
});

test("a big backup goes in 8 MB parts, and its row count is kept for the list", async () => {
	const { env, stored, meta } = fakes(30000);
	const b = await makeBackup(env, new Date("2026-11-07T17:00:00Z"));
	const s = stored.get(`backups/${b.name}`)!;
	assert.ok(s.parts.length >= 2, `parts: ${s.parts.length}`);
	for (const p of s.parts.slice(0, -1)) assert.equal(p, PART);
	assert.equal(s.size, b.size);
	assert.equal(meta.get(`backup_rows:${b.name}`), "30000");
});
