// site-check: what a pull request to this repository must satisfy (no dependencies).
//
//   node .github/scripts/site_check.mjs index.html
//       index.html parses and its status data is well formed.
//   node .github/scripts/site_check.mjs index.html --release BASE_INDEX_HTML [--version V] CHANGED_FILES...
//       as above, and the page differs from BASE_INDEX_HTML only by one new RELEASES entry and
//       SITE.version, SITE.released and SITE.updated; CHANGED_FILES is only index.html. With
//       --version V the new entry's version must be V (the `release/v<V>` branch name).
//   node .github/scripts/site_check.mjs --files DIR
//       index.html, 404.html and _headers are regular files in DIR, not symlinks (NRV-E1152: the
//       Pages build command refuses the same, docs/releases/packages.md in NervaLog/nerva).
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
import { lstatSync, readFileSync } from "node:fs";
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
  const others = files.filter((f) => f !== "index.html");
  if (others.length > 0)
    errs.push(`a release changes only index.html, not ${others.join(", ")}`);
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
// symlink, even a dangling one, is refused.
export const REQUIRED_FILES = ["index.html", "404.html", "_headers"];

export function checkFiles(dir) {
  const errs = [];
  for (const f of REQUIRED_FILES) {
    let st;
    try { st = lstatSync(join(dir, f)); } catch { st = undefined; }
    if (!st || st.isSymbolicLink() || !st.isFile())
      errs.push(`error[NRV-E1152]: site build: ${f} is missing, not a regular file, or a symlink; nothing would be deployed`);
  }
  return errs;
}

function main(argv) {
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
