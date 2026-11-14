// Tests of site_check.mjs: `node --test .github/scripts/site_check.test.mjs`
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkFiles, checkPage, checkRelease, checkTree, checkWkd, dearmor, findReference, readReference, WKD_KEY, WKD_POLICY } from "./site_check.mjs";

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

const FILES = ["index.html", "404.html", "_headers"];
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "site_check.mjs");

// A site directory, removed when the test ends, even when it fails. `how` says what to make of
// each name in `names`: omitted (missing), "dangling" or "link" (a symlink to a regular file),
// "dirlink" (a symlink to a directory), "dir" (a real directory).
function siteDir(t, how = {}) {
  const d = mkdtempSync(join(tmpdir(), "site-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, "real"), "x\n");
  for (const f of FILES) {
    const h = how[f];
    if (h === "missing") continue;
    else if (h === "dangling") symlinkSync(join(d, "nowhere"), join(d, f));
    else if (h === "link") symlinkSync("real", join(d, f));
    else if (h === "dirlink") symlinkSync(".", join(d, f));
    else if (h === "dir") mkdirSync(join(d, f));
    else writeFileSync(join(d, f), "x\n");
  }
  return d;
}

test("the site accepts three regular files", (t) => assert.deepEqual(checkFiles(siteDir(t)), []));

test("each of the three files is refused when missing, dangling, a symlink or a directory", (t) => {
  for (const f of FILES)
    for (const h of ["missing", "dangling", "link", "dirlink", "dir"]) {
      const errs = checkFiles(siteDir(t, { [f]: h }));
      assert.equal(errs.length, 1, `${f} ${h}`);
      assert.match(errs[0], new RegExp(`NRV-E1152.*${f}`), `${f} ${h}`);
    }
});

test("a symlink to a regular file is refused, even though it is one", (t) => {
  const d = siteDir(t, { "index.html": "link", "404.html": "link", _headers: "link" });
  const errs = checkFiles(d);
  assert.equal(errs.length, 3);
  for (const f of FILES) assert.ok(errs.some((e) => e.includes(f)));
});

test("a real directory is refused as not a regular file", (t) => {
  const d = siteDir(t, { _headers: "dir", "404.html": "dir" });
  assert.equal(checkFiles(d).length, 2);
});

test("the message is the build command's, byte for byte", (t) => {
  const [e] = checkFiles(siteDir(t, { _headers: "missing" }));
  assert.equal(e, "error[NRV-E1152]: site build: _headers is missing, not a regular file, or a symlink; nothing is deployed");
});

test("--files on the command line: exit 1 and the NRV-E1152 line, exit 0 when fine, exit 2 on misuse", (t) => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const bad = run("--files", siteDir(t, { "404.html": "link" }));
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "site-check: error[NRV-E1152]: site build: 404.html is missing, not a regular file, or a symlink; nothing is deployed\n");
  const good = run("--files", siteDir(t));
  assert.equal(good.status, 0);
  assert.equal(good.stdout, "site-check: ok (files)\n");
  assert.equal(run("--files").status, 2);
  assert.equal(run("--files", "a", "b").status, 2);
});

// ---- a release pull request may carry the WKD pair (NervaLog/nerva#402) ----------------------------

test("a release with index.html and exactly the two WKD files passes", () => {
  assert.deepEqual(checkRelease(PAGE, REL, ["index.html", WKD_POLICY, WKD_KEY]), []);
  assert.deepEqual(checkRelease(PAGE, REL, [WKD_KEY, "index.html", WKD_POLICY], "0.7.1"), []);
});

test("a release refuses only one of the two WKD files", () => {
  has(checkRelease(PAGE, REL, ["index.html", WKD_POLICY]), "both WKD files or neither");
  has(checkRelease(PAGE, REL, ["index.html", WKD_KEY]), "both WKD files or neither");
});

test("a release refuses any other path beside the WKD files", () => {
  has(checkRelease(PAGE, REL, ["index.html", WKD_POLICY, WKD_KEY, "README.md"]), "not README.md");
  has(checkRelease(PAGE, REL, ["index.html", WKD_POLICY, WKD_KEY, ".well-known/openpgpkey/hu/other"]), "not .well-known/openpgpkey/hu/other");
  has(checkRelease(PAGE, REL, ["index.html", WKD_POLICY, WKD_KEY, "_headers"]), "not _headers");
  has(checkRelease(PAGE, REL, ["index.html", WKD_POLICY, ".well-known/openpgpkey/hu/xxxx"]), "not .well-known/openpgpkey/hu/xxxx");
});

test("a release that carries the WKD pair still has its page checked", () =>
  has(checkRelease(PAGE, sub(REL, "<p>hi</p>", "<p>bye</p>"), ["index.html", WKD_POLICY, WKD_KEY]), "other lines differ"));

// ---- the tree: every name the build gate refuses ------------------------------------------------------

// A repository tree: the three site files, the text files, and the WKD pair unless `wkd` is false.
function tree(t, { wkd = true } = {}) {
  const d = siteDir(t);
  writeFileSync(join(d, "README.md"), "r\n");
  writeFileSync(join(d, "CLAUDE.md"), "c\n");
  mkdirSync(join(d, ".github"));
  if (wkd) {
    mkdirSync(join(d, ".well-known/openpgpkey/hu"), { recursive: true });
    writeFileSync(join(d, WKD_POLICY), "");
    writeFileSync(join(d, WKD_KEY), "key");
  }
  return d;
}
// siteDir leaves a regular file named `real` at the root, which the allow-list would refuse.
const clean = (t, opts) => { const d = tree(t, opts); rmSync(join(d, "real")); return d; };

test("a tree of the allowed names passes, with the WKD pair or without it", (t) => {
  assert.deepEqual(checkTree(clean(t)), []);
  assert.deepEqual(checkTree(clean(t, { wkd: false })), []);
});

test("a root name off the allow-list is refused, whatever it is", (t) => {
  for (const name of ["package.json", "wrangler.toml", "wrangler.jsonc", "functions", "_worker.js", "_routes.json",
    ".env", ".env.local", ".nvmrc", ".node-version", ".npmrc", ".dev.vars", ".nerva-site", "CODEOWNERS", "LICENSE.md"]) {
    const d = clean(t);
    writeFileSync(join(d, name), "x");
    const errs = checkTree(d);
    assert.equal(errs.length, 1, name);
    assert.equal(errs[0], `error[NRV-E1152]: site build: ${name} is not allowed in the site repository; nothing is deployed`);
  }
});

test("a dangling symlink at a root name off the allow-list is refused too", (t) => {
  const d = clean(t);
  symlinkSync(join(d, "nowhere"), join(d, "wrangler.toml"));
  has(checkTree(d), "wrangler.toml is not allowed");
});

test("a symlink at an allowed metadata name is refused", (t) => {
  for (const name of [".git", ".github", ".nojekyll", "README.md", "LICENSE", "CLAUDE.md"]) {
    const d = clean(t);
    rmSync(join(d, name), { recursive: true, force: true });
    symlinkSync(join(d, "nowhere"), join(d, name));
    has(checkTree(d), `${name} is a symlink`);
  }
});

test("a path under .well-known that is not the pair is refused", (t) => {
  const d = clean(t);
  writeFileSync(join(d, ".well-known/security.txt"), "x");
  writeFileSync(join(d, ".well-known/openpgpkey/hu/other"), "x");
  mkdirSync(join(d, ".well-known/openpgpkey/hu/sub"));
  const errs = checkTree(d);
  has(errs, ".well-known/security.txt is not allowed");
  has(errs, ".well-known/openpgpkey/hu/other is not allowed");
  has(errs, ".well-known/openpgpkey/hu/sub is not allowed");
});

test("a name with a newline under .well-known is refused", (t) => {
  const d = clean(t);
  writeFileSync(join(d, ".well-known/openpgpkey/hu/a\nb"), "x");
  assert.equal(checkTree(d).length, 1);
});

test("a symlink at the WKD files or their directories is refused, a dangling one included", (t) => {
  for (const path of [WKD_POLICY, WKD_KEY, ".well-known/openpgpkey/hu", ".well-known/openpgpkey", ".well-known"]) {
    const d = clean(t);
    rmSync(join(d, path), { recursive: true, force: true });
    symlinkSync(join(d, "nowhere"), join(d, path));
    has(checkTree(d), `${path} is a symlink`);
  }
});

test("a symlink to a real file at a WKD file is refused, and is not read through", (t) => {
  const d = clean(t);
  rmSync(join(d, WKD_KEY));
  symlinkSync(join(d, "404.html"), join(d, WKD_KEY));
  has(checkTree(d), `${WKD_KEY} is a symlink`);
});

test("one WKD file without the other is refused, either way round", (t) => {
  for (const gone of [WKD_POLICY, WKD_KEY]) {
    const d = clean(t);
    rmSync(join(d, gone));
    has(checkTree(d), "one WKD file is present without the other");
  }
});

test("a WKD file that is a directory is refused", (t) => {
  const d = clean(t);
  rmSync(join(d, WKD_POLICY));
  mkdirSync(join(d, WKD_POLICY));
  has(checkTree(d), "is not");
});

test(".well-known that is a file is refused", (t) => {
  const d = clean(t, { wkd: false });
  writeFileSync(join(d, ".well-known"), "x");
  has(checkTree(d), ".well-known is not a directory");
});

test("--tree on the command line", (t) => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(run("--tree", clean(t)).stdout, "site-check: ok (tree)\n");
  const d = clean(t);
  writeFileSync(join(d, "package.json"), "{}");
  const bad = run("--tree", d);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^site-check: error\[NRV-E1152\]: site build: package.json is not allowed/);
  assert.equal(run("--tree").status, 2);
});

// ---- dearmor ----------------------------------------------------------------------------------------------

function crc24(buf) {
  let crc = 0xb704ce;
  for (const b of buf) { crc ^= b << 16; for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x864cfb; } }
  return crc & 0xffffff;
}
const armor = (bin, { crc = crc24(bin), headers = "" } = {}) => {
  const b64 = bin.toString("base64").match(/.{1,64}/g).join("\n");
  const c = Buffer.from([crc >> 16, (crc >> 8) & 255, crc & 255]).toString("base64");
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${headers}\n${b64}\n=${c}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
};
const KEY_BIN = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 255));

test("dearmor returns the binary body, with or without armor headers", () => {
  assert.ok(dearmor(armor(KEY_BIN)).equals(KEY_BIN));
  assert.ok(dearmor(armor(KEY_BIN, { headers: "Comment: x\n" })).equals(KEY_BIN));
});

test("dearmor refuses a bad checksum, an empty body and text that is not a key block", () => {
  assert.throws(() => dearmor(armor(KEY_BIN, { crc: 1 })), /checksum/);
  assert.throws(() => dearmor("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n-----END PGP PUBLIC KEY BLOCK-----\n"), /empty/);
  assert.throws(() => dearmor("hello"), /not one armored/);
});

test("dearmor agrees with gpg --dearmor on Nerva's own key file, when gpg is here", (t) => {
  const key = new URL("../../../nerva/packaging/keys/nerva-release.asc", import.meta.url);
  let asc;
  try { asc = readFileSync(key, "utf8"); } catch { return t.skip("no checkout of NervaLog/nerva beside this one"); }
  const g = spawnSync("gpg", ["--dearmor"], { input: asc });
  if (g.status !== 0) return t.skip("no gpg");
  assert.ok(dearmor(asc).equals(g.stdout));
});

// ---- the reference, and the WKD file against it (NRV-E1162) -----------------------------------------

const K0 = Buffer.from("key at 0.7.1");
const K1 = Buffer.from("key at 0.7.2-rc.1 (a rotation's next key)");
const releasesUrl = "https://api.github.com/repos/NervaLog/nerva/releases?per_page=100&page=1";
const compareUrl = (tag) => `https://api.github.com/repos/NervaLog/nerva/compare/${tag}...main`;
const keyUrl = (tag) => `https://raw.githubusercontent.com/NervaLog/nerva/${tag}/packaging/keys/nerva-release.asc`;

// A fake GitHub: `releases` are {tag, at, draft?}, `onMain` the tags that are ancestors of main
// (the others are "diverged"), `keys` maps a tag to its binary key file (none: a 404).
function github({ releases, onMain, keys }) {
  const seen = [];
  const get = async (url) => {
    seen.push(url);
    if (url === releasesUrl)
      return { status: 200, body: JSON.stringify(releases.map((r) => ({ tag_name: r.tag, published_at: r.at, draft: !!r.draft }))) };
    for (const r of releases) {
      if (url === compareUrl(r.tag))
        return { status: 200, body: JSON.stringify({ status: onMain.includes(r.tag) ? "ahead" : "diverged" }) };
      if (url === keyUrl(r.tag))
        return keys[r.tag] ? { status: 200, body: armor(keys[r.tag]) } : { status: 404, body: "404: Not Found" };
    }
    return { status: 500, body: "unexpected " + url };
  };
  return { get, seen };
}
const R = [
  { tag: "v0.7.0", at: "2026-11-10T10:00:00Z" },
  { tag: "v0.7.1", at: "2026-11-13T10:00:00Z" },
];

// A site directory holding the WKD pair with `key` in it, or none.
function wkdDir(t, key) {
  const d = mkdtempSync(join(tmpdir(), "wkd-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  if (key) {
    mkdirSync(join(d, ".well-known/openpgpkey/hu"), { recursive: true });
    writeFileSync(join(d, WKD_POLICY), "");
    writeFileSync(join(d, WKD_KEY), key);
  }
  return d;
}

test("the reference is the key file at the newest published tag on main", async () => {
  const gh = github({ releases: R, onMain: ["v0.7.0", "v0.7.1"], keys: { "v0.7.1": K0 } });
  const ref = await findReference(gh.get);
  assert.equal(ref.tag, "v0.7.1");
  assert.ok(ref.key.equals(K0));
});

test("a candidate cut during a rotation is the reference, prereleases included", async (t) => {
  const releases = [...R, { tag: "v0.7.2-rc.1", at: "2026-11-20T10:00:00Z" }];
  const gh = github({ releases, onMain: releases.map((r) => r.tag), keys: { "v0.7.1": K0, "v0.7.2-rc.1": K1 } });
  const ref = await findReference(gh.get);
  assert.equal(ref.tag, "v0.7.2-rc.1");
  // An unrelated site pull request, carrying the old key file, must carry the candidate's.
  has(checkWkd(wkdDir(t, K0), ref), "differs from packaging/keys/nerva-release.asc at v0.7.2-rc.1");
  assert.deepEqual(checkWkd(wkdDir(t, K1), ref), []);
});

test("a candidate's pull request, its entry first in RELEASES, is checked against the same reference", async (t) => {
  // The candidate's tag exists before its site pull request is merged. RELEASES is never read:
  // the page below names 0.7.2-rc.1 first and the reference is still the newest tag's key file.
  const releases = [...R, { tag: "v0.7.2-rc.1", at: "2026-11-20T10:00:00Z" }];
  const gh = github({ releases, onMain: releases.map((r) => r.tag), keys: { "v0.7.1": K0, "v0.7.2-rc.1": K0 } });
  const page = sub(sub(PAGE, 'version: "0.7.0"', 'version: "0.7.2-rc.1"'),
    "const RELEASES = [\n", 'const RELEASES = [\n  {v:"0.7.2-rc.1", date:"2026-11-10", d:"Rc."},\n');
  assert.deepEqual(checkPage(page), []);
  assert.deepEqual(checkWkd(wkdDir(t, K0), await findReference(gh.get)), []);
});

test("a prerelease tagged on a branch is skipped, so the reference does not roll back", async () => {
  // Newer than the last release, with an older key file (or none): not an ancestor of main.
  for (const keys of [{ "v0.7.1": K1, "v0.7.2-rc.1": K0 }, { "v0.7.1": K1 }]) {
    const releases = [...R, { tag: "v0.7.2-rc.1", at: "2026-11-20T10:00:00Z" }];
    const gh = github({ releases, onMain: ["v0.7.0", "v0.7.1"], keys });
    const ref = await findReference(gh.get);
    assert.equal(ref.tag, "v0.7.1");
    assert.ok(ref.key.equals(K1));
    assert.ok(!gh.seen.includes(keyUrl("v0.7.2-rc.1")), "the branch tag's key file is never read");
  }
});

test("a draft, and a tag that is not v*, are never the reference", async () => {
  const releases = [...R, { tag: "v0.7.2", at: "2026-11-21T10:00:00Z", draft: true }, { tag: "nightly", at: "2026-11-22T10:00:00Z" }];
  const gh = github({ releases, onMain: releases.map((r) => r.tag), keys: { "v0.7.1": K0, "v0.7.2": K1, nightly: K1 } });
  assert.equal((await findReference(gh.get)).tag, "v0.7.1");
});

test("the newest is by published_at, whatever order GitHub lists", async () => {
  const gh = github({ releases: [R[1], R[0]].reverse(), onMain: ["v0.7.0", "v0.7.1"], keys: { "v0.7.1": K0 } });
  assert.equal((await findReference(gh.get)).tag, "v0.7.1");
});

test("v0.7.0 has no key file: no WKD file may be present", async (t) => {
  const gh = github({ releases: [R[0]], onMain: ["v0.7.0"], keys: {} });
  const ref = await findReference(gh.get);
  assert.deepEqual(ref, { tag: "v0.7.0", key: null });
  assert.deepEqual(checkWkd(wkdDir(t), ref), []);
  has(checkWkd(wkdDir(t, K0), ref), "NRV-E1162");
  has(checkWkd(wkdDir(t, K0), ref), "has no key file");
});

test("Nerva with no tag on main: no WKD file may be present", async (t) => {
  const ref = await findReference(github({ releases: [], onMain: [], keys: {} }).get);
  assert.equal(ref, null);
  assert.deepEqual(checkWkd(wkdDir(t), ref), []);
  has(checkWkd(wkdDir(t, K0), ref), "NRV-E1162");
});

test("a reference with a key file requires both WKD files and the same bytes", async (t) => {
  const ref = await findReference(github({ releases: R, onMain: ["v0.7.0", "v0.7.1"], keys: { "v0.7.1": K0 } }).get);
  assert.deepEqual(checkWkd(wkdDir(t, K0), ref), []);
  has(checkWkd(wkdDir(t), ref), "NRV-E1162");           // none
  has(checkWkd(wkdDir(t, K1), ref), "differs");
  has(checkWkd(wkdDir(t, Buffer.concat([K0, Buffer.from("\n")])), ref), "differs");
  const one = wkdDir(t, K0);
  rmSync(join(one, WKD_POLICY));
  has(checkWkd(one, ref), "NRV-E1162");
  const link = wkdDir(t, K1);
  rmSync(join(link, WKD_KEY));
  writeFileSync(join(link, "real"), K0);
  symlinkSync(join(link, "real"), join(link, WKD_KEY));
  has(checkWkd(link, ref), "NRV-E1162");               // a link to the right bytes is not the file
});

test("a reference that cannot be read is an error, not a pass", async () => {
  await assert.rejects(findReference(async () => ({ status: 503, body: "" })), /503/);
  const gh = github({ releases: R, onMain: ["v0.7.1"], keys: { "v0.7.1": K0 } });
  const flaky = async (url) => (url === keyUrl("v0.7.1") ? { status: 502, body: "" } : gh.get(url));
  await assert.rejects(findReference(flaky), /502/);
});

test("--wkd prints one NRV-E1155 line when GitHub cannot be read", async () => {
  const r = await readReference(async () => ({ status: 503, body: "" }));
  assert.equal(r.line, "site-check: error[NRV-E1155]: could not read Nerva's release data from GitHub: the releases list answered 503");
  const thrown = await readReference(async () => { throw new Error("fetch failed"); });
  assert.equal(thrown.line, "site-check: error[NRV-E1155]: could not read Nerva's release data from GitHub: fetch failed");
});

test("--wkd prints one NRV-E1162 line when the key file at the tag is corrupt, not E1155", async () => {
  const gh = github({ releases: R, onMain: ["v0.7.1"], keys: { "v0.7.1": K0 } });
  const bad = async (url) => (url === keyUrl("v0.7.1") ? { status: 200, body: "not a key" } : gh.get(url));
  const r = await readReference(bad);
  assert.equal(r.line, "site-check: error[NRV-E1162]: the key file at v0.7.1 is not readable: not one armored PGP public key block; the key file in Nerva at that tag is not a valid armored public key, so nothing is compared; tell Nerva's maintainers");
});

test("the E1162 line for a differing key is pinned", (t) => {
  const [e] = checkWkd(wkdDir(t, Buffer.from("other")), { tag: "v0.7.1", key: Buffer.from("key") });
  assert.equal(e, "error[NRV-E1162]: the WKD key file differs from packaging/keys/nerva-release.asc at v0.7.1; open a site pull request with the gpg --dearmor of packaging/keys/nerva-release.asc at that tag");
});

test("--tree prints the pinned NRV-E1152 line", (t) => {
  const d = siteDir(t);
  writeFileSync(join(d, "package.json"), "{}");
  const r = spawnSync(process.execPath, [SCRIPT, "--tree", d], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout.split("\n")[0], /^site-check: error\[NRV-E1152\]: site build: .+; nothing is deployed$/);
});

test("the reference is never named by the pull request: --wkd takes no tag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--wkd", ".", "v0.7.1"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
