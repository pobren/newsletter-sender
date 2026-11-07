// Restore from a file: an uploaded backup is checked, then kept in the list like any other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveUploadedBackup } from "../src/backup.ts";

async function gz(text: string) {
	return new Response(new Response(text).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
function env() {
	const put: { key: string; rows?: string }[] = [];
	const IMAGES = { put: async (key: string, _d: unknown, o: any) => { put.push({ key, rows: o?.customMetadata?.rows }); } };
	return { e: { IMAGES } as any, put };
}

test("a real backup is kept, with its row count", async () => {
	const { e, put } = env();
	const file = await gz(`{"newsletterSender":1,"schema":"14"}\n{"t":"lists","r":{"id":"a"}}\n{"t":"lists","r":{"id":"b"}}\n`);
	const r = await saveUploadedBackup(e, file, new Date("2026-11-07T16:45:30Z"));
	assert.ok(!("error" in r));
	assert.equal(r.name, "newsletter-sender-2026-11-07-uploaded-164530.ndjson.gz");
	assert.equal(r.rows, 2);
	assert.equal(put[0].key, "backups/newsletter-sender-2026-11-07-uploaded-164530.ndjson.gz");
});

test("anything else is turned down and not kept", async () => {
	for (const file of [await gz(`{"something":"else"}\n`), new TextEncoder().encode("not gzip at all").buffer as ArrayBuffer]) {
		const { e, put } = env();
		const r = await saveUploadedBackup(e, file);
		assert.ok("error" in r && /isn't a Newsletter Sender backup/.test(r.error));
		assert.equal(put.length, 0);
	}
});
