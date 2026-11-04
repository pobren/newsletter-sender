import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEmail, csvCell, parseCsv, readImport } from "../src/csv.ts";

test("reads commas, semicolons, quotes and new lines in cells", () => {
	assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [["a", "b"], ["x, y", 'say "hi"']]);
	assert.deepEqual(parseCsv("a;b\r\n1;2"), [["a", "b"], ["1", "2"]]);
	assert.deepEqual(parseCsv('a,b\n"line\none",2'), [["a", "b"], ["line\none", "2"]]);
});

test("a Mailchimp export: names joined, extra columns kept, repeats skipped", () => {
	const rows = parseCsv("Email Address,First Name,Last Name,Company,MEMBER_RATING,TAGS\njo@example.com,Jo,Bloggs,Acme,2,\"vip,early\"\nJO@example.com,Jo,,,,\nnot-an-email,,,,,\n");
	const r = readImport(rows);
	assert.equal(r.rows.length, 1);
	assert.equal(r.skipped, 2);
	assert.deepEqual(r.rows[0], { email: "jo@example.com", name: "Jo Bloggs", fields: { company: "Acme" }, tags: ["vip", "early"] });
	assert.deepEqual(r.columns, ["company"]);
});

test("a plain list of addresses with no header", () => {
	const r = readImport(parseCsv("a@example.com\nb@example.com\n"));
	assert.deepEqual(r.rows.map((x) => x.email), ["a@example.com", "b@example.com"]);
});

test("emails are tidied and checked", () => {
	assert.equal(cleanEmail("  Jo@Example.COM "), "jo@example.com");
	assert.equal(cleanEmail("nope"), null);
});

test("exported cells can't run as spreadsheet formulas", () => {
	assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
	assert.equal(csvCell('a "b"'), '"a ""b"""');
});
