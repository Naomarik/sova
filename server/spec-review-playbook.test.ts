// The Spec review playbook (playbooks/spec-review, §tools.spec/review-playbook): a Markdown-only,
// operator-run bundle the real catalog loader lists with no schedule, whose published shell blocks run
// as written with their placeholders filled: the preflight refuses a bad root or base before it lists
// anything and caps its list, the metadata block's known-base flags are accepted by the trusted tools,
// a packet page stays within its budget, and the assessment calls show their output only within the
// allowance and, with --path, keep a later file out. Throwaway repositories and agent dir only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listPlaybooks, parseFrontmatter } from "./playbooks";

const PLAYBOOK = fileURLToPath(new URL("../playbooks/spec-review/", import.meta.url));
const TEXT = readFileSync(join(PLAYBOOK, "PLAYBOOK.md"), "utf8");
const CORE = fileURLToPath(new URL("../pi-config/extensions/spec/core", import.meta.url));
const SPEC_MODE = fileURLToPath(new URL("../pi-config/extensions/mode/spec-mode.md", import.meta.url));
/** The playbook's shell blocks, in order: the preflight, the metadata call, the packet call, the assessment preview, the approved write. */
const BLOCKS = [...TEXT.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "spec-review-playbook-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
const write = (root: string, p: string, s: string) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), s);
};
const git = (root: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
let n = 0;
/** A committed one-claim project, then a change to its mapped file and one untracked file. */
function project() {
  const R = join(tmp, `project-${n++}`);
  write(R, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§app/rule": { kind: "behavior", requires: [], authority: "accepted", evidence: "verified", code: ["lib/rule.js"] },
  } }));
  write(R, ".sova/spec/claims/app/rule.md", `# §app/rule\n\n${"Meter fill warns at ≥80%. ".repeat(200)}\n`);
  write(R, "lib/rule.js", "export const threshold = 80;\n");
  write(R, ".gitignore", ".sova/spec/drafts/\n");
  git(R, "init");
  git(R, "add", ".");
  git(R, "commit", "-m", "baseline");
  const B = git(R, "rev-parse", "HEAD");
  write(R, "lib/rule.js", "export const threshold = 90;\n");
  write(R, "lib/new.js", "export const n = 1;\n");
  return { R, B };
}
/** A block with its placeholders written out, as the playbook tells the agent to. */
const fill = (block: string, v: Record<string, string>) => Object.entries(v).reduce((s, [k, x]) => s.replaceAll(`<${k}>`, x), block);
/** One shell call, in a throwaway agent dir whose spec core is the canonical one. */
function sh(script: string) {
  const agent = join(tmp, "agent");
  if (!existsSync(agent)) {
    mkdirSync(join(agent, "extensions", "spec"), { recursive: true });
    symlinkSync(CORE, join(agent, "extensions", "spec", "core"));
  }
  // The node running this test comes first: a version-manager shim may refuse an untrusted config here.
  const PATH = [dirname(process.execPath), process.env.PATH ?? ""].join(":");
  const r = spawnSync("sh", ["-c", script], { cwd: tmp, encoding: "utf8", env: { ...process.env, PATH, PI_CODING_AGENT_DIR: agent }, timeout: 120_000 });
  assert.ifError(r.error);
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("the real loader lists it as a Sova playbook with no schedule, its frontmatter holds only the dialog's keys, and the bundle is the entry alone", async () => {
  const cat = await listPlaybooks(undefined, { userDir: join(tmp, "no-user-playbooks") });
  const p = cat.playbooks.find((x) => x.id === "spec-review");
  assert.ok(p, "spec-review is shipped");
  assert.equal(p.source, "sova");
  assert.equal(p.title, "Spec review");
  assert.ok(p.description.length > 0 && (p.promptHint?.length ?? 0) > 0);
  assert.equal(p.schedule, undefined, "no schedule");
  assert.deepEqual(Object.keys(parseFrontmatter(TEXT).fields).sort(), ["description", "promptHint", "title"]);
  assert.deepEqual(readdirSync(PLAYBOOK), ["PLAYBOOK.md"], "no script or state of its own");
  assert.equal(BLOCKS.length, 5, "the preflight, the metadata and packet calls, the assessment preview and the approved write");
  const coreLine = readFileSync(SPEC_MODE, "utf8").split("\n").find((l) => l.startsWith('core="${PI_CODING_AGENT_DIR'));
  for (const b of BLOCKS.slice(1)) assert.equal(b.split("\n")[0], coreLine, "each call resolves the tools with spec-mode.md's own line");
});

test("preflight: an ancestor base prints itself and the change since it; a bad root or base is refused before anything is listed", () => {
  const { R, B } = project();
  let r = sh(fill(BLOCKS[0]!, { root: R, base: "master" }));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split("\n"), [`base ${B}`, "lib/new.js", "lib/rule.js"]);

  git(R, "checkout", "-q", "-b", "side");
  write(R, "lib/side.js", "1\n");
  git(R, "add", "lib/side.js");
  git(R, "commit", "-qm", "side");
  git(R, "checkout", "-q", "master");
  const refusals: [Record<string, string>, RegExp][] = [
    [{ root: R, base: "side" }, /^refused: side is not an ancestor of HEAD$/],
    [{ root: R, base: "no-such-rev" }, /^refused: no-such-rev is not a commit here$/],
    [{ root: join(R, "lib"), base: "master" }, /^refused: .*\/lib is not a checkout's top folder$/],
    [{ root: join(tmp, "absent"), base: "master" }, /is not a checkout's top folder$/],
  ];
  for (const [v, refusal] of refusals) {
    r = sh(fill(BLOCKS[0]!, v));
    assert.equal(r.code, 2, `${JSON.stringify(v)}: ${r.out}`);
    assert.match(r.out.trim(), refusal, "one refusal line and nothing listed");
  }
});

test("preflight: the change list stops at 201 lines, one past the 200 a brief may carry", () => {
  const { R } = project();
  for (let i = 0; i < 250; i++) write(R, `lib/many/f${String(i).padStart(3, "0")}.js`, `${i}\n`);
  const r = sh(fill(BLOCKS[0]!, { root: R, base: "master" }));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split("\n").length, 1 + 201);
});

test("the metadata call's known-base flags are accepted by git and the trusted tools, and a packet page stays within its budget", () => {
  const { R, B } = project();
  const r = sh(fill(BLOCKS[1]!, { root: R, base: B, paths: "lib/rule.js" }));
  assert.match(r.out, /^ lib\/rule\.js \| 2 \+-$/m, "diff --stat against the base, scoped");
  assert.doesNotMatch(r.out, /lib\/new\.js \|/, "the stat carries only the scoped paths");
  const docs = r.out.slice(r.out.indexOf("{")).split(/\n(?=\{)/).map((d) => JSON.parse(d));
  assert.deepEqual(docs.map((d) => d.command), ["census", "foreign"]);
  for (const d of docs) assert.notEqual(d.exit, 2, JSON.stringify(d.findings));
  assert.equal(docs[0].census.base.commit, B);
  assert.deepEqual(docs[0].census.claimed.map((c: { path: string }) => c.path), ["lib/rule.js"]);

  for (const budget of ["12000", "1024"]) {
    const p = sh(fill(BLOCKS[2]!, { root: R, "§id": "§app/rule" }).replace("--budget 12000", `--budget ${budget}`));
    const page = JSON.parse(p.out);
    assert.notEqual(page.exit, 2, p.out);
    assert.equal(page.budget, Number(budget));
    assert.ok(Buffer.byteLength(p.out.trimEnd()) <= Number(budget), `${Buffer.byteLength(p.out)} bytes over a ${budget} budget`);
  }
});

test("assessment: output is shown only within the allowance, never cut; --path keeps a later file out where the live change would take it in", () => {
  const { R, B } = project();
  write(R, "lib/late.js", "export const late = 1;\n"); // changed after the brief froze lib/rule.js
  const v = { root: R, base: B, name: "review", path: "lib/rule.js", who: "reviewer", decisions: '{"decisions":[],"files":[]}' };

  let r = sh(fill(BLOCKS[3]!, { ...v, bytes: "100" }));
  const lines = r.out.trim().split("\n");
  assert.match(lines[0]!, /^exit 0 · (\d+) bytes$/);
  assert.ok(Number(/(\d+) bytes/.exec(lines[0]!)![1]) > 100);
  assert.deepEqual(lines.slice(1), ["not shown: over the 100-byte allowance"], "nothing of the capture, not even a head");

  r = sh(fill(BLOCKS[3]!, { ...v, bytes: "4000000" }));
  const [head, ...rest] = r.out.split("\n");
  assert.match(head!, /^exit 0 · \d+ bytes$/);
  const preview = JSON.parse(rest.join("\n"));
  assert.equal(preview.written, false);
  assert.deepEqual(preview.changedFiles, ["lib/rule.js"], "--path: only the scoped file");
  assert.ok(!existsSync(join(R, ".sova/spec/assessments")), "the preview writes nothing");
  // The contrast the --path sentence guards against: without it, the live change takes the later file in.
  const live = sh(fill(BLOCKS[3]!, { ...v, bytes: "4000000" }).replace(" --path 'lib/rule.js'", ""));
  assert.deepEqual(JSON.parse(live.out.split("\n").slice(1).join("\n")).changedFiles, ["lib/late.js", "lib/new.js", "lib/rule.js"]);

  r = sh(fill(BLOCKS[4]!, { ...v, bytes: "4000000" }));
  const exits = r.out.split("\n").filter((l) => /^exit \d+ · \d+ bytes$/.test(l)).map((l) => l.split(" ")[1]);
  assert.deepEqual(exits.slice(0, 2), ["0", "0"], "prepare --write and record succeed");
  assert.ok(exits[2] === "0" || exits[2] === "1", "status answers (1: unknown or stale inputs, still an answer)");
  const store = join(R, ".sova/spec/assessments/review");
  const packet = JSON.parse(readFileSync(join(store, "packet.json"), "utf8"));
  assert.equal(packet.query.base, B, "the declared base, not a task start");
  assert.deepEqual(packet.capture.changedFiles, ["lib/rule.js"]);
  assert.deepEqual(packet.query.baseline, { inputs: [] }, "no declared snapshot");
  assert.ok(Object.values(packet.attribution).every((x) => x === null), "attribution stays null");
  assert.equal(JSON.parse(readFileSync(join(store, "record.json"), "utf8")).by, "reviewer");
});
