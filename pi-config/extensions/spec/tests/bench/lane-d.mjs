#!/usr/bin/env node
// Lane D bench: the Agree step. Prints one JSON object of measures; never asserts.
//   node tests/bench/lane-d.mjs [--repo <git repo with a master branch>]
// (i) promote notes on an agreed record whose prose meaning changes (60 → 64) while `agreed` stays, and on the
//     guards (unchanged prose, go-ahead restamp, whitespace reflow): see tests/agreed-kept.test.mjs.
// (ii) the agree path: steps (tool calls) from "the user confirmed" to "agreed record in the current spec", by
//     today's documented path and, when the tool has it, the `agree` command; checks agreed {by, at} and
//     doc-only evidence.
// (iii) the 2-week review baseline: agreed records in <repo>'s master manifest.
// Fixtures live in temp dirs; nothing outside them is written.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAFT = resolve(HERE, "../../core/sova-spec-draft.mjs");
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
const repo = opt("--repo") ?? spawnSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
const roots = [];
process.on("exit", () => { if (!process.env.KEEP) for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const env = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const git = (root, ...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env: env(root) });
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };

const ID = "§app.list/title-chars", FILE = ".sova/spec/claims/app/list.md", D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;
const TOP = "# §app/list\n\nThe session list.\n";
const SIXTY = "A session title shows at most 60 characters, then an ellipsis.";

function project(withAgreed) {
  const root = mkdtempSync(join(tmpdir(), "lane-d-"));
  roots.push(root);
  const claims = { "§app/list": { kind: "surface", authority: "accepted" } };
  if (withAgreed) claims[ID] = { kind: "behavior", authority: "accepted", requires: [], agreed: { by: "the operator", at: "2026-10-05" } };
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims }, null, 2) + "\n");
  write(root, FILE, withAgreed ? `${TOP}\n## ${ID}\n\n${SIXTY}\n` : TOP);
  write(root, "src/list.js", "export const MAX = 60;\n");
  git(root, "init", "-q"); git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  return root;
}
let steps = 0;
const step = (fn) => { steps++; return fn(); };
function draft(root, ...args) {
  steps++;
  const r = spawnSync(process.execPath, [DRAFT, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: env(root) });
  try { return JSON.parse(r.stdout); } catch { return { exit: r.status, raw: (r.stdout + r.stderr).slice(0, 300) }; }
}

// (i)
async function notes() {
  // the same filter as tests/agreed-kept.test.mjs's agreedKeptNotes
  const count = (p) => {
    const items = [...(p.findings ?? []).filter((f) => f.severity !== "error"), ...(p.driftWarnings ?? []).map((m) => ({ message: m })), ...(p.notes ?? []), ...(p.warnings ?? [])];
    return items.filter((x) => /agreed/i.test(JSON.stringify(x)) && JSON.stringify(x).includes(ID) && !/^drift-/.test(x.code ?? "")).length;
  };
  const cases = {
    "meaning-60-to-64": { sentence: SIXTY.replace("60", "64") },
    "meaning-60-to-64-built": { sentence: SIXTY.replace("60", "64"), build: true },
    "guard-unchanged-built": { build: true },
    "guard-restamp": { sentence: SIXTY.replace("60", "64"), rec: { agreed: { by: "user", at: "2026-10-10T09:00Z" } } },
    "guard-whitespace": { sentence: SIXTY.replace("at most ", "at most\n") },
    "info-punctuation": { sentence: SIXTY.replace(", then", "; then") },
    "info-reword-no-quantity": { sentence: "A session title shows no more than 60 characters, followed by an ellipsis." },
  };
  const out = {};
  for (const [name, c] of Object.entries(cases)) {
    const root = project(true);
    draft(root, "new", name, "--write");
    if (c.sentence) write(root, D(name, "claims/app/list.md"), `${TOP}\n## ${ID}\n\n${c.sentence}\n`);
    editManifest(root, D(name, "manifest.json"), (m) => Object.assign(m.claims[ID], c.rec ?? {}, c.build ? { code: ["src/list.js"], evidence: "reviewed" } : {}));
    if (c.build) { write(root, "src/list.js", "export const MAX = 64;\n"); git(root, "add", "src/list.js"); git(root, "commit", "-qm", "build"); }
    const e = draft(root, "evidence", name, "--id", ID, "--by", "t", "--verification", "checked", ...(c.build ? ["--commit", "HEAD"] : ["--doc-only"]), "--write");
    const p = draft(root, "promote", name, "--id", ID);
    out[name] = { evidenceExit: e.exit, previewExit: p.exit, refusals: (p.refusals ?? []).map((r) => r.code), notes: count(p) };
  }
  return out;
}

// (ii)
function verify(root, name) {
  const rec = JSON.parse(read(root, ".sova/spec/manifest.json")).claims[ID];
  let ev = [];
  try { ev = JSON.parse(read(root, `.sova/spec/drafts/${name}/draft.json`)).evidence ?? []; } catch {}
  const docOnly = ev.some((e) => e.mode === "doc-only" && (e.ids ?? []).some((i) => (i.id ?? i) === ID));
  return { inCurrent: !!rec, agreed: rec?.agreed ?? null, agreedHasByAt: !!(rec?.agreed?.by && rec?.agreed?.at), noCode: rec ? !rec.code : null, docOnlyEvidence: docOnly, prose: read(root, FILE).includes(SIXTY) };
}
function writePromise(root, name, rec) {
  step(() => write(root, D(name, "claims/app/list.md"), `${TOP}\n## ${ID}\n\n${SIXTY}\n`));
  step(() => editManifest(root, D(name, "manifest.json"), (m) => { m.claims[ID] = { kind: "behavior", authority: "accepted", requires: [], ...rec }; }));
}
function promote(root, name) {
  const p = draft(root, "promote", name, "--id", ID);
  return p.exit ? p : draft(root, "promote", name, "--id", ID, "--plan", p.plan, "--write");
}
function pathToday() {
  const root = project(false), name = "talk";
  steps = 0;
  draft(root, "new", name, "--write");
  writePromise(root, name, { agreed: { by: "user", at: new Date().toISOString().slice(0, 16) + "Z" } });
  draft(root, "evidence", name, "--id", ID, "--by", "user", "--verification", "agreed in the alignment", "--doc-only", "--write");
  const w = promote(root, name);
  return { steps, promoteExit: w.exit, ...verify(root, name) };
}
function pathAgree() {
  const root = project(false), name = "talk";
  steps = 0;
  draft(root, "new", name, "--write");
  writePromise(root, name, {});
  const a = draft(root, "agree", name, "--id", ID, "--by", "user", "--verification", "agreed in the alignment", "--write");
  if (a.exit === 2 && /usage|unknown/i.test(JSON.stringify(a))) return { available: false, agreeExit: a.exit, agreeSays: (a.findings?.[0]?.message ?? a.raw ?? "").slice(0, 160) };
  const promoted = !!JSON.parse(read(root, ".sova/spec/manifest.json")).claims[ID];
  const w = promoted ? { exit: 0 } : promote(root, name);
  return { available: true, agreeExit: a.exit, agreePromoted: promoted, steps, promoteExit: w.exit, ...verify(root, name) };
}

// (iii)
function baseline() {
  const out = {};
  for (const ref of ["master", "HEAD"]) {
    const r = spawnSync("git", ["-C", repo, "show", `${ref}:.sova/spec/manifest.json`], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) { out[ref] = null; continue; }
    const claims = JSON.parse(r.stdout).claims ?? {};
    out[ref] = { records: Object.keys(claims).length, agreed: Object.entries(claims).filter(([, c]) => c.agreed).map(([id]) => id) };
  }
  return out;
}

const result = { notes: await notes(), agreePath: { today: pathToday(), agreeCommand: pathAgree() }, agreedOnMain: baseline() };
console.log(JSON.stringify(result, null, 2));
