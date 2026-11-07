// Writes dist/release.json for a release: the version, its notes from CHANGELOG.md, the Cloudflare settings the
// Worker needs and a SHA-256 of every built file. Installs read it to update themselves (src/update.ts).
// Run after `wrangler deploy --dry-run --outdir dist`: node scripts/release.mjs
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const conf = readFileSync("wrangler.jsonc", "utf8");
const date = /"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(conf)?.[1];
if (!date) throw new Error("No compatibility_date in wrangler.jsonc");
const flags = /"compatibility_flags"\s*:\s*\[([^\]]*)\]/.exec(conf)?.[1].match(/"([^"]+)"/g)?.map((f) => f.slice(1, -1)) ?? [];

// The notes are the bullet points under "## <version>" in CHANGELOG.md.
const log = readFileSync("CHANGELOG.md", "utf8");
const at = log.indexOf(`## ${pkg.version}`);
if (at < 0) throw new Error(`CHANGELOG.md has no "## ${pkg.version}" section`);
const section = log.slice(at).split(/\n## /)[0];
const notes = section.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
writeFileSync("dist/notes.md", notes.map((n) => `- ${n}`).join("\n") + "\n");

const type = (f) => (f.endsWith(".js") || f.endsWith(".mjs") ? "application/javascript+module" : f.endsWith(".wasm") ? "application/wasm" : "text/plain");
const files = readdirSync("dist")
	.filter((f) => !f.endsWith(".map") && !["README.md", "release.json", "notes.md"].includes(f))
	.map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(`dist/${name}`)).digest("hex"), type: type(name) }));
if (!files.some((f) => f.name === "index.js")) throw new Error("dist/index.js is missing");

const release = { version: pkg.version, date: new Date().toISOString().slice(0, 10), notes, compatibility_date: date, compatibility_flags: flags, main_module: "index.js", files };
writeFileSync("dist/release.json", JSON.stringify(release, null, "\t") + "\n");
console.log(files.map((f) => f.name).join(" "));
