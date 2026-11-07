// A copy of each nightly backup in the owner's own Amazon S3, for owners who send with Amazon SES. It keeps a backup
// away from Cloudflare, so if the Cloudflare account were ever closed the newsletter can come back on a new install
// (Settings, Backups, Restore from a file). The setup stack (aws/newsletter-sender-ses.yaml) makes a private bucket
// called newsletter-sender-backups-<account>-<region> that deletes copies after 31 days, and lets our key write to it.

import { signAws, xmlValue, type AwsKeys } from "./aws.ts";
import { firstBrand, getMeta, iso, setMeta, type Env } from "./db.ts";
import { sesKeys } from "./providers.ts";
import { loadProvider } from "./settings.ts";

export interface S3Status { bucket: string | null; at: string | null; name: string | null; error: string | null }

/** The SES keys of the first brand that sends with Amazon SES, if any. */
export async function s3Keys(env: Env): Promise<AwsKeys | null> {
	const brand = await firstBrand(env.DB);
	const p = brand ? await loadProvider(env.DB, brand) : null;
	return p?.provider === "ses" && p.accessKeyId ? sesKeys(p) : null;
}

/** Which AWS account the keys belong to (STS GetCallerIdentity needs no permissions). */
export async function accountId(keys: AwsKeys, fetcher: typeof fetch = fetch): Promise<string | { error: string }> {
	const url = "https://sts.amazonaws.com/";
	const body = "Action=GetCallerIdentity&Version=2011-06-15";
	const headers = await signAws({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, body, service: "sts" }, { ...keys, region: "us-east-1" });
	const res = await fetcher(url, { method: "POST", headers, body });
	const text = await res.text();
	return (res.ok && xmlValue(text, "Account")) || { error: `Amazon didn't say which account these keys belong to (${res.status}).` };
}

export const bucketName = (account: string, region: string) => `newsletter-sender-backups-${account}-${region}`;

/** Copies one backup from R2 into the owner's bucket, streamed, so its size doesn't matter. */
export async function copyToS3(env: Env, name: string, keys: AwsKeys | null, fetcher: typeof fetch = fetch): Promise<S3Status> {
	const out: S3Status = { bucket: null, at: iso(), name, error: null };
	try {
		if (!keys) return { ...out, error: "Copies to Amazon S3 need Amazon SES as your sending service." };
		const acct = await accountId(keys, fetcher);
		if (typeof acct !== "string") return { ...out, error: acct.error };
		out.bucket = bucketName(acct, keys.region);
		const obj = await env.IMAGES?.get(`backups/${name}`);
		if (!obj) return { ...out, error: "That backup has gone." };
		const url = `https://${out.bucket}.s3.${keys.region}.amazonaws.com/${encodeURIComponent(name)}`;
		const headers = await signAws({ method: "PUT", url, headers: { "content-type": "application/gzip", "x-amz-content-sha256": "UNSIGNED-PAYLOAD" }, body: "", service: "s3", payloadHash: "UNSIGNED-PAYLOAD" }, keys);
		// S3 wants the length up front, so stream the body through a FixedLengthStream (Workers only; tests run in Node).
		let body: ReadableStream = obj.body, piping: Promise<void> = Promise.resolve();
		if (typeof FixedLengthStream !== "undefined") {
			const fixed = new FixedLengthStream(obj.size);
			piping = obj.body.pipeTo(fixed.writable);
			body = fixed.readable;
		}
		const res = await fetcher(url, { method: "PUT", headers, body });
		await piping.catch(() => {});
		if (!res.ok) {
			const text = await res.text();
			const code = xmlValue(text, "Code");
			if (code === "NoSuchBucket" || code === "AccessDenied" || res.status === 403 || res.status === 404) return { ...out, error: "setup" };
			return { ...out, error: `Amazon S3 said ${code ?? res.status}: ${xmlValue(text, "Message") ?? ""}`.trim() };
		}
		return out;
	} catch (e) {
		return { ...out, error: (e as Error).message };
	}
}

export async function s3Status(env: Env): Promise<S3Status | null> {
	return JSON.parse((await getMeta(env.DB, "backup_s3")) ?? "null");
}

/** After the nightly backup: copy it to S3 when the owner sends with SES, and remember how it went for Settings. */
export async function copyNightly(env: Env, name: string): Promise<void> {
	const keys = await s3Keys(env);
	if (!keys) return;
	await setMeta(env.DB, "backup_s3", JSON.stringify(await copyToS3(env, name, keys)));
}
