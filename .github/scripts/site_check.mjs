// site-check: what a pull request to this repository must satisfy (no dependencies).
//
//   node .github/scripts/site_check.mjs index.html
//       index.html parses and its status data is well formed.
//   node .github/scripts/site_check.mjs index.html --release BASE_INDEX_HTML [--version V] CHANGED_FILES...
//       as above, and the page differs from BASE_INDEX_HTML only by one new RELEASES entry and
//       SITE.version, SITE.released and SITE.updated; CHANGED_FILES is index.html, alone or with
//       exactly the two WKD files (never one of them, never another path). With
//       --version V the new entry's version must be V (the `release/v<V>` branch name).
//   node .github/scripts/site_check.mjs --files DIR
//       index.html, 404.html and _headers are regular files in DIR, not symlinks (NRV-E1152: the
//       build command refuses the same, docs/releases/packages.md in NervaLog/nerva).
//   node .github/scripts/site_check.mjs --tree DIR
//       every name the Worker's build gate (site_build.sh in NervaLog/nerva) refuses: a root entry
//       off its allow-list, a symlink at a metadata name or under .well-known, a path under
//       .well-known that is not the WKD pair, and one WKD file without the other (NRV-E1152).
//   node .github/scripts/site_check.mjs --wkd DIR
//       the WKD key file in DIR is the dearmored packaging/keys/nerva-release.asc at the newest
//       published v* tag of NervaLog/nerva whose commit is an ancestor of main, prereleases
//       included (NRV-E1162). Reads GitHub; GITHUB_TOKEN is used when set.
//
// THE CONTRACT with the Nerva side (site_release.py, release_notes.sh site; NervaLog/nerva
// docs/releases/automation.md). A release changes exactly these lines of index.html, and nothing
// else, and each has exactly this shape, with only the value changed:
//
//   first line under `const RELEASES = [`:
//     {v:"<VERSION>", date:"<YYYY-MM-DD>", d:"<sentence>"},       (two-space indent, one space
//                                                                   after each comma, trailing comma)
//   `  version: "<VERSION>",`   VERSION is ^\d+\.\d+\.\d+(-rc\.\d+)?$
//   `  released: "<YYYY-MM-DD>",`   equal to the entry's date
//   `  updated: "<YYYY-MM-DD>",`
//
// <sentence> is printable ASCII (0x20-0x7E) without < > & ` " or \, at most 300 characters.
// The entry's v equals SITE.version. Do not loosen this: the page's script is code.
//
// Each refusal is one line starting "site-check:". Exit 1 on any, 2 on bad usage.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const STATUS = ["done", "wip", "plan"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const VERSION = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
const SENTENCE = /^[\x20-\x7E]{1,300}$/;
const SENTENCE_BAD = /[<>&`"\\]/;
const DATA_END = "// ===== Rendering =====";

export function extractScript(html) {
  const parts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  if (parts.length !== 1) throw new Error(`expected exactly one inline <script>, found ${parts.length}`);
  return parts[0][1];
}

// The data block: from `const SITE` to the rendering marker. Returns its text.
export function dataBlock(script) {
  const a = script.indexOf("const SITE = {");
  const b = script.indexOf(DATA_END);
  if (a < 0) throw new Error("`const SITE = {` not found");
  if (b < a) throw new Error(`"${DATA_END}" not found after the data`);
  return script.slice(a, b);
}

export function evalData(block) {
  const ctx = vm.createContext({});
  return vm.runInContext(
    `${block}\n;({SITE, GOALS, NEXT, PRODUCTION, RELEASES, DOCS})`, ctx, { timeout: 1000 });
}

function cmpVersion(a, b) {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) if (+x[i] !== +y[i]) return +x[i] - +y[i];
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1; // a release is newer than its candidates
  if (y[4] === undefined) return -1;
  // SemVer 11.4: numeric identifiers compare as numbers and sort below alphanumeric ones; a
  // shorter list sorts below a longer one that starts with it.
  const p = x[4].split("."), q = y[4].split(".");
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const m = /^\d+$/.test(p[i]), n = /^\d+$/.test(q[i]);
    if (m && n) return +p[i] - +q[i];
    if (m !== n) return m ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return p.length - q.length;
}

const isSentence = (v) => typeof v === "string" && SENTENCE.test(v) && !SENTENCE_BAD.test(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";

export function checkData(d) {
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  const { SITE, GOALS, NEXT, PRODUCTION, RELEASES, DOCS } = d;

  for (const k of ["updated", "repo", "version", "released", "stage", "stageStatus"])
    need(isStr(SITE[k]), `SITE.${k} must be a non-empty string`);
  need(DATE.test(SITE.updated ?? ""), "SITE.updated must be YYYY-MM-DD");
  need(DATE.test(SITE.released ?? ""), "SITE.released must be YYYY-MM-DD");
  need(SEMVER.test(SITE.version ?? ""), "SITE.version must be a version such as 0.7.0");
  need(STATUS.includes(SITE.stageStatus), 'SITE.stageStatus must be "done", "wip" or "plan"');

  for (const [name, list, keys] of [
    ["GOALS", GOALS, ["id", "name", "goal"]],
    ["PRODUCTION", PRODUCTION, ["id", "name", "goal"]],
  ]) {
    need(Array.isArray(list) && list.length > 0, `${name} must be a non-empty array`);
    const ids = new Set();
    (list ?? []).forEach((e, i) => {
      for (const k of keys) need(isStr(e[k]), `${name}[${i}].${k} must be a non-empty string`);
      need(STATUS.includes(e.status), `${name}[${i}].status must be "done", "wip" or "plan"`);
      need(!ids.has(e.id), `${name}[${i}].id "${e.id}" is repeated`);
      ids.add(e.id);
    });
  }
  need(Array.isArray(NEXT) && NEXT.length > 0, "NEXT must be a non-empty array");
  (NEXT ?? []).forEach((e, i) => {
    for (const k of ["ref", "t", "d"]) need(isStr(e[k]), `NEXT[${i}].${k} must be a non-empty string`);
    need(STATUS.includes(e.status), `NEXT[${i}].status must be "done", "wip" or "plan"`);
  });
  need(Array.isArray(DOCS) && DOCS.length > 0, "DOCS must be a non-empty array");
  (DOCS ?? []).forEach((e, i) => {
    for (const k of ["t", "path", "d"]) need(isStr(e[k]), `DOCS[${i}].${k} must be a non-empty string`);
  });

  need(Array.isArray(RELEASES) && RELEASES.length > 0, "RELEASES must be a non-empty array");
  const rel = Array.isArray(RELEASES) ? RELEASES : [];
  rel.forEach((e, i) => {
    need(SEMVER.test(e.v ?? ""), `RELEASES[${i}].v must be a version such as 0.7.0`);
    need(DATE.test(e.date ?? ""), `RELEASES[${i}].date must be YYYY-MM-DD`);
    need(isStr(e.d), `RELEASES[${i}].d must be a non-empty string`);
    need(isSentence(e.d), `RELEASES[${i}].d must be printable ASCII without < > & \` " or \\, at most 300 characters`);
    if (i > 0 && SEMVER.test(e.v ?? "") && SEMVER.test(rel[i - 1].v ?? ""))
      need(cmpVersion(rel[i - 1].v, e.v) > 0,
        `RELEASES must be newest first: ${rel[i - 1].v} is followed by ${e.v}`);
    if (i > 0) need((e.date ?? "") <= (rel[i - 1].date ?? ""),
      `RELEASES dates must not increase down the list: ${e.v} is dated ${e.date}`);
  });
  if (rel.length > 0) {
    need(SITE.version === rel[0].v,
      `SITE.version ${SITE.version} must equal RELEASES[0].v ${rel[0].v}`);
    need(SITE.released === rel[0].date,
      `SITE.released ${SITE.released} must equal RELEASES[0].date ${rel[0].date}`);
  }
  return errs;
}

// Everything a page's checks need, as a list of refusals. Syntax is checked by compiling the
// script (what `node --check` does) and the data by evaluating its block.
export function checkPage(html) {
  let script;
  try { script = extractScript(html); } catch (e) { return [e.message]; }
  try { new vm.Script(script, { filename: "index.html" }); }
  catch (e) { return [`the script does not parse: ${e.message}`]; }
  let data;
  try { data = evalData(dataBlock(script)); }
  catch (e) { return [`the status data does not evaluate: ${e.message}`]; }
  return checkData(data);
}

// The WKD pair (P398): the policy, empty, and the key file, named by the z-base-32 of the SHA-1 of
// `nerva`. Release pull requests may carry them, and only them, besides index.html.
export const WKD_POLICY = ".well-known/openpgpkey/policy";
export const WKD_KEY = ".well-known/openpgpkey/hu/ndqm47zydhyqyzabecddtdk1q3bponab";
const WKD_FILES = [WKD_POLICY, WKD_KEY];

// A release page may differ from its base by one new first RELEASES entry and three SITE lines,
// each in exactly the shape the contract above gives.
const ENTRY = /^  \{v:"([^"]*)", date:"([^"]*)", d:"([^"]*)"\},$/;
const SITE_LINE = {
  updated: /^  updated: "(\d{4}-\d{2}-\d{2})",$/,
  released: /^  released: "(\d{4}-\d{2}-\d{2})",$/,
  version: /^  version: "(\d+\.\d+\.\d+(?:-rc\.\d+)?)",$/,
};

export function checkRelease(baseHtml, headHtml, changedFiles, expectVersion) {
  const errs = [];
  const files = changedFiles.filter((f) => f !== "");
  const others = files.filter((f) => f !== "index.html" && !WKD_FILES.includes(f));
  if (others.length > 0)
    errs.push(`a release changes only index.html and the two WKD files, not ${others.join(", ")}`);
  const wkd = WKD_FILES.filter((f) => files.includes(f));
  if (wkd.length === 1)
    errs.push(`a release changes both WKD files or neither, not only ${wkd[0]}`);
  const base = baseHtml.split("\n"), head = headHtml.split("\n");
  const at = head.findIndex((l) => l.startsWith("const RELEASES = ["));
  const baseAt = base.findIndex((l) => l.startsWith("const RELEASES = ["));
  if (at < 0 || baseAt < 0) return [...errs, "`const RELEASES = [` not found"];
  const m = ENTRY.exec(head[at + 1] ?? "");
  if (!m || !VERSION.test(m[1]) || !DATE.test(m[2]) || !isSentence(m[3]))
    return [...errs, "the first line under `const RELEASES = [` must be exactly the new entry `  {v:\"<version>\", date:\"<YYYY-MM-DD>\", d:\"<sentence>\"},` with a printable-ASCII sentence of at most 300 characters without < > & ` \" or \\"];
  const [, entryV, entryDate] = m;
  const rest = head.filter((_, i) => i !== at + 1);
  const keyLine = (lines, k) => lines.findIndex((l) => new RegExp(`^  ${k}: `).test(l));
  const got = {};
  for (const k of ["updated", "version", "released"]) {
    const i = keyLine(rest, k), j = keyLine(base, k);
    if (i < 0 || j < 0) return [...errs, `SITE.${k} not found`];
    const sm = SITE_LINE[k].exec(rest[i]);
    if (!sm) return [...errs, `the SITE.${k} line must be exactly \`  ${k}: "<value>",\`, alone on its line`];
    got[k] = sm[1];
    rest[i] = base[j];
  }
  if (got.version !== entryV)
    errs.push(`the new entry ${entryV} must equal SITE.version ${got.version}`);
  if (got.released !== entryDate)
    errs.push(`the new entry's date ${entryDate} must equal SITE.released ${got.released}`);
  if (expectVersion !== undefined && entryV !== expectVersion)
    errs.push(`the new entry ${entryV} must be the version of the branch, ${expectVersion}`);
  if (rest.length !== base.length)
    errs.push(`the page changes ${Math.abs(rest.length - base.length)} more line(s) than a release may`);
  else {
    const bad = rest.flatMap((l, i) => (l === base[i] ? [] : [i + 1]));
    if (bad.length > 0)
      errs.push(`a release changes only its RELEASES entry and SITE.version, SITE.released and SITE.updated; other lines differ, the first at line ${bad[0]}`);
  }
  return errs;
}

// The three files the Pages build copies (NRV-E1152): each must exist as a regular file, and a
// symlink, even a dangling one, is refused. Messages end "; nothing is deployed", as the build
// command does (docs/releases/packages.md in NervaLog/nerva), so a CI log greps like the build log.
export const REQUIRED_FILES = ["index.html", "404.html", "_headers"];

export function checkFiles(dir) {
  const errs = [];
  for (const f of REQUIRED_FILES) {
    let st;
    try { st = lstatSync(join(dir, f)); } catch { st = undefined; }
    if (!st || st.isSymbolicLink() || !st.isFile())
      errs.push(`error[NRV-E1152]: site build: ${f} is missing, not a regular file, or a symlink; nothing is deployed`);
  }
  return errs;
}

// ---- the tree: every name the build gate refuses (NRV-E1152) ------------------------------------

// The gate's allow-list (site_build.sh): a name it does not know is refused, whatever it is.
const ALLOWED = ["index.html", "404.html", "_headers", ".well-known", ".git", ".github", ".nojekyll",
  "README.md", "LICENSE", "CLAUDE.md"];
const METADATA = [".git", ".github", ".nojekyll", "README.md", "LICENSE", "CLAUDE.md"];
const WKD_DIRS = [".well-known", ".well-known/openpgpkey", ".well-known/openpgpkey/hu"];
const lstat = (p) => { try { return lstatSync(p); } catch { return undefined; } };

export function checkTree(dir) {
  const errs = [];
  const refuse = (what) => errs.push(`error[NRV-E1152]: site build: ${what}; nothing is deployed`);
  for (const name of readdirSync(dir).sort())
    if (!ALLOWED.includes(name)) refuse(`${name} is not allowed in the site repository`);
  for (const f of METADATA) if (lstat(join(dir, f))?.isSymbolicLink()) refuse(`${f} is a symlink`);

  const wk = lstat(join(dir, ".well-known"));
  if (wk) {
    // Walk without following links: only the two directories and the two files are allowed.
    const walk = (rel) => {
      for (const name of readdirSync(join(dir, rel)).sort()) {
        const path = `${rel}/${name}`;
        const st = lstat(join(dir, path));
        if (!WKD_DIRS.includes(path) && !WKD_FILES.includes(path)) refuse(`${path} is not allowed in the site repository`);
        else if (st.isSymbolicLink()) refuse(`${path} is a symlink`);
        else if (st.isDirectory() && WKD_DIRS.includes(path)) walk(path);
        else if (WKD_DIRS.includes(path) !== st.isDirectory()) refuse(`${path} is not the kind of file it must be`);
      }
    };
    if (wk.isSymbolicLink()) refuse(".well-known is a symlink");
    else if (!wk.isDirectory()) refuse(".well-known is not a directory");
    else walk(".well-known");
  }
  let n = 0;
  for (const f of WKD_FILES) {
    const st = lstat(join(dir, f));
    if (st?.isFile()) n++;
    else if (st && !st.isSymbolicLink()) refuse(`${f} is not a regular file`);
  }
  if (n === 1) refuse("one WKD file is present without the other; both or neither");
  return errs;
}

// ---- the WKD key against Nerva's key file (NRV-E1162) --------------------------------------------

const crc24 = (buf) => {
  let crc = 0xb704ce;
  for (const b of buf) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x864cfb; }
  }
  return crc & 0xffffff;
};

// `gpg --dearmor` of one armored public key block: the base64 body, its CRC-24 checked.
export function dearmor(asc) {
  const lines = asc.replace(/\r/g, "").split("\n");
  const b = lines.findIndex((l) => l === "-----BEGIN PGP PUBLIC KEY BLOCK-----");
  const e = lines.findIndex((l) => l === "-----END PGP PUBLIC KEY BLOCK-----");
  if (b < 0 || e < b) throw new Error("not one armored PGP public key block");
  let i = b + 1;
  while (i < e && lines[i].trim() !== "") i++; // armor headers end at the first blank line
  const body = lines.slice(i + 1, e).filter((l) => l.trim() !== "");
  const crcLine = body.length > 0 && body[body.length - 1].startsWith("=") ? body.pop() : undefined;
  const bin = Buffer.from(body.join(""), "base64");
  if (bin.length === 0) throw new Error("the armored block is empty");
  if (crcLine !== undefined && Buffer.from(crcLine.slice(1), "base64").readUIntBE(0, 3) !== crc24(bin))
    throw new Error("the armor's checksum does not match");
  return bin;
}

const REPO = "NervaLog/nerva";
const KEY_PATH = "packaging/keys/nerva-release.asc";

// The reference: the key file at the newest published v* tag whose commit is an ancestor of main,
// prereleases included, drafts never. A prerelease tagged on a branch is not an ancestor and is
// skipped, so the reference never goes back to an older or missing key file. It is read from
// Nerva, never from the pull request being checked. `get(url)` returns {status, body}.
// Returns {tag, key}: key is the dearmored key file, or null when that tag has none (v0.7.0).
// Returns null when Nerva has no published tag on main.
export async function findReference(get) {
  const releases = [];
  for (let page = 1; page <= 5; page++) {
    const r = await get(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`);
    if (r.status !== 200) throw new Error(`the releases list answered ${r.status}`);
    const list = JSON.parse(r.body);
    releases.push(...list);
    if (list.length < 100) break;
  }
  const published = releases
    .filter((x) => !x.draft && x.published_at && typeof x.tag_name === "string" && x.tag_name.startsWith("v"))
    .sort((x, y) => (x.published_at < y.published_at ? 1 : x.published_at > y.published_at ? -1 : 0));
  for (const rel of published) {
    const tag = rel.tag_name;
    const c = await get(`https://api.github.com/repos/${REPO}/compare/${encodeURIComponent(tag)}...main`);
    if (c.status !== 200) throw new Error(`comparing ${tag} with main answered ${c.status}`);
    const status = JSON.parse(c.body).status;
    if (status !== "ahead" && status !== "identical") continue; // not an ancestor of main
    const k = await get(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(tag)}/${KEY_PATH}`);
    if (k.status === 404) return { tag, key: null };
    if (k.status !== 200) throw new Error(`the key file at ${tag} answered ${k.status}`);
    try { return { tag, key: dearmor(k.body) }; }
    catch (e) { throw new KeyFileError(`the key file at ${tag} is not readable: ${e.message}`); }
  }
  return null;
}

// Nerva's own key file at the tag cannot be read: not GitHub's fault, and a re-run cannot fix it.
export class KeyFileError extends Error {}

// The site's WKD pair against the reference. Never reads a file through a symlink.
export function checkWkd(dir, ref) {
  const regular = (f) => lstat(join(dir, f))?.isFile() === true;
  const present = WKD_FILES.filter((f) => lstat(join(dir, f)) !== undefined);
  const bad = (what) => [`error[NRV-E1162]: ${what}`];
  const fix = "; open a site pull request with the gpg --dearmor of packaging/keys/nerva-release.asc at that tag";
  if (ref === null || ref.key === null) {
    if (present.length > 0)
      return bad(`${present.join(", ")} present, but Nerva's newest release tag on main${ref ? ` (${ref.tag})` : ""} has no key file; remove the WKD files`);
    return [];
  }
  if (present.length !== 2 || !WKD_FILES.every(regular))
    return bad(`the WKD files must both be present as regular files and carry the key file at ${ref.tag}${fix}`);
  if (!readFileSync(join(dir, WKD_KEY)).equals(ref.key))
    return bad(`the WKD key file differs from packaging/keys/nerva-release.asc at ${ref.tag}${fix}`);
  return [];
}

async function githubGet(url) {
  const headers = { "User-Agent": "site-check", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN && new URL(url).hostname === "api.github.com")
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  return { status: r.status, body: await r.text() };
}

// The reference, or the one printed line that refuses to compare against it. Fail closed: with no
// reference nothing is compared. A bad key file at the tag is NRV-E1162 (Nerva's, a re-run cannot
// fix it); any other failure is GitHub's (NRV-E1155).
export async function readReference(get) {
  try { return { ref: await findReference(get) }; }
  catch (e) {
    if (e instanceof KeyFileError)
      return { line: `site-check: error[NRV-E1162]: ${e.message}; the key file in Nerva at that tag is not a valid armored public key, so nothing is compared; tell Nerva's maintainers` };
    return { line: `site-check: error[NRV-E1155]: could not read Nerva's release data from GitHub: ${e.message}` };
  }
}

async function main(argv) {
  if (argv[0] === "--tree") {
    if (argv.length !== 2) { console.error("usage: site_check.mjs --tree DIR"); return 2; }
    const errs = checkTree(argv[1]);
    for (const e of errs) console.log(`site-check: ${e}`);
    if (errs.length === 0) console.log("site-check: ok (tree)");
    return errs.length === 0 ? 0 : 1;
  }
  if (argv[0] === "--wkd") {
    if (argv.length !== 2) { console.error("usage: site_check.mjs --wkd DIR"); return 2; }
    const refd = await readReference(githubGet);
    if (refd.line !== undefined) { console.log(refd.line); return 1; }
    const ref = refd.ref;
    const errs = checkWkd(argv[1], ref);
    for (const e of errs) console.log(`site-check: ${e}`);
    if (errs.length === 0) {
      if (ref === null) console.log("site-check: notice: Nerva has no published tag on main; no WKD file is required");
      else if (ref.key === null) console.log(`site-check: notice: ${ref.tag} has no key file; no WKD file is allowed`);
      console.log("site-check: ok (wkd)");
    }
    return errs.length === 0 ? 0 : 1;
  }

  if (argv[0] === "--files") {
    if (argv.length !== 2) { console.error("usage: site_check.mjs --files DIR"); return 2; }
    const errs = checkFiles(argv[1]);
    for (const e of errs) console.log(`site-check: ${e}`);
    if (errs.length === 0) console.log("site-check: ok (files)");
    return errs.length === 0 ? 0 : 1;
  }
  const [page, flag, basePath, ...more] = argv;
  if (!page || (flag !== undefined && (flag !== "--release" || !basePath))) {
    console.error("usage: site_check.mjs index.html [--release BASE_INDEX_HTML [--version V] CHANGED_FILES...]");
    return 2;
  }
  let expect;
  if (more[0] === "--version") { expect = more[1]; more.splice(0, 2); }
  if (more[0] === "--version" || (expect !== undefined && !VERSION.test(expect))) {
    console.error("site_check.mjs: --version takes a version such as 0.7.1");
    return 2;
  }
  const changed = more;
  const head = readFileSync(page, "utf8");
  let errs = checkPage(head);
  if (flag === "--release") errs = errs.concat(checkRelease(readFileSync(basePath, "utf8"), head, changed, expect));
  for (const e of errs) console.log(`site-check: ${e}`);
  if (errs.length === 0) console.log(`site-check: ok${flag ? " (release)" : ""}`);
  return errs.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main(process.argv.slice(2)));
