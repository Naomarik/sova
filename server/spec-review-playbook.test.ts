// The Spec review playbook (playbooks/spec-review): a Markdown-only,
// operator-run bundle the real catalog loader lists with no schedule, whose published shell blocks run
// as written with their placeholders filled: the preflight refuses a bad root or base before it lists
// anything and caps its list, the metadata block's known-base flags are accepted by the trusted tools,
// and the reading call lists the contents, then reads one passage within its budget. Throwaway repositories and agent dir only.
// The playbook's shell steps run against a real repository: spec-review-playbook.integration.test.ts.
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
/** The playbook's shell blocks, in order: the preflight, the metadata call, the reading call (toc, then read). */
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
    // An always-on frame of ~5.7 KB: the first read carries it outside its budget (§tools.spec/frame).
    "§app/ground": { kind: "note", authority: "accepted", core: true },
  } }));
  write(R, ".sova/spec/claims/app/rule.md", `# §app/rule\n\n${"Meter fill warns at ≥80%. ".repeat(200)}\n`);
  write(R, ".sova/spec/claims/app/ground.md", `# §app/ground\n\n${"Every task keeps the ground rules. ".repeat(160)}\n`);
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
  assert.equal(BLOCKS.length, 3, "the preflight, the metadata call and the reading call");
  const coreLine = readFileSync(SPEC_MODE, "utf8").split("\n").find((l) => l.startsWith('core="${PI_CODING_AGENT_DIR'));
  for (const b of BLOCKS.slice(1)) assert.equal(b.split("\n")[0], coreLine, "each call resolves the tools with spec-mode.md's own line");
});
