// Updates: the owner presses Update and the app installs the newest release into its own Cloudflare Worker, using the
// Cloudflare token they already gave it (it can edit Workers). Everything set up stays: the database, pictures, queue,
// secrets, schedules and web addresses, because the new code is uploaded with every existing binding kept. The
// version that was running is remembered, so Undo puts it straight back.
//
// Releases are published on GitHub by .github/workflows/release.yml whenever package.json gets a new version: a
// release.json (version, notes, Cloudflare settings and a SHA-256 of each file) plus the built files themselves.

import { getMeta, iso, setMeta, type BrandRow } from "./db.ts";
import { workerName } from "./cloudflare.ts";
import { linksToken } from "./settings.ts";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
/** The day this version was released (YYYY-MM-DD), from package.json. Agency licences cover versions by this date. */
export const RELEASED: string = (pkg as { released?: string }).released ?? "";
/** Where releases live. The newest one is always at …/latest/download/<file>. */
export const RELEASES = "https://github.com/pobren/newsletter-sender/releases";
const API = "https://api.cloudflare.com/client/v4";
/** How often the app looks for a new version. */
const CHECK_MS = 6 * 3600_000;
/** Every kind of binding a Newsletter Sender Worker might have, all kept as they are when the code is replaced. */
const KEEP = ["d1", "queue", "r2_bucket", "send_email", "secret_text", "plain_text", "json", "kv_namespace", "version_metadata", "analytics_engine", "service", "durable_object_namespace", "secrets_store_secret", "ai", "browser", "hyperdrive", "workflow", "images", "assets"];

export interface ReleaseFile { name: string; sha256: string; type: string }
export interface Release {
	version: string;
	date: string;
	notes: string[];
	compatibility_date: string;
	compatibility_flags?: string[];
	main_module: string;
	files: ReleaseFile[];
}

/** 1.2.10 is newer than 1.2.9. Anything that isn't a plain version counts as older. */
export function newer(a: string, b: string): boolean {
	const p = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
	const x = p(a), y = p(b);
	if (!x || !y) return false;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return false;
}

/** Only release files we expect, with a fingerprint each: nothing else is ever uploaded. */
export function checkRelease(r: any): Release | null {
	if (!r || typeof r !== "object" || !/^\d+\.\d+\.\d+$/.test(r.version ?? "")) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(r.compatibility_date ?? "") || typeof r.main_module !== "string") return null;
	if (!Array.isArray(r.files) || !r.files.length || r.files.length > 10) return null;
	for (const f of r.files) {
		if (!/^[A-Za-z0-9._-]{1,120}$/.test(f?.name ?? "") || !/^[0-9a-f]{64}$/.test(f?.sha256 ?? "")) return null;
		if (!["application/javascript+module", "text/plain", "application/wasm", "application/octet-stream"].includes(f.type)) return null;
	}
	if (!r.files.some((f: ReleaseFile) => f.name === r.main_module)) return null;
	return { version: r.version, date: String(r.date ?? ""), notes: Array.isArray(r.notes) ? r.notes.filter((n: unknown) => typeof n === "string").slice(0, 30) : [], compatibility_date: r.compatibility_date, compatibility_flags: Array.isArray(r.compatibility_flags) ? r.compatibility_flags.filter((f: unknown) => typeof f === "string") : [], main_module: r.main_module, files: r.files };
}

async function sha256(b: ArrayBuffer): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** The newest release, asked for at most every six hours (kept in meta). `fresh` asks now. */
export async function latest(db: D1Database, fresh = false, fetcher: typeof fetch = fetch, base = RELEASES): Promise<Release | null> {
	const saved = await getMeta(db, "update_latest");
	const got = saved ? JSON.parse(saved) : null;
	if (!fresh && got && Date.now() - (got.at ?? 0) < CHECK_MS) return got.release ? checkRelease(got.release) : null;
	try {
		const res = await fetcher(`${base}/latest/download/release.json`, { headers: { accept: "application/json" } });
		const release = res.ok ? checkRelease(await res.json()) : null;
		await setMeta(db, "update_latest", JSON.stringify({ at: Date.now(), release }));
		return release;
	} catch {
		return got?.release ? checkRelease(got.release) : null;
	}
}

async function cf(token: string, method: string, path: string, body: BodyInit | null, fetcher: typeof fetch, json = true): Promise<{ ok: boolean; data: any; message: string }> {
	const res = await fetcher(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(json && body ? { "content-type": "application/json" } : {}) }, body });
	const data: any = await res.json().catch(() => null);
	return { ok: res.ok && data?.success !== false, data, message: data?.errors?.map((e: any) => e.message).join(" ") || (res.ok ? "" : `error ${res.status}`) };
}

/** A Cloudflare token the app already has that can edit Workers, and the account and Worker it should update. */
export async function updateTarget(db: D1Database, host: string, fetcher: typeof fetch = fetch): Promise<{ token: string; account: string; script: string } | { error: string }> {
	const brands = (await db.prepare("SELECT * FROM brands ORDER BY created_at").all<BrandRow>()).results;
	const tried = new Set<string>();
	for (const b of brands) {
		const token = await linksToken(db, b);
		if (!token || tried.has(token)) continue;
		tried.add(token);
		const accounts = await cf(token, "GET", "/accounts?per_page=50", null, fetcher);
		for (const a of accounts.data?.result ?? []) {
			const script = await workerName(token, a.id, host, fetcher);
			const there = await cf(token, "GET", `/accounts/${a.id}/workers/scripts/${encodeURIComponent(script)}/deployments`, null, fetcher);
			if (there.ok) return { token, account: a.id, script };
		}
	}
	return { error: tried.size ? "Your Cloudflare token can't update this app. Please make a new one with the button under Settings, Tracking (it can edit Workers), then try again." : "Updating needs a Cloudflare token. Please add one under Settings, Sending or Tracking first." };
}

/** The version of the Worker that's live now, so Undo can go back to it. */
async function liveVersion(t: { token: string; account: string; script: string }, fetcher: typeof fetch): Promise<string | null> {
	const r = await cf(t.token, "GET", `/accounts/${t.account}/workers/scripts/${encodeURIComponent(t.script)}/deployments`, null, fetcher);
	const d = r.data?.result?.deployments?.[0];
	return d?.versions?.length === 1 ? d.versions[0].version_id : null;
}

/** Downloads a release, checks every file against its fingerprint, then uploads it with all the bindings kept. */
export async function install(db: D1Database, host: string, release: Release, fetcher: typeof fetch = fetch, base = RELEASES): Promise<{ ok: true } | { error: string }> {
	const t = await updateTarget(db, host, fetcher);
	if ("error" in t) return t;
	const form = new FormData();
	for (const f of release.files) {
		const res = await fetcher(`${base}/download/v${release.version}/${f.name}`);
		if (!res.ok) return { error: `The new version couldn't be downloaded (${res.status}). Please try again later.` };
		const bytes = await res.arrayBuffer();
		if ((await sha256(bytes)) !== f.sha256) return { error: "The download didn't match the release, so nothing was changed. Please try again later." };
		form.append(f.name, new File([bytes], f.name, { type: f.type }));
	}
	form.append("metadata", new Blob([JSON.stringify({
		main_module: release.main_module,
		compatibility_date: release.compatibility_date,
		compatibility_flags: release.compatibility_flags ?? [],
		keep_bindings: KEEP,
		placement: { mode: "smart" },
		limits: { cpu_ms: 300000 },
		observability: { enabled: true },
		annotations: { "workers/message": `Newsletter Sender ${release.version}`, "workers/tag": `v${release.version}` },
	})], { type: "application/json" }));
	const before = await liveVersion(t, fetcher);
	const up = await cf(t.token, "PUT", `/accounts/${t.account}/workers/scripts/${encodeURIComponent(t.script)}`, form, fetcher, false);
	if (!up.ok) return { error: `Cloudflare didn't take the new version: ${up.message || "no reason given"}. Nothing was changed.` };
	await setMeta(db, "update_last", JSON.stringify({ from: VERSION, to: release.version, before, at: iso() }));
	return { ok: true };
}

/** Puts back the version that was running before the last update. */
export async function undo(db: D1Database, host: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; version: string } | { error: string }> {
	const last = JSON.parse((await getMeta(db, "update_last")) ?? "null");
	if (!last?.before) return { error: "There's no earlier version to go back to." };
	const t = await updateTarget(db, host, fetcher);
	if ("error" in t) return t;
	const r = await cf(t.token, "POST", `/accounts/${t.account}/workers/scripts/${encodeURIComponent(t.script)}/deployments`, JSON.stringify({ strategy: "percentage", versions: [{ version_id: last.before, percentage: 100 }], annotations: { "workers/message": `Back to Newsletter Sender ${last.from}` } }), fetcher);
	if (!r.ok) return { error: `Cloudflare couldn't go back: ${r.message || "no reason given"}.` };
	await setMeta(db, "update_last", JSON.stringify({ ...last, undone: iso() }));
	return { ok: true, version: last.from };
}
