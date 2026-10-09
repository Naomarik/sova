// `agree`: stamps the draft's records with who agreed and when, records doc-only evidence for those with no
// code, and promotes them only when promote's own plan is clean; otherwise it writes nothing to the current
// spec. Black-box tests for core/sova-spec-draft.mjs on a Git fixture.
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
};
const ID = "§app.list/title-chars", FILE = ".sova/spec/claims/app/list.md", MANIFEST = ".sova/spec/manifest.json";
const D = (name, rel) => `.sova/spec/drafts/${name}/spec/${rel}`;
const TOP = "# §app/list\n\nThe session list.\n";
const promise = (sentence) => `${TOP}\n## ${ID}\n\n${sentence}\n`;
const SIXTY = "A session title shows at most 60 characters, then an ellipsis.";

function project() {
  const root = mkdtempSync(join(tmpdir(), "sova-agree-"));
  roots.push(root);
  write(root, MANIFEST, JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims: { "§app/list": { kind: "surface", authority: "accepted" } } }, null, 2) + "\n");
  write(root, FILE, TOP);
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
  assert.equal(r.status, j.exit, "process status equals JSON exit");
  return j;
}
const editManifest = (root, rel, fn) => { const m = JSON.parse(read(root, rel)); fn(m); write(root, rel, JSON.stringify(m, null, 2) + "\n"); };
/** A draft holding the decided promise, its record without agreed (rec merged in). */
function decided(root, name, rec = {}, sentence = SIXTY) {
  assert.equal(run(root, "new", name, "--write").exit, 0);
  write(root, D(name, "claims/app/list.md"), promise(sentence));
  editManifest(root, D(name, "manifest.json"), (m) => { m.claims[ID] = { kind: "behavior", requires: [], ...rec }; });
}
const agree = (root, name) => run(root, "agree", name, "--id", ID, "--by", "user", "--verification", "agreed in alignment al_1", "--write");
const currentSpec = (root) => read(root, MANIFEST) + read(root, FILE);
const evidenceOf = (root, name) => JSON.parse(read(root, `.sova/spec/drafts/${name}/draft.json`)).evidence ?? [];
const codes = (j) => [...(j.findings ?? []).map((f) => f.code), ...(j.refusals ?? []).map((r) => r.code)];

test("agree lands a decided promise with no code in the current spec: agreed {by, at}, doc-only evidence, a receipt naming the plan", () => {
  const root = project();
  decided(root, "talk");
  const a = agree(root, "talk");
  assert.equal(a.exit, 0, JSON.stringify(a));
  const rec = JSON.parse(read(root, MANIFEST)).claims[ID];
  assert.ok(rec, "the record is in the current spec");
  assert.equal(rec.agreed.by, "user");
  assert.match(rec.agreed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/, "now, to the UTC minute");
  assert.equal(rec.authority, "accepted");
  assert.equal(rec.code, undefined);
  assert.ok(read(root, FILE).includes(SIXTY));
  assert.ok(evidenceOf(root, "talk").some((e) => e.mode === "doc-only" && e.ids.some((i) => (i.id ?? i) === ID)), "doc-only evidence recorded");
  assert.match(JSON.stringify(a), /"plan[^"]*":"[0-9a-f]{12,64}"/, "the receipt carries promote's plan sha");
});

test("guard: a conflict with the current spec (the same § promoted since the draft was made) refuses and writes nothing", () => {
  const root = project();
  decided(root, "talk");
  // elsewhere, the same § lands with other words
  decided(root, "other", {}, "A session title shows at most 80 characters.");
  assert.equal(agree(root, "other").exit, 0);
  const before = currentSpec(root);
  const a = agree(root, "talk");
  assert.notEqual(a.exit, 0, "refused");
  assert.equal(currentSpec(root), before, "the current spec is byte-identical");
  assert.ok(read(root, FILE).includes("80 characters") && !read(root, FILE).includes(SIXTY));
});

test("guard: a record that maps code is stamped but never promoted by agree", () => {
  const root = project();
  decided(root, "build", { code: ["src/list.js"] });
  const before = currentSpec(root);
  const a = agree(root, "build");
  assert.equal(currentSpec(root), before, "the current spec is byte-identical");
  assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID], undefined);
  const rec = JSON.parse(read(root, D("build", "manifest.json"))).claims[ID];
  assert.equal(rec.agreed?.by, "user", `stamped in the draft (agree said ${JSON.stringify(codes(a))})`);
  assert.ok(!evidenceOf(root, "build").some((e) => e.mode === "doc-only"), "no doc-only evidence for code");
});

test("guard: agree run twice is idempotent", () => {
  const root = project();
  decided(root, "talk");
  assert.equal(agree(root, "talk").exit, 0);
  const once = currentSpec(root), at = JSON.parse(read(root, MANIFEST)).claims[ID].agreed.at;
  const b = agree(root, "talk");
  assert.equal(b.exit, 0, JSON.stringify(b));
  assert.equal(currentSpec(root), once, "the current spec is byte-identical after the second run");
  assert.equal(JSON.parse(read(root, MANIFEST)).claims[ID].agreed.at, at);
});
