// An agreed record whose prose changes while its `agreed` stays the same: promote says so (a note, never a
// refusal), naming who the stamp still credits. Black-box tests for core/sova-spec-draft.mjs on a Git fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../core/sova-spec-draft.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function write(root, rel, text) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const git = (root, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const ID = "§app.list/title-chars", FILE = ".sova/spec/claims/app/list.md", D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;
const AGREED = { by: "the operator", at: "2026-10-05" };
const claims = (sentence) => `# §app/list\n\nThe session list.\n\n## ${ID}\n\n${sentence}\n`;
const SIXTY = "A session title shows at most 60 characters, then an ellipsis.";

/** A Git project whose current spec already holds the agreed, unbuilt promise (60 characters). */
function project() {
  const root = mkdtempSync(join(tmpdir(), "sova-agreed-kept-"));
  roots.push(root);
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims: {
    "§app/list": { kind: "surface", authority: "accepted" },
    [ID]: { kind: "behavior", authority: "accepted", requires: [], agreed: AGREED },
  } }, null, 2) + "\n");
  write(root, FILE, claims(SIXTY));
  write(root, "src/list.js", "export const MAX = 60;\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  return j;
}
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };

/**
 * A draft that changes the agreed record: `sentence` is its new prose (unchanged when omitted), `rec` is merged
 * into its record, `build` maps code and records commit evidence (else doc-only). → the promote preview's JSON.
 */
function change(root, name, { sentence, rec = {}, build = false }) {
  assert.equal(run(root, "new", name, "--write").exit, 0);
  if (sentence !== undefined) write(root, D(name, "claims/app/list.md"), claims(sentence));
  editManifest(root, D(name, "manifest.json"), (m) => Object.assign(m.claims[ID], rec, build ? { code: ["src/list.js"], evidence: "reviewed" } : {}));
  if (build) {
    write(root, "src/list.js", "export const MAX = 64;\n");
    git(root, "add", "src/list.js");
    git(root, "commit", "-qm", "build");
  }
  const e = run(root, "evidence", name, "--id", ID, "--by", "tester", "--verification", "checked", ...(build ? ["--commit", "HEAD"] : ["--doc-only"]), "--write");
  assert.equal(e.exit, 0, JSON.stringify(e.findings));
  return run(root, "promote", name, "--id", ID);
}

/**
 * What promote says about an agreed record kept across a prose change, as a non-refusing note: any finding or
 * warning (not a refusal) whose code or text names `agreed` and the record. The trial proposed the code
 * `agreed-kept-on-change`; any code or field the tool puts it in counts, a refusal never does.
 */
function agreedKeptNotes(p) {
  const items = [
    ...(p.findings ?? []).filter((f) => f.severity !== "error"),
    ...(p.driftWarnings ?? []).map((w) => ({ message: w })),
    ...(p.warnings ?? []).map((w) => (typeof w === "string" ? { message: w } : w)),
    ...(p.notes ?? []).map((w) => (typeof w === "string" ? { message: w } : w)),
  ];
  return items.filter((x) => /agreed/i.test(`${x.code ?? ""} ${x.message ?? ""}`) && (x.id === ID || JSON.stringify(x).includes(ID)) && !/^drift-/.test(x.code ?? ""));
}

test("a meaning change (60 → 64 characters) that keeps the old agreed promotes, with one note naming the old decider", () => {
  for (const build of [false, true]) {
    const root = project();
    const p = change(root, "meaning", { sentence: SIXTY.replace("60", "64"), build });
    assert.equal(p.exit, 0, JSON.stringify(p.refusals));
    const notes = agreedKeptNotes(p);
    assert.equal(notes.length, 1, `build=${build}: ${JSON.stringify(notes)}`);
    assert.match(JSON.stringify(notes[0]), /the operator/, "names who the stamp still credits");
    assert.ok(!(p.refusals ?? []).length, "a note, never a refusal");
    const w = run(root, "promote", "meaning", "--id", ID, "--plan", p.plan, "--write");
    assert.equal(w.exit, 0, JSON.stringify(w.refusals));
  }
});

test("guards: unchanged prose with agreed kept, a fresh go-ahead restamp, and a whitespace-only edit get no note", () => {
  const root = project();
  const cases = {
    // the build of the agreed promise: code and label added, prose and agreed as they were
    unchanged: { build: true },
    // the task's go-ahead is a new agreement: reworded prose, agreed replaced by a later stamp
    restamped: { sentence: SIXTY.replace("60", "64"), rec: { agreed: { by: "user", at: "2026-10-10T09:00Z" } } },
    // reflowed, same words
    whitespace: { sentence: SIXTY.replace("at most ", "at most\n") },
  };
  for (const [name, c] of Object.entries(cases)) {
    const p = change(root, name, c);
    assert.equal(p.exit, 0, `${name}: ${JSON.stringify(p.refusals)}`);
    assert.deepEqual(agreedKeptNotes(p), [], name);
  }
});
