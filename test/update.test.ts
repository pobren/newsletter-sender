import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRelease, newer } from "../src/update.ts";

const ok = { version: "1.2.0", date: "2026-11-07", notes: ["A"], compatibility_date: "2026-01-15", main_module: "index.js", files: [{ name: "index.js", sha256: "a".repeat(64), type: "application/javascript+module" }] };

test("newer compares versions by number", () => {
	assert.equal(newer("1.2.10", "1.2.9"), true);
	assert.equal(newer("1.2.9", "1.2.10"), false);
	assert.equal(newer("2.0.0", "1.9.9"), true);
	assert.equal(newer("1.0.0", "1.0.0"), false);
	assert.equal(newer("1.0.0-beta", "0.1.0"), false);
});

test("checkRelease takes a good release", () => {
	assert.equal(checkRelease(ok)?.version, "1.2.0");
});

test("checkRelease turns away anything unexpected", () => {
	assert.equal(checkRelease(null), null);
	assert.equal(checkRelease({ ...ok, version: "1.2" }), null);
	assert.equal(checkRelease({ ...ok, main_module: "other.js" }), null);
	assert.equal(checkRelease({ ...ok, files: [{ ...ok.files[0], sha256: "xyz" }] }), null);
	assert.equal(checkRelease({ ...ok, files: [{ ...ok.files[0], name: "../index.js" }] }), null);
	assert.equal(checkRelease({ ...ok, files: [{ ...ok.files[0], type: "text/html" }] }), null);
	assert.equal(checkRelease({ ...ok, files: Array(11).fill(ok.files[0]) }), null);
});
