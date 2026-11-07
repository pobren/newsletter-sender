// A copy of each nightly backup in the owner's own Amazon S3 (src/s3.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketName, copyToS3 } from "../src/s3.ts";

const KEYS = { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "s".repeat(40), region: "eu-west-1" };
const env = (size = 5) => ({ IMAGES: { get: async () => ({ size, body: new Response(new Uint8Array(size)).body }) } }) as any;
function fake(putStatus: number, putBody = "") {
	const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
	const f = (async (url: string, init: RequestInit = {}) => {
		calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string> });
		if (url.startsWith("https://sts.")) return new Response("<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>");
		if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
		return new Response(putBody, { status: putStatus });
	}) as unknown as typeof fetch;
	return { f, calls };
}

test("the bucket is named after the account and region", () => {
	assert.equal(bucketName("123456789012", "eu-west-1"), "newsletter-sender-backups-123456789012-eu-west-1");
});

test("copies a backup into the owner's bucket, streamed and signed", async () => {
	const { f, calls } = fake(200);
	const r = await copyToS3(env(), "newsletter-sender-2026-11-07.ndjson.gz", KEYS, f);
	assert.equal(r.error, null);
	assert.equal(r.bucket, "newsletter-sender-backups-123456789012-eu-west-1");
	assert.equal(calls[1].method, "PUT");
	assert.equal(calls[1].url, "https://newsletter-sender-backups-123456789012-eu-west-1.s3.eu-west-1.amazonaws.com/newsletter-sender-2026-11-07.ndjson.gz");
	assert.equal(calls[1].headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
	assert.match(calls[1].headers.authorization, /\/eu-west-1\/s3\/aws4_request/);
});

test("no bucket or no permission yet means the stack needs updating", async () => {
	for (const [status, body] of [[404, "<Error><Code>NoSuchBucket</Code></Error>"], [403, "<Error><Code>AccessDenied</Code></Error>"]] as const) {
		const { f } = fake(status, body);
		assert.equal((await copyToS3(env(), "newsletter-sender-2026-11-07.ndjson.gz", KEYS, f)).error, "setup");
	}
});

test("without SES keys it says so", async () => {
	const { f } = fake(200);
	assert.match((await copyToS3(env(), "x", null, f)).error ?? "", /Amazon SES/);
});
