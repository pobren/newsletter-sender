// The database: one Cloudflare D1 database that Newsletter Sender sets up itself on first use, so there are no
// migrations to run. Later versions add tables and columns here with IF NOT EXISTS and ALTER TABLE.
//
// Every row that belongs to a newsletter carries its brand_id. Stage 1 has one brand; businesses and agencies add more
// later without moving anything.

export interface Env {
	DB: D1Database;
	/** Batches of a send: the queue spreads a big list across many workers at once (sending.ts). */
	SENDS: Queue<SendBatch>;
	/** Images used in emails (optional). */
	IMAGES?: R2Bucket;
	/** Cloudflare's email service: sign up confirmations and other one off emails only, never newsletters. */
	EMAIL?: SendEmail;
	/** The secret code that lets the owner make (or reset) their account at /setup. */
	SETUP_TOKEN?: string;
	/** Optional Cloudflare Turnstile on sign in and the sign up forms (turnstile.ts): both are needed. */
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET?: string;
}

/** One queue message: the send rows from one id to another, both included, for one campaign. */
export interface SendBatch {
	campaign: string;
	from: number;
	to: number;
	/** Which go at sending this is: each carry on after a pause starts a new one, so older queue messages stand down. */
	run?: number;
}

export type SubStatus = "pending" | "active" | "unsubscribed";
export type Suppressed = "bounced" | "complained" | null;

export interface AccountRow {
	id: string;
	email: string;
	name: string | null;
	password: string | null;
	role: "owner" | "client";
	/** A client's one brand (the owner has none: they see every brand). */
	brand_id?: string | null;
	/** A client's permissions as JSON (team.ts). */
	limits?: string | null;
	session_ver: number;
	reset_token: string | null;
	reset_until: string | null;
	created_at: string;
}

export interface BrandRow {
	id: string;
	name: string;
	from_name: string;
	from_email: string;
	reply_to: string | null;
	/** The postal address or other line every email ends with (the law in many countries asks for one). */
	footer: string | null;
	colour: string;
	logo: string | null;
	/** The sending service, encrypted (providers.ts). */
	provider: string | null;
	/** Emails a second this brand may send; for Amazon SES it's read from the account. */
	rate: number;
	/** Opens and clicks: off unless the owner switches them on. */
	tracking: number;
	archive: number;
	/** Opens (an invisible picture) and clicks (links go through this install), each off unless switched on. */
	track_opens: number;
	track_clicks: number;
	/** Your own address for open and click links, such as https://news.yourdomain.com (a custom domain on this Worker). */
	track_domain: string | null;
	/** 1: a person can only be on one list. */
	one_list: number;
	/** Footer links: 1 = Manage your subscription, 2 = Forward to a friend (added together). */
	footer_links: number;
	done_email?: number;
	/** "all": unsubscribing leaves every list. "list": only the lists that email went to. */
	unsub_scope: "all" | "list";
	/** The name at the top of the app; empty shows Newsletter Sender. */
	app_name: string | null;
	/** The secret part of the bounce and complaint webhook addresses for this brand. */
	hook_key: string;
	created_at: string;
}

export interface ListRow {
	id: string;
	brand_id: string;
	name: string;
	slug: string;
	description: string | null;
	/** Custom fields asked for on the form, as JSON: [{ key, label, required }]. */
	fields: string;
	double_optin: number;
	welcome_subject: string | null;
	welcome_text: string | null;
	thanks_url: string | null;
	/** Other lists this list's form adds people to, as JSON: [id, ...]. */
	also_lists: string;
	created_at: string;
}

export interface SubscriberRow {
	id: string;
	brand_id: string;
	email: string;
	name: string | null;
	fields: string;
	tags: string;
	token: string;
	suppressed: Suppressed;
	suppressed_at: string | null;
	created_at: string;
}

export interface CampaignRow {
	id: string;
	/** Who this one comes from; empty means the brand's own (Settings). */
	from_name?: string | null;
	from_email?: string | null;
	reply_to?: string | null;
	run?: number;
	brand_id: string;
	/** What the owner calls it (only they see it). */
	name: string | null;
	subject: string;
	preheader: string | null;
	/** The email as blocks, as JSON (render.ts): emails made before the visual editor. */
	blocks: string;
	/** The email as HTML, from the visual editor, the HTML box or an uploaded design. */
	html: string | null;
	/** Who it goes to, as JSON: { lists: [...], tags: [...] }. */
	audience: string;
	status: "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled";
	send_at: string | null;
	started_at: string | null;
	finished_at: string | null;
	total: number;
	slug: string | null;
	public: number;
	created_at: string;
	updated_at: string;
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS accounts (
		id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, password TEXT, role TEXT NOT NULL DEFAULT 'owner',
		session_ver INTEGER NOT NULL DEFAULT 0, reset_token TEXT, reset_until TEXT, created_at TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS brands (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, from_name TEXT NOT NULL, from_email TEXT NOT NULL, reply_to TEXT, footer TEXT,
		colour TEXT NOT NULL DEFAULT '#a3195b', logo TEXT, provider TEXT, rate REAL NOT NULL DEFAULT 1, tracking INTEGER NOT NULL DEFAULT 0,
		archive INTEGER NOT NULL DEFAULT 1, hook_key TEXT NOT NULL, created_at TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS lists (
		id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT, fields TEXT NOT NULL DEFAULT '[]',
		double_optin INTEGER NOT NULL DEFAULT 1, welcome_subject TEXT, welcome_text TEXT, thanks_url TEXT, created_at TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS subscribers (
		id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT, fields TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
		token TEXT NOT NULL UNIQUE, suppressed TEXT, suppressed_at TEXT, created_at TEXT NOT NULL, UNIQUE (brand_id, email))`,
	`CREATE TABLE IF NOT EXISTS memberships (
		list_id TEXT NOT NULL, subscriber_id TEXT NOT NULL, status TEXT NOT NULL, source TEXT, confirm_token TEXT UNIQUE,
		created_at TEXT NOT NULL, confirmed_at TEXT, left_at TEXT, PRIMARY KEY (list_id, subscriber_id))`,
	`CREATE INDEX IF NOT EXISTS memberships_sub ON memberships (subscriber_id)`,
	`CREATE INDEX IF NOT EXISTS memberships_list_status ON memberships (list_id, status)`,
	`CREATE TABLE IF NOT EXISTS campaigns (
		id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, subject TEXT NOT NULL, preheader TEXT, blocks TEXT NOT NULL DEFAULT '[]',
		audience TEXT NOT NULL DEFAULT '{"lists":[],"tags":[]}', status TEXT NOT NULL DEFAULT 'draft', send_at TEXT, started_at TEXT, finished_at TEXT,
		total INTEGER NOT NULL DEFAULT 0, slug TEXT UNIQUE, public INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	// One row per person a campaign goes to. Its rowid orders the queue batches.
	`CREATE TABLE IF NOT EXISTS sends (
		id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id TEXT NOT NULL, subscriber_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
		message_id TEXT, error TEXT, sent_at TEXT, opened_at TEXT, clicked_at TEXT, UNIQUE (campaign_id, subscriber_id))`,
	// Segments by activity: what each person did with recent emails. Just the person, so marking an email sent doesn't
	// touch it: every index is written to as well as the table, and D1 counts each of those writes.
	`CREATE INDEX IF NOT EXISTS sends_sub ON sends (subscriber_id)`,
	// Automations: "when someone does this, then do that", and where each person is up to in each one.
	`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, name TEXT NOT NULL, trigger TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS automation_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, automation_id TEXT NOT NULL, subscriber_id TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', created_at TEXT NOT NULL, UNIQUE (automation_id, subscriber_id))`,
	`CREATE INDEX IF NOT EXISTS automation_runs_due ON automation_runs (status, due_at)`,
	`CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT, brand_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, subscriber_id TEXT, campaign_id TEXT, detail TEXT)`,
	`CREATE INDEX IF NOT EXISTS events_brand_at ON events (brand_id, at)`,
	`CREATE INDEX IF NOT EXISTS events_campaign ON events (campaign_id, kind)`,
	// Saved designs to start new campaigns from.
	`CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, name TEXT NOT NULL, html TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	// The blocklist: addresses and whole domains that never get anything, and are never imported.
	`CREATE TABLE IF NOT EXISTS blocklist (brand_id TEXT NOT NULL, email TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (brand_id, email))`,
	`CREATE TABLE IF NOT EXISTS blocked_domains (brand_id TEXT NOT NULL, domain TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (brand_id, domain))`,
	`CREATE TABLE IF NOT EXISTS links (campaign_id TEXT NOT NULL, n INTEGER NOT NULL, url TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (campaign_id, n))`,
	// Who clicked which link (one row per person per link), for unique clicks and "add these people to a list".
	`CREATE TABLE IF NOT EXISTS link_clicks (campaign_id TEXT NOT NULL, n INTEGER NOT NULL, send_id INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (campaign_id, n, send_id))`,
	// The public API: keys (only their hash is kept) and signed webhooks (the secret is sealed).
	`CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, tail TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)`,
	`CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, failures INTEGER NOT NULL DEFAULT 0, last_status INTEGER, last_at TEXT, created_at TEXT NOT NULL)`,
];
// Columns added after the first version. Each runs once; "duplicate column" means it's already there.
const MIGRATIONS = [
	"ALTER TABLE campaigns ADD COLUMN name TEXT",
	"ALTER TABLE campaigns ADD COLUMN html TEXT",
	"ALTER TABLE brands ADD COLUMN track_opens INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE brands ADD COLUMN track_clicks INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE brands ADD COLUMN track_domain TEXT",
	"ALTER TABLE brands ADD COLUMN one_list INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE brands ADD COLUMN unsub_scope TEXT NOT NULL DEFAULT 'all'",
	"ALTER TABLE lists ADD COLUMN also_lists TEXT NOT NULL DEFAULT '[]'",
	"ALTER TABLE brands ADD COLUMN app_name TEXT",
	// Reports: every open counted (not just the first), and the reader's country (two letters from Cloudflare, never the IP address).
	"ALTER TABLE sends ADD COLUMN opens INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE sends ADD COLUMN country TEXT",
	// Sending health: 1 = paused for safety (too many bounces or spam complaints), 2 = the owner chose to carry on anyway.
	"ALTER TABLE campaigns ADD COLUMN health INTEGER NOT NULL DEFAULT 0",
	// Footer links: 1 = Manage your subscription (on to start with), 2 = Forward to a friend.
	"ALTER TABLE brands ADD COLUMN footer_links INTEGER NOT NULL DEFAULT 1",
	"ALTER TABLE campaigns ADD COLUMN run INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE brands ADD COLUMN done_email INTEGER NOT NULL DEFAULT 1",
	"ALTER TABLE automations ADD COLUMN last_day TEXT",
	"ALTER TABLE campaigns ADD COLUMN from_name TEXT",
	"ALTER TABLE campaigns ADD COLUMN from_email TEXT",
	"ALTER TABLE campaigns ADD COLUMN reply_to TEXT",
	// Client logins: which brand they can open, and what they're allowed to do there.
	"ALTER TABLE accounts ADD COLUMN brand_id TEXT",
	"ALTER TABLE accounts ADD COLUMN limits TEXT",
	// Fewer writes per email (9 down to 4): batches find their rows by number, nothing looks up the sending service's
	// message ID, and the activity index no longer needs the time it was sent.
	"DROP INDEX IF EXISTS sends_campaign_status",
	"DROP INDEX IF EXISTS sends_message",
	"DROP INDEX IF EXISTS sends_subscriber",
	// One click polls (src/polls.ts): each reader's answer, one per poll.
	"CREATE TABLE IF NOT EXISTS poll_votes (campaign_id TEXT NOT NULL, poll TEXT NOT NULL, subscriber_id TEXT NOT NULL, answer INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (campaign_id, poll, subscriber_id))",
];
const SCHEMA_VERSION = "15";

let ready: Promise<void> | null = null;

/** Makes the tables once per Worker instance (cheap: one read when they're already there). */
export function ensureSchema(db: D1Database): Promise<void> {
	ready ??= (async () => {
		const have = await db.prepare("SELECT value FROM meta WHERE key = 'schema'").first<{ value: string }>().catch(() => null);
		if (have?.value === SCHEMA_VERSION) return;
		await db.batch(SCHEMA.map((s) => db.prepare(s)));
		for (const m of MIGRATIONS) await db.prepare(m).run().catch((e) => {
			if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
		});
		// Version 1 had one switch for opens and clicks together.
		if (have?.value === "1" || (have && !have.value)) await db.prepare("UPDATE brands SET track_opens = tracking, track_clicks = tracking").run();
		await db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(SCHEMA_VERSION).run();
	})().catch((e) => {
		ready = null;
		throw e;
	});
	return ready;
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
	return (await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string | null): Promise<void> {
	if (value === null) await db.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
	else await db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** A random value written as hex. */
export const newId = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const iso = (d: Date = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export const accountById = (db: D1Database, id: string) => db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();

/** Stage 1 has one brand: the first one made. */
export const firstBrand = (db: D1Database) => db.prepare("SELECT * FROM brands ORDER BY created_at LIMIT 1").first<BrandRow>();

/** The address people reach this install on, saved the first time the owner uses it (for links in emails). */
let seen = "";
export async function origin(db: D1Database, request?: Request): Promise<string> {
	const saved = await getMeta(db, "origin");
	if (saved) return saved;
	const here = request ? new URL(request.url).origin : seen;
	if (request) seen = here;
	if (here && !/localhost|127\.0\.0\.1/.test(here)) await setMeta(db, "origin", here);
	return here;
}

/** Where every link in a brand's emails points: its own domain for links when it has one, otherwise this app's address. */
export function linkBase(brand: { track_domain?: string | null }, base: string): string {
	return brand.track_domain ? brand.track_domain.replace(/\/+$/, "") : base;
}

/** Records something that happened, for the activity list and campaign stats. */
export const logEvent = (db: D1Database, brand: string, kind: string, sub: string | null, campaign: string | null, detail: string | null = null) =>
	db.prepare("INSERT INTO events (brand_id, at, kind, subscriber_id, campaign_id, detail) VALUES (?, ?, ?, ?, ?, ?)").bind(brand, iso(), kind, sub, campaign, detail ? detail.slice(0, 300) : null);

/** SQL that's true when a subscriber (alias s) is on the brand's blocklist, by address or domain. Binds: brand id twice. */
export const BLOCKED_SQL = `(EXISTS (SELECT 1 FROM blocklist b WHERE b.brand_id = ? AND b.email = s.email) OR EXISTS (SELECT 1 FROM blocked_domains d WHERE d.brand_id = ? AND d.domain = substr(s.email, instr(s.email, '@') + 1)))`;

/** Is this address blocked? Counts the attempt when it is. */
export async function isBlocked(db: D1Database, brandId: string, email: string): Promise<boolean> {
	const domain = email.split("@")[1] ?? "";
	const now = iso();
	const [a, b] = await db.batch([
		db.prepare("UPDATE blocklist SET attempts = attempts + 1, updated_at = ? WHERE brand_id = ? AND email = ? RETURNING email").bind(now, brandId, email),
		db.prepare("UPDATE blocked_domains SET attempts = attempts + 1, updated_at = ? WHERE brand_id = ? AND domain = ? RETURNING domain").bind(now, brandId, domain),
	]);
	return a.results.length > 0 || b.results.length > 0;
}
