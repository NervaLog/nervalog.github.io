// Tests of site_check.mjs: `node --test .github/scripts/site_check.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { checkPage, checkRelease } from "./site_check.mjs";

const PAGE = `<!doctype html><html><body><p>hi</p>
<script>
const SITE = {
  updated: "2026-11-10",
  repo: "https://example.test/r",
  version: "0.7.0",
  released: "2026-11-10",
  stage: "Research",
  stageStatus: "wip",
};
const GOALS = [
  {id:"G1", name:"One", status:"done", goal:"A goal."},
];
const NEXT = [
  {ref:"v0.7.1", t:"Alpha", status:"wip", d:"Soon."},
];
const PRODUCTION = [
  {id:"R1", name:"Proven", status:"wip", goal:"Jepsen."},
];
const RELEASES = [
  {v:"0.7.0", date:"2026-11-10", d:"Second."},
  {v:"0.6.1", date:"2026-10-21", d:"First."},
];
const DOCS = [
  {t:"README", path:"README.md", d:"Design."},
];
// ===== Rendering =====
const $ = s => document.querySelector(s);
</script></body></html>`;

const sub = (s, a, b) => {
  assert.ok(s.includes(a), `fixture lacks ${a}`);
  return s.replace(a, b);
};
const has = (errs, text) => assert.ok(errs.some((e) => e.includes(text)), `${text} not in ${JSON.stringify(errs)}`);

test("a good page passes", () => assert.deepEqual(checkPage(PAGE), []));

test("refuses a page with no script, or two", () => {
  has(checkPage("<p>x</p>"), "exactly one inline <script>");
  has(checkPage(PAGE + "<script>1</script>"), "exactly one inline <script>");
});

test("refuses a script that does not parse", () =>
  has(checkPage(sub(PAGE, "const $ = s", "const $ = (")), "does not parse"));

test("refuses data that does not evaluate", () =>
  has(checkPage(sub(PAGE, "const NEXT = [", "const NEXT = nope + [")), "does not evaluate"));

test("refuses a missing rendering marker", () =>
  has(checkPage(sub(PAGE, "// ===== Rendering =====", "")), "not found"));

test("refuses a bad status, a bad date and a repeated id", () => {
  has(checkPage(sub(PAGE, 'status:"done"', 'status:"finished"')), "GOALS[0].status");
  has(checkPage(sub(PAGE, 'updated: "2026-11-10"', 'updated: "10 Nov"')), "SITE.updated");
  has(checkPage(sub(PAGE, '{id:"R1", name:"Proven"', '{id:"R1", name:"P", status:"wip", goal:"g"},\n  {id:"R1", name:"Proven"')),
    'id "R1" is repeated');
});

test("refuses releases out of order", () => {
  const swapped = sub(sub(PAGE, '{v:"0.7.0", date:"2026-11-10", d:"Second."}', "@"),
    '{v:"0.6.1", date:"2026-10-21", d:"First."}', '{v:"0.7.0", date:"2026-11-10", d:"Second."}')
    .replace("@", '{v:"0.6.1", date:"2026-10-21", d:"First."}');
  has(checkPage(swapped), "newest first");
});

test("refuses SITE.version that is not the newest release", () =>
  has(checkPage(sub(PAGE, 'version: "0.7.0"', 'version: "0.6.1"')), "must equal RELEASES[0].v"));

test("refuses a release description with a quote", () =>
  has(checkPage(sub(PAGE, "d:\"Second.\"", "d:\"It \\\"is\\\".\"")), "quote or a backslash"));

test("a prerelease sorts before its release", () => {
  const page = sub(sub(PAGE, 'version: "0.7.0"', 'version: "0.7.1-rc.1"'),
    "const RELEASES = [\n", 'const RELEASES = [\n  {v:"0.7.1-rc.1", date:"2026-11-10", d:"Rc."},\n');
  assert.deepEqual(checkPage(page), []);
});

const ENTRY = '  {v:"0.7.1", date:"2026-11-13", d:"Third."},\n';
const release = (page) => {
  let p = sub(page, "const RELEASES = [\n", "const RELEASES = [\n" + ENTRY);
  p = sub(p, 'version: "0.7.0"', 'version: "0.7.1"');
  p = sub(p, 'released: "2026-11-10"', 'released: "2026-11-13"');
  return sub(p, 'updated: "2026-11-10"', 'updated: "2026-11-13"');
};
const REL = release(PAGE);

test("a good release passes", () => {
  assert.deepEqual(checkPage(REL), []);
  assert.deepEqual(checkRelease(PAGE, REL, ["index.html"]), []);
});

test("a release refuses another changed file", () =>
  has(checkRelease(PAGE, REL, ["index.html", "README.md"]), "only index.html"));

test("a release refuses a changed status or prose line", () => {
  has(checkRelease(PAGE, sub(REL, 'status:"wip", d:"Soon."', 'status:"done", d:"Soon."'), ["index.html"]), "other lines differ");
  has(checkRelease(PAGE, sub(REL, 'stage: "Research"', 'stage: "Beta"'), ["index.html"]), "other lines differ");
});

test("a release refuses a second entry, or a changed old one", () => {
  const two = sub(REL, ENTRY, ENTRY + '  {v:"0.7.2", date:"2026-11-13", d:"X."},\n');
  has(checkRelease(PAGE, two, ["index.html"]), "more line(s)");
  has(checkRelease(PAGE, sub(REL, 'd:"First."', 'd:"Changed."'), ["index.html"]), "other lines differ");
});

test("a release refuses an entry that is not first", () => {
  const moved = sub(sub(REL, ENTRY, ""), '  {v:"0.6.1"', ENTRY + '  {v:"0.6.1"');
  has(checkRelease(PAGE, moved, ["index.html"]), "other lines differ");
});

test("a release refuses a change outside the script", () =>
  has(checkRelease(PAGE, sub(REL, "<p>hi</p>", "<p>bye</p>"), ["index.html"]), "other lines differ"));
