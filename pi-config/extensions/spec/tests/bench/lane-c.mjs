#!/usr/bin/env node
// Lane C bench: honest, short tool output. Prints one JSON object of measures; never asserts.
//   node tests/bench/lane-c.mjs [--real <repo>] [--only where,draft,recovery]
// (i) where: hidden results without a signal, text/JSON agreement, missing path state.
// (ii) draft check/new/promote: introduced vs pre-existing, output bytes; same on a git-archive copy of a real spec.
// (iii) git: two branches promote adjacent H2s, the manifest driver merges, the claims file conflicts;
//       follow the documented recovery literally; check exit and calls used.
// Fixtures live in temp dirs; nothing outside them is written.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, "../..");
const CORE = join(SPEC, "core/sova-spec.mjs"), DRAFT = join(SPEC, "core/sova-spec-draft.mjs");
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
const only = new Set((opt("--only") ?? "where,draft,recovery").split(","));
const realRepo = opt("--real");
const roots = [];
process.on("exit", () => { if (!process.env.KEEP) for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const env = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });
const tmp = (p) => { const r = mkdtempSync(join(tmpdir(), `lane-c-${p}-`)); roots.push(r); return r; };
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const manifest = (claims) => JSON.stringify({ formatVersion: 1, claims }, null, 2) + "\n";
let calls = 0;
function node(tool, root, args, { json = true } = {}) {
  calls++;
  const r = spawnSync(process.execPath, [tool, ...args, "--root", root, ...(json ? ["--json"] : [])], { cwd: root, encoding: "utf8", env: env(root), maxBuffer: 1 << 28 });
  let j = null;
  if (json) try { j = JSON.parse(r.stdout); } catch {}
  return { status: r.status, out: r.stdout, err: r.stderr, bytes: Buffer.byteLength(r.stdout), j };
}
const core = (root, ...a) => node(CORE, root, a);
const draft = (root, ...a) => node(DRAFT, root, a);
function git(root, ...a) {
  calls++;
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8", env: env(root) });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
}
const editJSON = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
const D = (name, rel = "") => `.sova/spec/drafts/${name}/spec${rel ? `/${rel}` : ""}`;
const codes = (j) => [...(j?.findings ?? []).map((f) => f.code), ...(j?.refusals ?? []).map((r) => r.code)];

// ---------------------------------------------------------------- (i) where
function benchWhere() {
  const root = tmp("where");
  const claims = {};
  for (let i = 0; i < 12; i++) {
    const id = `§f/part-${String.fromCharCode(97 + i)}`;
    claims[id] = { kind: "note", requires: [] };
    write(root, `.sova/spec/claims/f/part-${String.fromCharCode(97 + i)}.md`, `# ${id} — Part ${i}\n\nThis part passes \`Foo\` along.\n`);
  }
  claims["§f/code"] = { kind: "behavior", authority: "accepted", requires: [], code: ["src/real.ts"] };
  write(root, ".sova/spec/claims/f/code.md", "# §f/code — Code\n\nIt exports one constant.\n");
  write(root, ".sova/spec/manifest.json", manifest(claims));
  write(root, "src/real.ts", "export const Foo = 1;\n");
  const signalled = (j) => j && (j.status === "more" || j.next || (j.notShown ?? 0) > 0 || (j.remaining ?? 0) > 0);
  const hidden = (j) => Math.max(0, (j?.total ?? 0) - (j?.shown ?? j?.lines?.length ?? 0));
  const tok = core(root, "where", "Foo");
  const txt = node(CORE, root, ["where", "Foo"], { json: false });
  const more = /(\d+) more not shown/.exec(txt.out);
  const textTotal = (txt.out.match(/^  §/gm) ?? []).length + (more ? Number(more[1]) : 0);
  // paging: follow next/cursor if any, else --all
  let paged = null;
  if (tok.j?.next) {
    const ids = new Set(tok.j.lines.map((l) => l.id)); let n = tok.j.next, guard = 0;
    while (n && guard++ < 20) { const p = core(root, "where", "Foo", "--cursor", n); for (const l of p.j?.lines ?? []) ids.add(l.id); n = p.j?.next; }
    paged = ids.size;
  }
  const all = core(root, "where", "Foo", "--all");
  const miss = core(root, "where", "src/no-such-file.ts");
  const missTxt = node(CORE, root, ["where", "src/no-such-file.ts"], { json: false });
  // guard: an existing path still answers as a path
  const real = core(root, "where", "src/real.ts");
  return {
    token: { total: tok.j?.total, shown: tok.j?.shown, status: tok.j?.status, remaining: tok.j?.remaining, next: tok.j?.next ?? null, notShown: tok.j?.notShown, hint: tok.j?.hint, exit: tok.j?.exit,
      hiddenWithoutSignal: signalled(tok.j) ? 0 : hidden(tok.j), textTotal, textJsonAgree: textTotal === tok.j?.total, pagedIds: paged, allIds: all.j?.lines?.length, bytes: tok.bytes },
    missing: { mode: miss.j?.mode, file: miss.j?.file ?? null, pathLike: miss.j?.pathLike, exit: miss.j?.exit, absentSignalled: miss.j?.file?.state === "absent",
      jsonHasNote: /no file|absent|does not exist|not found/i.test(JSON.stringify({ ...miss.j, query: undefined })), textSaysNoFile: /no file .* under the root/.test(missTxt.out) },
    guardExistingPath: { mode: real.j?.mode, state: real.j?.file?.state, claims: real.j?.counts?.claims },
  };
}

// ---------------------------------------------------------------- (ii) draft check / new / promote
function summarize(j, bytes) {
  return { bytes, exit: j?.exit, introduced: Array.isArray(j?.introduced) ? j.introduced.length : j?.introduced, preexisting: j?.preexisting ?? null,
    findings: j?.findings?.length, coreFindings: j?.coreFindings?.length, codes: [...new Set(codes(j).concat((j?.coreFindings ?? []).map((f) => f.code)))] };
}
function benchDraftFixture() {
  const root = tmp("draft");
  const claims = { "§b/top": { kind: "surface", authority: "accepted", requires: [] } };
  let md = "# §b/top — Base\n\nThe base surface.\n";
  for (let i = 0; i < 10; i++) {
    const id = `§b.top/u-${String.fromCharCode(97 + i)}`;
    claims[id] = { kind: "behavior", authority: "accepted", code: [`lib/u${i}.txt`] }; // no requires: uninvestigated
    md += `\n## ${id} — U${i}\n\nU${i} does a thing.\n`;
    write(root, `lib/u${i}.txt`, `u${i}\n`);
  }
  write(root, ".sova/spec/manifest.json", manifest(claims));
  write(root, ".sova/spec/claims/b/top.md", md);
  const base = core(root, "check");
  const n = draft(root, "new", "f1", "--write");
  const clean = draft(root, "check", "f1");
  // the draft adds one dangling requires
  write(root, D("f1", "claims/b/new.md"), "# §b/new — New\n\nNew does a thing.\n");
  editJSON(root, D("f1", "manifest.json"), (m) => { m.claims["§b/new"] = { kind: "behavior", authority: "accepted", requires: ["§b/missing"], code: ["lib/u0.txt"] }; });
  const chk = draft(root, "check", "f1");
  // promote: a separate draft adding one note, doc-only evidence
  draft(root, "new", "f2", "--write");
  write(root, D("f2", "claims/b/note.md"), "# §b/note — Note\n\nWhy the base exists.\n");
  editJSON(root, D("f2", "manifest.json"), (m) => { m.claims["§b/note"] = { kind: "note", authority: "accepted", requires: [] }; });
  const ev = draft(root, "evidence", "f2", "--id", "§b/note", "--by", "bench", "--verification", "doc only", "--doc-only", "--write");
  const pv = draft(root, "promote", "f2", "--id", "§b/note");
  const pw = draft(root, "promote", "f2", "--id", "§b/note", "--plan", pv.j?.plan ?? "", "--write");
  return {
    baseCheck: { exit: base.j?.exit, uninvestigated: (base.j?.findings ?? []).filter((f) => f.code === "requires-uninvestigated").length, bytes: base.bytes },
    new: { bytes: n.bytes, exit: n.j?.exit, files: n.j?.files?.length },
    checkNothingNew: summarize(clean.j, clean.bytes),
    checkOneDangling: { ...summarize(chk.j, chk.bytes), danglingNamed: /§b\/missing/.test(chk.out) },
    promote: { evidenceExit: ev.j?.exit, previewBytes: pv.bytes, previewExit: pv.j?.exit, writeBytes: pw.bytes, writeExit: pw.j?.exit, refusals: codes(pw.j) },
  };
}
function benchDraftReal(repo) {
  const root = tmp("real");
  const a = spawnSync("sh", ["-c", `git -C "${repo}" archive HEAD | tar -x -C "${root}"`], { encoding: "utf8" });
  if (a.status !== 0) return { error: a.stderr };
  rmSync(join(root, ".sova/spec/drafts"), { recursive: true, force: true });
  const base = core(root, "check");
  const n = draft(root, "new", "r1", "--write");
  const clean = draft(root, "check", "r1");
  const m = JSON.parse(read(root, D("r1", "manifest.json")));
  write(root, D("r1", "claims/zz/bench.md"), "# §zz/bench — Bench\n\nA note added by the lane C bench.\n");
  editJSON(root, D("r1", "manifest.json"), (mm) => { mm.claims["§zz/bench"] = { kind: "note", authority: "accepted", requires: [] }; });
  const one = draft(root, "check", "r1");
  const ev = draft(root, "evidence", "r1", "--id", "§zz/bench", "--by", "bench", "--verification", "doc only", "--doc-only", "--write");
  const pv = draft(root, "promote", "r1", "--id", "§zz/bench");
  const pw = draft(root, "promote", "r1", "--id", "§zz/bench", "--plan", pv.j?.plan ?? "", "--write");
  return {
    records: Object.keys(m.claims).length, baseCheckExit: base.j?.exit, baseCheckBytes: base.bytes,
    baseUninvestigated: (base.j?.findings ?? []).filter((f) => f.code === "requires-uninvestigated").length,
    new: { bytes: n.bytes, exit: n.j?.exit }, checkNothingNew: summarize(clean.j, clean.bytes), checkOneNote: summarize(one.j, one.bytes),
    promote: { evidenceExit: ev.j?.exit, previewBytes: pv.bytes, previewExit: pv.j?.exit, writeBytes: pw.bytes, writeExit: pw.j?.exit, refusals: codes(pw.j) },
  };
}

// ---------------------------------------------------------------- (iii) driver merged the manifest, claims conflicted
// recovery: "before" = PROMOTE.md as of bd597e20, read literally ("A conflict in claims/*.md is settled the same way:
// master's file, then the branch's text again through a new draft"): checkout master's claims file, commit, re-apply.
// "after" = the documented one-command path (manifest AND conflicted claims from master, never --ours), as P5 proposes.
// Also runs each backticked `git checkout` PROMOTE.md documents (doc0, doc1, …), placeholders filled in.
function addNote(root, name, id, title, after) {
  draft(root, "new", name, "--write");
  const rel = D(name, "claims/x/top.md");
  const t = read(root, rel);
  const at = t.indexOf(after) + after.length;
  write(root, rel, t.slice(0, at) + `\n## ${id} — ${title}\n\n${title} says why.\n` + t.slice(at));
  editJSON(root, D(name, "manifest.json"), (m) => { m.claims[id] = { kind: "note", authority: "accepted", requires: [] }; });
  const ev = draft(root, "evidence", name, "--id", id, "--by", "bench", "--verification", "doc only", "--doc-only", "--write");
  const pv = draft(root, "promote", name, "--id", id);
  const pw = draft(root, "promote", name, "--id", id, "--plan", pv.j?.plan ?? "", "--write");
  return { ev: ev.j?.exit, pv: pv.j?.exit, pw: pw.j?.exit, refusals: codes(pw.j), msg: (pw.j?.refusals ?? []).map((r) => r.message).join(" | ") };
}
function setupConflict() {
  const root = tmp("merge");
  write(root, ".sova/spec/manifest.json", manifest({ "§x/top": { kind: "surface", authority: "accepted", requires: [] }, "§x.top/a": { kind: "note", authority: "accepted", requires: [] } }));
  write(root, ".sova/spec/claims/x/top.md", "# §x/top — Top\n\nThe top.\n\n## §x.top/a — A\n\nA says why.\n");
  write(root, ".gitignore", "home/\n.sova/spec/drafts/\n");
  write(root, ".gitattributes", ".sova/spec/manifest.json merge=sova-spec-manifest\n");
  git(root, "init", "-q");
  git(root, "config", "merge.sova-spec-manifest.driver", `"${process.execPath}" "${DRAFT}" merge-manifest --root . --base %O --ours %A --theirs %B --write`);
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "by");
  const by = addNote(root, "fb", "§x.top/b", "B", "A says why.\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "by promotes B");
  git(root, "checkout", "-q", "master"); git(root, "merge", "-q", "--ff-only", "by");
  git(root, "checkout", "-qb", "bx", "master~1");
  const bx = addNote(root, "fa", "§x.top/n", "N", "A says why.\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "bx promotes N");
  const m = git(root, "merge", "master", "-m", "merge master");
  const unmerged = git(root, "diff", "--name-only", "--diff-filter=U").out.split("\n").filter(Boolean);
  const manifestMerged = !unmerged.includes(".sova/spec/manifest.json") && /§x\.top\/b/.test(read(root, ".sova/spec/manifest.json")) && /§x\.top\/n/.test(read(root, ".sova/spec/manifest.json"));
  return { root, setup: { by, bx, mergeStatus: m.status, unmerged, manifestMerged } };
}
const CONFLICTED = ".sova/spec/claims/x/top.md";
const RECOVERIES = {
  ours: ["checkout", "--ours", "--", ".sova/spec/manifest.json", CONFLICTED],
  "claims-only": ["checkout", "master", "--", CONFLICTED],
  both: ["checkout", "master", "--", ".sova/spec/manifest.json", CONFLICTED],
};
// Every backticked `git checkout …` in PROMOTE.md, placeholders filled with this fixture's names.
function docCommands() {
  const promote = read(SPEC, "PROMOTE.md");
  return [...new Set([...promote.matchAll(/`git (checkout [^`]*)`/g)].map((m) => m[1]))].map((text) => ({ text,
    args: text.replace(/<(master|main|default[^>]*|base[^>]*)>/g, "master").replace(/\.sova\/spec\/claims\/…|<[^>]*claims[^>]*>|…/g, CONFLICTED)
      .split(/\s+/).filter(Boolean) }));
}
function recover(args) {
  const { root, setup } = setupConflict();
  calls = 0;
  const co = git(root, ...args);
  git(root, "add", "-A"); git(root, "commit", "-qm", "resolve");
  const chk1 = core(root, "check");
  rmSync(join(root, ".sova/spec/drafts"), { recursive: true, force: true });
  const re = addNote(root, "fa2", "§x.top/n", "N", "A says why.\n");
  const chk2 = core(root, "check");
  const t = read(root, CONFLICTED);
  return { setup, checkout: { args: args.join(" "), status: co.status }, checkExitAfterResolve: chk1.j?.exit,
    checkCodes: [...new Set((chk1.j?.findings ?? []).filter((f) => f.severity === "error").map((f) => f.code))],
    reapply: re, checkExitFinal: chk2.j?.exit, hasB: t.includes("§x.top/b"), hasN: t.includes("§x.top/n"), calls };
}
// Longest run of words a message shares with a document.
function shared(msg, doc) {
  const w = msg.split(/\s+/).filter(Boolean); let best = [];
  for (let i = 0; i < w.length; i++) for (let j = w.length; j > i + best.length; j--) if (doc.includes(w.slice(i, j).join(" "))) { best = w.slice(i, j); break; }
  return best.join(" ");
}
function docText(runtime) {
  const promote = read(SPEC, "PROMOTE.md");
  const src = read(SPEC, "core/sova-spec-draft.mjs");
  const m = /refuse\("conflict",\s*`([^`]*)`/.exec(src);
  const refusal = m ? m[1].replace(/\$\{[^}]*\}/g, "") : "";
  const s1 = shared(refusal, promote), s2 = shared(runtime, promote);
  return { conflictRefusal: refusal, conflictSharedWords: s1 ? s1.split(" ").length : 0, conflictShared: s1,
    reapplyRefusal: runtime, reapplySharedWords: s2 ? s2.split(" ").length : 0, reapplyShared: s2,
    promoteSaysNeverOurs: /never `?--ours/i.test(promote), promoteNamesDriverMergedCase: /driver.{0,120}(merged|already)/is.test(promote),
    contradiction: /by hand/.test(refusal) && /can't be hand-fixed/.test(promote), promoteCheckoutCommands: docCommands().map((c) => c.text) };
}

const out = {};
if (only.has("where")) out.where = benchWhere();
if (only.has("draft")) { out.draftFixture = benchDraftFixture(); if (realRepo) out.draftReal = benchDraftReal(resolve(realRepo)); }
if (only.has("recovery")) {
  out.recovery = Object.fromEntries(Object.entries(RECOVERIES).map(([k, a]) => [k, recover(a)]));
  docCommands().forEach((c, i) => { out.recovery[`doc${i}`] = recover(c.args); });
  out.docs = docText(out.recovery["claims-only"].reapply.msg);
}
console.log(JSON.stringify(out, null, 2));
