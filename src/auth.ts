// Accounts and sessions. The owner's account is made at /setup with the SETUP_TOKEN secret, so nobody else can
// claim a new install first. Sign-in sets a signed cookie for 30 days; "Sign out everywhere" ends every older one.

import { accountById, getMeta, newId, setMeta, type AccountRow } from "./db.ts";

const COOKIE = "ns_session";
const DAYS = 30;
const ITERATIONS = 100_000;
/** Wrong passwords allowed in 15 minutes before sign-in waits. */
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
/** The example code in .dev.vars.example and the Deploy to Cloudflare form. It never works. */
export const EXAMPLE_TOKEN = "replace-this-with-your-own-long-secret-code";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

function sameText(a: string, b: string): boolean {
	const x = enc.encode(a);
	const y = enc.encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

/** Whether the SETUP_TOKEN secret is usable: set, long enough, and not the example. */
export const setupTokenOk = (token: string | undefined) => !!token && token.length >= 16 && token !== EXAMPLE_TOKEN;
export const setupCodeMatches = (token: string | undefined, code: unknown) => setupTokenOk(token) && typeof code === "string" && sameText(code, token!);

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
	return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return `pbkdf2$${ITERATIONS}$${hex(salt.buffer)}$${await derive(password, salt, ITERATIONS)}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
	const [kind, iter, salt, hash] = stored.split("$");
	if (kind !== "pbkdf2" || !salt || !hash) return false;
	return sameText(await derive(password, unhex(salt), Number(iter)), hash);
}

export function passwordProblem(p: unknown): string | null {
	if (typeof p !== "string" || p.length < 10) return "Please choose a password of at least 10 characters.";
	if (p.length > 200) return "That password is too long.";
	return null;
}

async function sign(key: string, text: string): Promise<string> {
	const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
}

async function sessionKey(db: D1Database): Promise<string> {
	let key = await getMeta(db, "session_key");
	if (!key) {
		key = newId(32);
		await setMeta(db, "session_key", key);
	}
	return key;
}

/** A Set-Cookie header for a new 30-day session for this account. */
export async function sessionCookie(db: D1Database, a: Pick<AccountRow, "id" | "session_ver">, secure: boolean): Promise<string> {
	const text = `${a.id}.${a.session_ver}.${Date.now() + DAYS * 86_400_000}`;
	return `${COOKIE}=${text}.${await sign(await sessionKey(db), text)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86_400}${secure ? "; Secure" : ""}`;
}

export const clearCookie = (secure: boolean) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

/** The signed-in account, or null. */
export async function currentAccount(request: Request, db: D1Database): Promise<AccountRow | null> {
	const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{16})\\.(\\d+)\\.(\\d+)\\.([0-9a-f]{64})`).exec(request.headers.get("cookie") ?? "");
	if (!m || Number(m[3]) < Date.now()) return null;
	if (!sameText(await sign(await sessionKey(db), `${m[1]}.${m[2]}.${m[3]}`), m[4])) return null;
	const a = await accountById(db, m[1]);
	return a && a.session_ver === Number(m[2]) ? a : null;
}

/** Ends every session for one account: its old cookies no longer match. */
export const signOutEverywhere = (db: D1Database, id: string) => db.prepare("UPDATE accounts SET session_ver = session_ver + 1 WHERE id = ?").bind(id).run();

const failKey = (email: string) => `signin_fails:${email.toLowerCase()}`;

/** Whether sign-in for this address should wait because of too many wrong passwords. */
export async function tooManyTries(db: D1Database, email: string): Promise<boolean> {
	const raw = await getMeta(db, failKey(email));
	const f = raw ? (JSON.parse(raw) as { n: number; since: number }) : null;
	return !!f && f.n >= MAX_FAILS && Date.now() - f.since < FAIL_WINDOW_MS;
}

export async function noteFailure(db: D1Database, email: string): Promise<void> {
	const raw = await getMeta(db, failKey(email));
	const f = raw ? (JSON.parse(raw) as { n: number; since: number }) : null;
	const fresh = !f || Date.now() - f.since >= FAIL_WINDOW_MS;
	await setMeta(db, failKey(email), JSON.stringify(fresh ? { n: 1, since: Date.now() } : { n: f!.n + 1, since: f!.since }));
}

export const clearFailures = (db: D1Database, email: string) => setMeta(db, failKey(email), null);
