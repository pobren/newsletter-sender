// The pop up sign up form for any website: one script tag, set up with data- attributes (the list page's Pop up form
// builder writes the tag). Everything it shows is set with textContent, inside its own shadow root, so the site's
// styles and the pop up's never mix. It remembers in the visitor's browser when it was last closed, and never shows
// again after they sign up.

import type { BrandRow, ListRow } from "./db.ts";
import { listFields } from "./public.ts";

export interface PopupSettings {
	endpoint: string;
	listName: string;
	colour: string;
	siteKey: string | null;
	fields: { key: string; label: string; required?: boolean }[];
	key: string;
}

export function popupSettings(l: ListRow, b: BrandRow, base: string, siteKey: string | null): PopupSettings {
	return { endpoint: `${base}/s/${l.slug}`, listName: l.name, colour: /^#[0-9a-f]{6}$/i.test(b.colour) ? b.colour : "#a3195b", siteKey, fields: listFields(l), key: `ns_popup_${l.slug}` };
}

/** The script itself. Settings go in as JSON, so nothing from the list can break out of it. */
export function popupScript(s: PopupSettings): string {
	return `(() => {
const S = ${JSON.stringify(s).replace(/</g, "\\u003c")};
const tag = document.currentScript, d = (k, v) => (tag && tag.dataset[k]) || v;
const title = d("title", "Join " + S.listName), text = d("text", "Get new posts straight to your inbox."), button = d("button", "Subscribe");
const when = d("when", "time:10"), every = Number(d("every", "7"));
const store = { get() { try { return JSON.parse(localStorage.getItem(S.key) || "{}"); } catch { return {}; } }, set(v) { try { localStorage.setItem(S.key, JSON.stringify(v)); } catch {} } };
const seen = store.get();
if (seen.joined || (every > 0 && seen.closed && Date.now() - seen.closed < every * 86400000)) return;
let shown = false;
function show() {
	if (shown) return; shown = true;
	const host = document.createElement("div"); host.style.cssText = "position:fixed;inset:0;z-index:2147483000";
	const root = host.attachShadow({ mode: "open" });
	root.innerHTML = '<style>:host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}.bg{position:fixed;inset:0;background:rgba(20,10,20,.55);display:flex;align-items:center;justify-content:center;padding:16px;animation:f .2s}@keyframes f{from{opacity:0}}.box{position:relative;width:100%;max-width:420px;background:#fff;color:#1d1424;border-radius:18px;padding:28px 24px 22px;box-shadow:0 20px 60px rgba(0,0,0,.25);border-top:6px solid var(--c)}h2{margin:0 0 8px;font-size:24px;line-height:1.2}p{margin:0 0 14px;color:#4a3b52;font-size:16px;line-height:1.5}label{display:block;font-weight:600;font-size:14px;margin:10px 0 4px}input{width:100%;min-height:46px;padding:0 12px;border:2px solid #e6cfdb;border-radius:10px;font-size:16px;color:#1d1424;background:#fff}input:focus{outline:3px solid #fbe6f0;border-color:var(--c)}.go{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:16px;min-height:48px;border:0;border-radius:10px;background:var(--c);color:#fff;font-size:17px;font-weight:600;cursor:pointer}.go svg,.x svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.go:disabled{opacity:.6}.x{position:absolute;top:10px;right:10px;width:40px;height:40px;border:0;border-radius:50%;background:#f5eef2;color:#4a3b52;display:flex;align-items:center;justify-content:center;cursor:pointer}.err{color:#a1122e;font-size:14px;margin:10px 0 0}.small{font-size:13px;color:#6b5a73;margin:12px 0 0}.hp{position:absolute;left:-9999px}</style>'
		+ '<div class="bg"><div class="box" role="dialog" aria-modal="true" aria-labelledby="t"><button class="x" type="button" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button><h2 id="t"></h2><p class="lead"></p><form novalidate><label for="e">Your email address</label><input id="e" type="email" name="email" required autocomplete="email"><label for="n">Your name (optional)</label><input id="n" name="name" autocomplete="name"><div class="more"></div><div class="hp" aria-hidden="true"><input name="hp" tabindex="-1" autocomplete="off"></div><div class="ts"></div><button class="go" type="submit"><svg viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg><span></span></button><p class="err" role="alert"></p></form><p class="small">You can unsubscribe at any time.</p></div></div>';
	const $ = (q) => root.querySelector(q);
	$(".box").style.setProperty("--c", S.colour);
	$("#t").textContent = title; $(".lead").textContent = text; $(".go span").textContent = button;
	for (const f of S.fields) { const l = document.createElement("label"), i = document.createElement("input"); l.textContent = f.label; l.htmlFor = i.id = "f_" + f.key; i.name = f.key; i.required = !!f.required; $(".more").append(l, i); }
	let token = "";
	if (S.siteKey) { const go = () => window.turnstile.render($(".ts"), { sitekey: S.siteKey, callback: (t) => (token = t) }); if (window.turnstile) go(); else { const sc = document.createElement("script"); sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; sc.onload = go; document.head.append(sc); } }
	const close = () => { store.set({ ...store.get(), closed: Date.now() }); host.remove(); document.removeEventListener("keydown", esc); };
	const esc = (e) => { if (e.key === "Escape") close(); };
	document.addEventListener("keydown", esc);
	$(".x").onclick = close;
	$(".bg").onclick = (e) => { if (e.target === $(".bg")) close(); };
	$("form").onsubmit = async (e) => {
		e.preventDefault();
		const form = Object.fromEntries(new FormData(e.target)); form.ts = token; form.via = "popup";
		if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(form.email || "")) { $(".err").textContent = "Please enter your email address."; return; }
		$(".go").disabled = true; $(".err").textContent = "";
		try {
			const r = await fetch(S.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(form) });
			const j = await r.json().catch(() => ({}));
			if (!r.ok || j.error) throw new Error(j.error || "That didn't work. Please try again.");
			store.set({ joined: Date.now() });
			$(".box").querySelector("form").remove(); $(".small").remove();
			$("#t").textContent = j.confirm ? "Nearly there" : "You're on the list";
			$(".lead").textContent = j.confirm ? "Please check your inbox and press the button in the email we've just sent." : "Thanks for signing up to " + S.listName + ".";
		} catch (err) { $(".err").textContent = err.message; $(".go").disabled = false; if (S.siteKey && window.turnstile) window.turnstile.reset($(".ts")); }
	};
	document.body.append(host);
	setTimeout(() => $("#e").focus(), 50);
}
const [kind, n] = when.split(":");
if (kind === "scroll") { const on = () => { if ((scrollY + innerHeight) / document.documentElement.scrollHeight * 100 >= Number(n || 50)) { removeEventListener("scroll", on); show(); } }; addEventListener("scroll", on, { passive: true }); }
else if (kind === "exit") {
	if (matchMedia("(hover: none)").matches) setTimeout(show, 20000); // phones have no "leaving": after 20 seconds instead
	else document.addEventListener("mouseout", (e) => { if (!e.relatedTarget && e.clientY <= 0) show(); });
}
else setTimeout(show, Math.max(0, Number(n || 10)) * 1000);
})();
`;
}

/** A page to try the pop up on, with the builder's settings, shown straight away and every time. */
export function popupTestPage(scriptUrl: string, q: URLSearchParams): string {
	const a = (k: string) => (q.get(k) ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).slice(0, 300);
	return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pop up form test</title>
<style>body{margin:0;font:17px/1.6 Georgia,serif;color:#333;background:#fafafa}main{max-width:680px;margin:0 auto;padding:40px 20px}.l{height:14px;background:#e8e8e8;border-radius:7px;margin:12px 0}.l.s{width:60%}h1{font:700 32px system-ui,sans-serif;color:#222}.note{font:15px system-ui,sans-serif;background:#fff3c4;border-radius:10px;padding:10px 14px}</style></head>
<body><main><p class="note">This is a pretend page to try your pop up on. Close it and reload to see it again. Signing up here is real.</p><h1>A page on your website</h1>${'<div class="l"></div><div class="l"></div><div class="l s"></div><br>'.repeat(8)}</main>
<script src="${scriptUrl}" data-title="${a("title")}" data-text="${a("text")}" data-button="${a("button")}" data-when="time:1" data-every="0" async></script></body></html>`;
}
