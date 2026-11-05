// Amazon SES and SNS with nothing but Web Crypto: AWS Signature Version 4, the SES v2 calls Newsletter Sender
// makes (account, domain, configuration set, send) and the SNS calls that bring bounces back to the Worker.

const enc = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

function hex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** AWS's flavour of URI encoding: everything but A-Z a-z 0-9 - _ . ~ is percent-encoded. */
export function awsEncode(s: string): string {
	return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface AwsKeys {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
}

export interface SignInput {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string;
	service: string;
	/** "YYYYMMDDTHHMMSSZ"; defaults to now. */
	amzDate?: string;
}

/** Returns the headers to send: the given ones plus host, x-amz-date and authorization. */
export async function signAws(input: SignInput, keys: AwsKeys): Promise<Record<string, string>> {
	const url = new URL(input.url);
	const amzDate = input.amzDate ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const day = amzDate.slice(0, 8);
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim();
	headers.host = url.host;
	headers["x-amz-date"] = amzDate;

	const names = Object.keys(headers).sort();
	const query = [...url.searchParams].map(([k, v]) => [awsEncode(k), awsEncode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
	const path = url.pathname.split("/").map((p) => awsEncode(decodeURIComponent(p))).join("/") || "/";
	const canonical = [input.method, path, query.map(([k, v]) => `${k}=${v}`).join("&"), names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), await sha256Hex(input.body)].join("\n");
	const scope = `${day}/${keys.region}/${input.service}/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");

	let key = await hmac(enc.encode(`AWS4${keys.secretAccessKey}`), day);
	key = await hmac(key, keys.region);
	key = await hmac(key, input.service);
	key = await hmac(key, "aws4_request");
	const signature = hex(await hmac(key, toSign));

	const { host: _host, ...rest } = headers;
	return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

export interface AwsAnswer {
	ok: boolean;
	status: number;
	data: any;
	text: string;
}

/** One signed SES v2 call (JSON). */
export async function ses(keys: AwsKeys, method: string, path: string, body: unknown = null, fetcher: typeof fetch = fetch): Promise<AwsAnswer> {
	const url = `https://email.${keys.region}.amazonaws.com/v2/email${path}`;
	const text = body === null ? "" : JSON.stringify(body);
	const headers = await signAws({ method, url, headers: body === null ? {} : { "content-type": "application/json" }, body: text, service: "ses" }, keys);
	const res = await fetcher(url, { method, headers, body: body === null ? undefined : text });
	const out = await res.text();
	let data: any = null;
	try {
		data = out ? JSON.parse(out) : null;
	} catch {}
	// SESv2 puts the error name in a header and only a sentence in the body, so keep the name with the text.
	const kind = res.headers.get("x-amzn-errortype")?.split(":")[0] ?? "";
	return { ok: res.ok, status: res.status, data, text: kind ? `${kind} ${out}` : out };
}

/** Amazon already has this (a domain, configuration set or event destination), which is fine when setting up again. */
export const alreadyThere = (a: AwsAnswer) => !a.ok && /AlreadyExists|already exist/i.test(a.text);

/** One signed SNS call (form in, XML out). */
export async function sns(keys: AwsKeys, params: Record<string, string>, fetcher: typeof fetch = fetch): Promise<AwsAnswer> {
	const url = `https://sns.${keys.region}.amazonaws.com/`;
	const body = new URLSearchParams({ ...params, Version: "2010-03-31" }).toString();
	const headers = await signAws({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, body, service: "sns" }, keys);
	const res = await fetcher(url, { method: "POST", headers, body });
	const text = await res.text();
	return { ok: res.ok, status: res.status, data: null, text };
}

/** The first <Tag>value</Tag> in an XML answer. */
export const xmlValue = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;

/** What Amazon said went wrong, in a sentence. */
export function awsError(a: AwsAnswer): string {
	const msg = a.data?.message ?? a.data?.Message ?? xmlValue(a.text, "Message") ?? a.text.slice(0, 200);
	if (a.status === 403) return `Amazon turned the keys down: ${msg}. Check the access key and secret, and that the user has the SES and SNS permissions in the guide.`;
	return `Amazon said: ${msg || `error ${a.status}`}`;
}

/** Amazon's answer means "slow down": wait and try again rather than give up. */
export const isThrottle = (a: { status: number; text: string }) => a.status === 429 || /Throttl|TooManyRequests|Maximum sending rate exceeded/i.test(a.text);

/** The SES account: how fast it may send, how many a day, and whether it's still in the sandbox. */
export async function sesAccount(keys: AwsKeys, fetcher: typeof fetch = fetch): Promise<{ rate: number; max24: number; sent24: number; production: boolean; enabled: boolean; enforcement: string } | { error: string }> {
	const a = await ses(keys, "GET", "/account", null, fetcher);
	if (!a.ok) return { error: awsError(a) };
	const q = a.data?.SendQuota ?? {};
	return { rate: Number(q.MaxSendRate) || 1, max24: Number(q.Max24HourSend) || 200, sent24: Number(q.SentLast24Hours) || 0, production: Boolean(a.data?.ProductionAccessEnabled), enabled: a.data?.SendingEnabled !== false, enforcement: String(a.data?.EnforcementStatus ?? "HEALTHY") };
}

/** The AWS regions SES runs in that people pick most. Any valid region name works. */
export const SES_REGIONS = ["eu-west-1", "eu-west-2", "eu-central-1", "us-east-1", "us-east-2", "us-west-2", "ap-southeast-2", "ap-south-1", "ca-central-1"];
export const isRegion = (r: unknown): r is string => typeof r === "string" && /^[a-z]{2}-[a-z]+-\d$/.test(r);
