// Black-box checks for the ranked finishing census: `census --changed --related` orders the touched foreign § by
// the change's own lines (added and removed), marks at most 5 read-first, names the rest, and flags a removed
// literal a § still states. Node stdlib and the git CLI only; every fixture is a temp Git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, "../core/sova-spec.mjs");
const fixtureEnv = (root) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home") });

const roots = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function ok(root, ...a) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8", env: fixtureEnv(root) });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function census(root) {
  const r = spawnSync(process.execPath, [CORE, "census", "--changed", "--related", "--root", root, "--json"], { encoding: "utf8", cwd: root, env: fixtureEnv(root) });
  let j;
  try { j = JSON.parse(r.stdout); } catch { assert.fail(`non-JSON stdout (status ${r.status}): ${r.stdout}\n${r.stderr}`); }
  assert.ok(j.census, `no census (status ${r.status}): ${r.stdout.slice(0, 800)}`);
  return j.census;
}
/** The census's order: read-first, then the rest. */
const ranked = (c) => { assert.ok(Array.isArray(c.readFirst), `census.readFirst: ${JSON.stringify(Object.keys(c))}`); return [...c.readFirst, ...(c.named ?? [])]; };
const touched = (c, id) => c.touched.find((t) => t.id === id);

const OTHERS = ["a", "b", "c", "d", "e", "f"];
const VIEW = ["§app/head", "§app/title-class", ...OTHERS.map((n) => `§app/other-${n}`)];
function repo() {
  const root = mkdtempSync(join(tmpdir(), "sova-census-rank-"));
  roots.push(root);
  const claims = { "§app/voice": { kind: "behavior", authority: "accepted", requires: [], code: ["src/voice.ts"] } };
  for (const id of VIEW) claims[id] = { kind: "behavior", authority: "accepted", requires: [], code: ["src/view.tsx"] };
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["src"], exclude: [] }, claims }, null, 2) + "\n");
  write(root, ".sova/spec/claims/app/head.md", "# §app/head\n\nThe head title carries `aria-describedby` pointing at the context description.\n");
  write(root, ".sova/spec/claims/app/title-class.md", "# §app/title-class\n\nThe title is styled by the `head-title` class.\n");
  write(root, ".sova/spec/claims/app/voice.md", "# §app/voice\n\nA clip is at most 12 MB.\n");
  for (const n of OTHERS) write(root, `.sova/spec/claims/app/other-${n}.md`, `# §app/other-${n}\n\nPane ${n} lists its workers.\n`);
  write(root, "src/view.tsx", 'export const Head = () => <h1 className="head-title">title</h1>;\n');
  write(root, "src/voice.ts", "export const MAX = 12 * 1024 * 1024;\n");
  write(root, ".gitignore", ".sova/spec/drafts/\n");
  ok(root, "init", "-q");
  ok(root, "add", "-A");
  ok(root, "commit", "-qm", "base");
  return root;
}

test("ranked by the change's lines: an added attribute and a removed class put their § first; at most 5 read-first; every touched § still named", () => {
  const root = repo();
  write(root, "src/view.tsx", 'export const Head = () => <input aria-describedby="context-desc" defaultValue="title" />;\n');
  const c = census(root);
  const order = ranked(c);
  assert.deepEqual([...order].sort(), [...VIEW].sort(), "every touched foreign § named once, none dropped, no other");
  assert.deepEqual([...order].sort(), [...c.foreign].sort(), "the same set the census lists as foreign");
  assert.ok(c.readFirst.length <= 5, `read-first ≤ 5: ${c.readFirst}`);
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(["§app/head", "§app/title-class"]), `added aria-describedby and removed head-title rank 1–2: ${order}`);
  assert.ok(c.readFirst.includes("§app/head") && c.readFirst.includes("§app/title-class"));
});

test("a removed literal the § still states: that § ranks first and is flagged; an unrelated change flags nothing", () => {
  const root = repo();
  write(root, "src/voice.ts", "export const MAX = 16 * 1024 * 1024;\n");
  const c = census(root);
  assert.deepEqual(ranked(c), ["§app/voice"]);
  const stale = touched(c, "§app/voice")?.stale;
  assert.ok((Array.isArray(stale) ? stale.join(" ") : String(stale ?? "")).includes("12"), `stale names 12: ${JSON.stringify(stale)}`);
  write(root, "src/voice.ts", "export const MAX = 12 * 1024 * 1024; // a clip\n");
  const quiet = touched(census(root), "§app/voice")?.stale;
  assert.ok(!quiet || (Array.isArray(quiet) && !quiet.length), `12 kept: nothing stale: ${JSON.stringify(quiet)}`);
});
