// Sending through the owner's own SMTP server, against a pretend server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage, smtpSend, word, type Connect, type SmtpSocket } from "../src/smtp.ts";
import { parseProvider, providerSummary, sendOne } from "../src/providers.ts";

const mail = { to: "jo@example.com", subject: "Hello, café", text: "Hi Jo\n.hidden dot line", html: "<p>Hi Jo</p>", headers: { "List-Unsubscribe": "<https://n.example/u/x>" }, replyTo: "help@e.com" };

/** A pretend SMTP server: answers each command with the next reply, or by a rule. */
function server(rules: (line: string) => string, opts: { ehlo?: string; greet?: string } = {}) {
	const said: string[] = [];
	let tls = false;
	let started: "on" | "starttls" | null = null;
	const make = (): SmtpSocket => {
		let push!: (s: string) => void;
		let inData = false;
		let data = "";
		const readable = new ReadableStream<Uint8Array>({
			start(c) {
				push = (s) => c.enqueue(new TextEncoder().encode(s));
			},
		});
		const writable = new WritableStream<Uint8Array>({
			write(chunk) {
				const text = new TextDecoder().decode(chunk);
				if (inData) {
					data += text;
					if (data.endsWith("\r\n.\r\n")) {
						said.push(`DATA:${data}`);
						inData = false;
						push("250 2.0.0 Ok: queued as ABC123\r\n");
					}
					return;
				}
				for (const line of text.split("\r\n").filter(Boolean)) {
					said.push(line);
					if (line.startsWith("EHLO")) push(opts.ehlo ?? `250-mail.example\r\n250-AUTH LOGIN PLAIN\r\n${tls ? "" : "250-STARTTLS\r\n"}250 SIZE 1000000\r\n`);
					else if (line === "STARTTLS") push("220 go ahead\r\n");
					else if (line === "DATA") {
						inData = true;
						push("354 send it\r\n");
					} else push(rules(line));
				}
			},
		});
		return {
			readable,
			writable,
			startTls() {
				tls = true;
				return make();
			},
			async close() {},
		};
	};
	const connect: Connect = (_addr, o) => {
		started = o.secureTransport;
		return make();
	};
	// The first socket says hello before anything else.
	const connectWithGreeting: Connect = (addr, o) => {
		const s = connect(addr, o);
		const w = s.writable;
		const reader = s.readable;
		const greet = new TextEncoder().encode(opts.greet ?? "220 mail.example ESMTP\r\n");
		const r = new ReadableStream<Uint8Array>({
			async start(c) {
				c.enqueue(greet);
				const rd = reader.getReader();
				for (;;) {
					const { value, done } = await rd.read();
					if (done) break;
					c.enqueue(value);
				}
				c.close();
			},
		});
		return { readable: r, writable: w, startTls: s.startTls, close: s.close };
	};
	return { connect: connectWithGreeting, said, started: () => started, tls: () => tls };
}

const cfg = { host: "smtp.example.com", port: 587, security: "starttls" as const, user: "jo@e.com", password: "pa ss" };
const ok = (line: string) => (line.startsWith("AUTH") ? "235 ok\r\n" : line.startsWith("QUIT") ? "221 bye\r\n" : "250 ok\r\n");

test("SMTP: STARTTLS, signs in, sends, with dots doubled", async () => {
	const s = server(ok);
	const r = await smtpSend(cfg, "Jo", "news@e.com", mail, s.connect);
	assert.deepEqual(r, { ok: true, id: "ABC123" });
	assert.equal(s.started(), "starttls");
	assert.equal(s.tls(), true);
	assert.ok(s.said.includes(`AUTH PLAIN ${btoa("\0jo@e.com\0pa ss")}`));
	assert.ok(s.said.includes("MAIL FROM:<news@e.com>"));
	assert.ok(s.said.includes("RCPT TO:<jo@example.com>"));
	const data = s.said.find((x) => x.startsWith("DATA:"))!;
	assert.match(data, /^DATA:From: "Jo" <news@e\.com>\r\n/);
	assert.match(data, /Subject: =\?UTF-8\?B\?/);
	assert.match(data, /List-Unsubscribe: <https:\/\/n\.example\/u\/x>/);
	assert.match(data, /\r\n\.\r\n$/);
});

test("SMTP: no STARTTLS offered means no password sent", async () => {
	const s = server(ok, { ehlo: "250-mail.example\r\n250 AUTH PLAIN\r\n" });
	const r = await smtpSend(cfg, "Jo", "news@e.com", mail, s.connect);
	assert.equal(r.ok, false);
	assert.match(r.error!, /STARTTLS/);
	assert.ok(!s.said.some((x) => x.startsWith("AUTH")));
});

test("SMTP: a refused address is permanent, a busy server is a retry, a wrong password is neither", async () => {
	let s = server((l) => (l.startsWith("RCPT") ? "550 5.1.1 No such user\r\n" : ok(l)));
	assert.equal((await smtpSend(cfg, "Jo", "news@e.com", mail, s.connect)).permanent, true);
	s = server((l) => (l.startsWith("MAIL") ? "421 4.7.0 Try again later\r\n" : ok(l)));
	assert.equal((await smtpSend(cfg, "Jo", "news@e.com", mail, s.connect)).throttled, true);
	s = server((l) => (l.startsWith("AUTH") ? "535 5.7.8 Authentication failed\r\n" : ok(l)));
	const r = await smtpSend(cfg, "Jo", "news@e.com", mail, s.connect);
	assert.equal(r.ok, false);
	assert.equal(r.permanent, undefined);
	assert.equal(r.throttled, undefined);
	assert.match(r.error!, /Authentication failed \(sign in\)/);
});

test("SMTP: port 465 uses TLS from the start, and sendOne goes through it", async () => {
	const s = server(ok);
	const c = parseProvider({ provider: "smtp", smtpHost: "SMTP.Example.com", smtpPort: "465", smtpUser: "jo@e.com", key: "pw" }, "news@e.com");
	assert.deepEqual(c, { provider: "smtp", key: "pw", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecurity: "tls", smtpUser: "jo@e.com" });
	assert.deepEqual(await sendOne(c as any, "Jo", "news@e.com", mail, fetch, s.connect), { ok: true, id: "ABC123" });
	assert.equal(s.started(), "on");
	assert.ok(!s.said.includes("STARTTLS"));
	assert.equal(providerSummary(c as any)!.keyEnd, "");
});

test("SMTP set up: port 25 and missing details are turned down", () => {
	assert.match((parseProvider({ provider: "smtp", smtpHost: "smtp.e.com", smtpPort: 25, key: "x" }, "a@b.com") as any).error, /port 25/);
	assert.match((parseProvider({ provider: "smtp", smtpHost: "not a host", key: "x" }, "a@b.com") as any).error, /server's name/);
	assert.match((parseProvider({ provider: "smtp", smtpHost: "smtp.e.com", smtpUser: "jo", key: "" }, "a@b.com") as any).error, /password/);
});

test("SMTP message: encoded words only when needed, and both parts in base64", () => {
	assert.equal(word("Plain"), "Plain");
	assert.equal(word("Café"), `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode("Café")))}?=`);
	const m = buildMessage("Zoë", "n@e.com", { ...mail, subject: "Hi\r\nBcc: evil@x.com" }, new Date("2026-11-12T10:00:00Z"), "1234");
	assert.match(m, /^From: =\?UTF-8\?B\?[^?]+\?= <n@e\.com>\r\n/);
	assert.match(m, /Subject: Hi Bcc: evil@x\.com\r\n/);
	assert.match(m, /Date: Thu, 12 Nov 2026 10:00:00 \+0000/);
	assert.equal((m.match(/Content-Transfer-Encoding: base64/g) ?? []).length, 2);
	assert.match(m, /--ns-1234--\r\n$/);
});
