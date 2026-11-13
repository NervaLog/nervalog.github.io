// Tests of site_check.mjs: `node --test .github/scripts/site_check.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFiles, checkPage, checkRelease } from "./site_check.mjs";

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
  has(checkPage(sub(PAGE, "d:\"Second.\"", "d:\"It \\\"is\\\".\"")), "printable ASCII"));

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

const ok = ["index.html"];
const withEntry = (d) => sub(REL, ENTRY, `  {v:"0.7.1", date:"2026-11-13", d:"${d}"},\n`);

test("a release refuses extra code on a SITE line", () => {
  has(checkRelease(PAGE, sub(REL, 'version: "0.7.1",', 'version: "0.7.1", repo: "https://evil.example",'), ok), "SITE.version line must be exactly");
  has(checkRelease(PAGE, sub(REL, 'updated: "2026-11-13",', 'updated: "2026-11-13", x: typeof location<"u" && location.replace("https://evil.example"),'), ok), "SITE.updated line must be exactly");
  has(checkRelease(PAGE, sub(REL, 'released: "2026-11-13",', 'released: "13 Nov",'), ok), "SITE.released line must be exactly");
});

test("a release refuses a SITE line of another shape", () =>
  has(checkRelease(PAGE, sub(REL, 'version: "0.7.1",', 'version:"0.7.1",'), ok), "SITE.version not found"));

test("a release refuses an entry that disagrees with SITE", () => {
  has(checkRelease(PAGE, sub(REL, 'released: "2026-11-13"', 'released: "2026-11-12"'), ok), "must equal SITE.released");
  has(checkRelease(PAGE, sub(REL, 'version: "0.7.1"', 'version: "0.7.2"'), ok), "must equal SITE.version");
});

test("a release refuses a version other than its branch's", () => {
  assert.deepEqual(checkRelease(PAGE, REL, ok, "0.7.1"), []);
  has(checkRelease(PAGE, REL, ok, "0.9.0"), "version of the branch");
});

test("a release refuses an entry of another shape", () => {
  for (const bad of ['  {v: "0.7.1", date:"2026-11-13", d:"Third."},', '  {v:"0.7.1", date:"2026-11-13", d:"Third."}',
    '{v:"0.7.1", date:"2026-11-13", d:"Third."},', '  {v:"0.7.1", date:"2026-11-13", d:"Third."}, x:1,',
    '  {v:"0.7.1", date:"2026-11-13", d:""},'])
    has(checkRelease(PAGE, sub(REL, ENTRY.trimEnd(), bad), ok), "must be exactly the new entry");
});

test("a release refuses a sentence that can end or reshape the script", () => {
  for (const d of ["x</SCRIPT><img src=x onerror=alert(1)>", "x</script ><img>", "x <!--<script> y", "x</script>y",
    "a & b", "a `b`", "a\\\\b", "caf\u00e9", "tab\there", "x".repeat(301)])
    has(checkRelease(PAGE, withEntry(d), ok), "must be exactly the new entry");
  assert.deepEqual(checkRelease(PAGE, withEntry("x".repeat(300)), ok), []);
});

test("a page's RELEASES refuse markup in a sentence", () =>
  has(checkPage(sub(PAGE, 'd:"First."', 'd:"</SCRIPT>x"')), "printable ASCII"));

test("prerelease identifiers compare numerically", () => {
  const rc = (top, below) => sub(sub(sub(PAGE, 'version: "0.7.0"', `version: "${top}"`),
    "const RELEASES = [\n", `const RELEASES = [\n  {v:"${top}", date:"2026-11-10", d:"b"},\n  {v:"${below}", date:"2026-11-10", d:"a"},\n`), "{v:\"0.7.0\"", "{v:\"0.7.0\"");
  assert.deepEqual(checkPage(rc("0.7.1-rc.10", "0.7.1-rc.9")), []);
  has(checkPage(rc("0.7.1-rc.9", "0.7.1-rc.10")), "newest first");
});

function siteDir(skip, link) {
  const d = mkdtempSync(join(tmpdir(), "site-"));
  for (const f of ["index.html", "404.html", "_headers"]) {
    if (f === skip) continue;
    if (f === link) symlinkSync(join(d, "nowhere"), join(d, f));
    else writeFileSync(join(d, f), "x\n");
  }
  return d;
}

test("the site needs index.html, 404.html and _headers as regular files", () => {
  const ok = siteDir();
  assert.deepEqual(checkFiles(ok), []);
  rmSync(ok, { recursive: true });
  for (const f of ["index.html", "404.html", "_headers"]) {
    for (const d of [siteDir(f, undefined), siteDir(undefined, f)]) {
      const errs = checkFiles(d);
      assert.equal(errs.length, 1);
      assert.match(errs[0], new RegExp(`NRV-E1152.*${f}`));
      rmSync(d, { recursive: true });
    }
  }
});

test("a directory is not a regular file", () => {
  const d = siteDir();
  rmSync(join(d, "_headers"));
  symlinkSync(".", join(d, "_headers"));
  assert.equal(checkFiles(d).length, 1);
  rmSync(d, { recursive: true });
});
