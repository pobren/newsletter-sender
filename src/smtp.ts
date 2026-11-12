// Sending through any SMTP server (Settings, Sending, Your own SMTP server): the owner's host, port, user name and
// password. The Worker talks SMTP itself over a Cloudflare TCP socket, on port 465 (TLS from the start) or 587 or 2525
// (STARTTLS). Cloudflare blocks port 25. One connection per email, so keep the speed modest.
//
// Bounces come back to the from address as emails, which we can't read, so the owner sees them in their own inbox.

import type { OutEmail, Sent } from "./providers.ts";

export interface SmtpConfig {
	host: string;
	port: number;
	/** "tls": TLS from the start (port 465). "starttls": plain first, then TLS before signing in. */
	security: "tls" | "starttls";
	user: string;
	password: string;
}

export interface SmtpSocket {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	startTls(): SmtpSocket;
	close(): Promise<void>;
}
export type Connect = (address: { hostname: string; port: number }, options: { secureTransport: "on" | "starttls" }) => SmtpSocket;

/** What the server said when something went wrong, and at which step. */
class SmtpError extends Error {
	code: number;
	step: string;
	constructor(code: number, step: string, text: string) {
		super(`${text.replace(/\s+/g, " ").trim().slice(0, 200)} (${step})`);
		this.code = code;
		this.step = step;
	}
}

const enc = new TextEncoder();

class Conn {
	private reader!: ReadableStreamDefaultReader<Uint8Array>;
	private writer!: WritableStreamDefaultWriter<Uint8Array>;
	private buf = "";
	private dec = new TextDecoder();
	sock!: SmtpSocket;
	constructor(sock: SmtpSocket) {
		this.attach(sock);
	}
	private attach(s: SmtpSocket) {
		this.sock = s;
		this.reader = s.readable.getReader();
		this.writer = s.writable.getWriter();
	}
	/** One whole reply, which may be several lines (250-... then 250 ...). */
	async reply(): Promise<{ code: number; text: string }> {
		for (;;) {
			const lines: string[] = [];
			let used = 0;
			for (;;) {
				const nl = this.buf.indexOf("\n", used);
				if (nl < 0) break;
				const line = this.buf.slice(used, nl).replace(/\r$/, "");
				used = nl + 1;
				lines.push(line);
				if (/^\d{3}(?: |$)/.test(line)) {
					this.buf = this.buf.slice(used);
					return { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join("\n") };
				}
			}
			const { value, done } = await this.reader.read();
			if (done) throw new SmtpError(421, "connection", "The mail server closed the connection.");
			this.buf += this.dec.decode(value, { stream: true });
		}
	}
	async write(text: string) {
		await this.writer.write(enc.encode(text));
	}
	async cmd(line: string, want: number[], step: string) {
		await this.write(`${line}\r\n`);
		const r = await this.reply();
		if (!want.includes(r.code)) throw new SmtpError(r.code, step, `${r.code} ${r.text}`);
		return r;
	}
	/** STARTTLS: the same connection, now encrypted. */
	upgrade() {
		this.reader.releaseLock();
		this.writer.releaseLock();
		this.attach(this.sock.startTls());
	}
	async close() {
		try {
			await this.sock.close();
		} catch {}
	}
}

// -- The email itself -----------------------------------------------------------------------------------------------

const b64 = (s: string) => {
	const bytes = enc.encode(s);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
};
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
/** A header value: as it is when plain ASCII, otherwise as a UTF-8 encoded word. */
export const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const nameAddr = (name: string, email: string) => {
	const n = oneLine(name).replace(/["\\]/g, "");
	return n ? `${/^[\x20-\x7e]*$/.test(n) ? `"${n}"` : word(n)} <${email}>` : `<${email}>`;
};

/** The whole message, ready for DATA: a plain text and an HTML part. */
export function buildMessage(fromName: string, fromEmail: string, m: OutEmail, now = new Date(), id = crypto.randomUUID()): string {
	const boundary = `ns-${id.replace(/-/g, "")}`;
	const domain = fromEmail.split("@")[1] || "localhost";
	const head: [string, string][] = [
		["From", nameAddr(fromName, fromEmail)],
		["To", `<${m.to}>`],
		["Subject", word(oneLine(m.subject))],
		["Date", now.toUTCString().replace("GMT", "+0000")],
		["Message-ID", `<${id}@${domain}>`],
		["MIME-Version", "1.0"],
	];
	if (m.replyTo) head.push(["Reply-To", `<${oneLine(m.replyTo)}>`]);
	for (const [k, v] of Object.entries(m.headers)) if (/^[A-Za-z0-9-]{1,60}$/.test(k)) head.push([k, oneLine(v)]);
	head.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);
	const part = (type: string, body: string) => `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap(b64(body))}`;
	return `${head.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${part("text/plain", m.text)}${part("text/html", m.html)}--${boundary}--\r\n`;
}

// -- Sending ----------------------------------------------------------------------------------------------------------

/** Sends one email over SMTP and says how it went. Never throws. */
export async function smtpSend(cfg: SmtpConfig, fromName: string, fromEmail: string, m: OutEmail, connect: Connect, timeoutMs = 30_000): Promise<Sent> {
	let conn: Conn | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const work = (async (): Promise<Sent> => {
		conn = new Conn(connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: cfg.security === "tls" ? "on" : "starttls" }));
		const c = conn;
		const greet = await c.reply();
		if (greet.code !== 220) throw new SmtpError(greet.code, "greeting", `${greet.code} ${greet.text}`);
		const helo = fromEmail.split("@")[1] || "localhost";
		let ehlo = await c.cmd(`EHLO ${helo}`, [250], "hello");
		if (cfg.security === "starttls") {
			if (!/^STARTTLS\b/im.test(ehlo.text)) throw new SmtpError(0, "STARTTLS", "This server doesn't offer STARTTLS on this port, so we won't send your password over it. Try port 465.");
			await c.cmd("STARTTLS", [220], "STARTTLS");
			c.upgrade();
			ehlo = await c.cmd(`EHLO ${helo}`, [250], "hello");
		}
		if (cfg.user) {
			const auth = /^AUTH[ =](.*)$/im.exec(ehlo.text)?.[1].toUpperCase().split(/\s+/) ?? [];
			if (auth.includes("PLAIN") || !auth.includes("LOGIN")) await c.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password}`)}`, [235], "sign in");
			else {
				await c.cmd("AUTH LOGIN", [334], "sign in");
				await c.cmd(b64(cfg.user), [334], "sign in");
				await c.cmd(b64(cfg.password), [235], "sign in");
			}
		}
		await c.cmd(`MAIL FROM:<${fromEmail}>`, [250], "from address");
		await c.cmd(`RCPT TO:<${m.to}>`, [250, 251], "recipient");
		await c.cmd("DATA", [354], "message");
		// Dot stuffing: a line that starts with a dot gets one more.
		const data = buildMessage(fromName, fromEmail, m).replace(/(^|\r\n)\./g, "$1..");
		await c.write(`${data}.\r\n`);
		const done = await c.reply();
		if (done.code !== 250) throw new SmtpError(done.code, "message", `${done.code} ${done.text}`);
		const id = /\b(?:queued as|id=?)\s*([\w.@<>-]{4,80})/i.exec(done.text)?.[1];
		await c.write("QUIT\r\n").catch(() => {});
		return { ok: true, ...(id ? { id } : {}) };
	})();
	const timeout = new Promise<Sent>((_, reject) => {
		timer = setTimeout(() => reject(new SmtpError(0, "timeout", `The mail server didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} catch (e) {
		return smtpFailure(e);
	} finally {
		if (timer) clearTimeout(timer);
		await (conn as Conn | null)?.close();
	}
}

/** Sorts an SMTP failure the same way as the other services: slow down, this address won't work, or something else. */
export function smtpFailure(e: unknown): Sent {
	if (!(e instanceof SmtpError)) return { ok: false, throttled: true, error: `Couldn't reach the mail server: ${(e as Error)?.message ?? e}` };
	const error = e.message;
	// 4xx: try again later. A dropped connection or a timeout too.
	if ((e.code >= 400 && e.code < 500) || e.step === "connection" || e.step === "timeout") return { ok: false, throttled: true, error };
	// 5xx on the recipient (550 no such user, 553 bad address): this address won't work. 552 is a full mailbox.
	if (e.step === "recipient" && e.code >= 500 && e.code !== 552) return { ok: false, permanent: true, error };
	return { ok: false, error };
}
