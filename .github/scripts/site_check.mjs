// site-check: what a pull request to this repository must satisfy (no dependencies).
//
//   node .github/scripts/site_check.mjs index.html
//       index.html parses and its status data is well formed.
//   node .github/scripts/site_check.mjs index.html --release BASE_INDEX_HTML CHANGED_FILES...
//       as above, and the page differs from BASE_INDEX_HTML only by one new RELEASES entry and
//       SITE.version, SITE.released and SITE.updated; CHANGED_FILES is only index.html.
//
// Each refusal is one line starting "site-check:". Exit 1 on any, 2 on bad usage.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const STATUS = ["done", "wip", "plan"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
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
  return x[4] < y[4] ? -1 : 1;
}

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
    need(!/["\\]/.test(e.d ?? ""), `RELEASES[${i}].d must not hold a quote or a backslash`);
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

// A release page may differ from its base by one new first RELEASES entry and three SITE keys.
export function checkRelease(baseHtml, headHtml, changedFiles) {
  const errs = [];
  const files = changedFiles.filter((f) => f !== "");
  const others = files.filter((f) => f !== "index.html");
  if (others.length > 0)
    errs.push(`a release changes only index.html, not ${others.join(", ")}`);
  const base = baseHtml.split("\n"), head = headHtml.split("\n");
  const at = head.findIndex((l) => l.startsWith("const RELEASES = ["));
  const baseAt = base.findIndex((l) => l.startsWith("const RELEASES = ["));
  if (at < 0 || baseAt < 0) return [...errs, "`const RELEASES = [` not found"];
  const entry = head[at + 1] ?? "";
  if (!/^\s*\{v:"[^"\\]+", date:"\d{4}-\d{2}-\d{2}", d:"[^"\\]+"\},\s*$/.test(entry))
    return [...errs, "the first line under `const RELEASES = [` must be the new entry {v:\"..\", date:\"..\", d:\"..\"},"];
  const rest = head.filter((_, i) => i !== at + 1);
  const keyLine = (lines, k) => lines.findIndex((l) => new RegExp(`^  ${k}: `).test(l));
  for (const k of ["updated", "version", "released"]) {
    const i = keyLine(rest, k), j = keyLine(base, k);
    if (i < 0 || j < 0) return [...errs, `SITE.${k} not found`];
    rest[i] = base[j];
  }
  if (rest.length !== base.length)
    errs.push(`the page changes ${Math.abs(rest.length - base.length)} more line(s) than a release may`);
  else {
    const bad = rest.flatMap((l, i) => (l === base[i] ? [] : [i + 1]));
    if (bad.length > 0)
      errs.push(`a release changes only its RELEASES entry and SITE.version, SITE.released and SITE.updated; other lines differ, the first at line ${bad[0]}`);
  }
  return errs;
}

function main(argv) {
  const [page, flag, basePath, ...changed] = argv;
  if (!page || (flag !== undefined && (flag !== "--release" || !basePath))) {
    console.error("usage: site_check.mjs index.html [--release BASE_INDEX_HTML CHANGED_FILES...]");
    return 2;
  }
  const head = readFileSync(page, "utf8");
  let errs = checkPage(head);
  if (flag === "--release") errs = errs.concat(checkRelease(readFileSync(basePath, "utf8"), head, changed));
  for (const e of errs) console.log(`site-check: ${e}`);
  if (errs.length === 0) console.log(`site-check: ok${flag ? " (release)" : ""}`);
  return errs.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
