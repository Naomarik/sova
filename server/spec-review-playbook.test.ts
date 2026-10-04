// The Spec review playbook (playbooks/spec-review, §tools.spec/review-playbook): a Markdown-only,
// operator-run bundle the real catalog loader lists with no schedule, whose text keeps its limits
// cooperative and its writes per-receipt approved, and whose published shell recipe runs as written
// against the canonical spec tools, on a throwaway repository and agent dir only.
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
/** The playbook's shell blocks, in order: the preflight, the receipt preview, the approved write. */
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
/** Runs shell text the way an agent would, with the given variables and a throwaway agent dir whose spec core is the canonical one. */
const sh = (script: string, vars: Record<string, string>) => {
  const agent = join(tmp, "agent");
  if (!existsSync(agent)) {
    mkdirSync(join(agent, "extensions", "spec"), { recursive: true });
    symlinkSync(CORE, join(agent, "extensions", "spec", "core"));
  }
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agent, ...vars }, timeout: 120_000 });
  assert.ifError(r.error);
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("the real loader lists it as a Sova playbook with no schedule; its frontmatter holds only the dialog's keys, and the bundle is the entry alone", async () => {
  const cat = await listPlaybooks(undefined, { userDir: join(tmp, "no-user-playbooks") });
  const p = cat.playbooks.find((x) => x.id === "spec-review");
  assert.ok(p, "spec-review is shipped");
  assert.equal(p.source, "sova");
  assert.equal(p.title, "Spec review");
  assert.ok(p.description.length > 0 && (p.promptHint?.length ?? 0) > 0);
  assert.equal(p.schedule, undefined, "no schedule");
  assert.deepEqual(Object.keys(parseFrontmatter(TEXT).fields).sort(), ["description", "promptHint", "title"], "no when, profile, tz or task");
  assert.deepEqual(readdirSync(PLAYBOOK), ["PLAYBOOK.md"], "no driver, scripts or state of its own");
});

test("the text keeps limits cooperative, writes per-receipt approved, the report's sections fixed, and resolves the spec tools exactly as the spec discipline does", () => {
  for (const s of ["Question", "Findings", "Unknown", "Coverage", "Cost", "Method proposals", "Stopped because"]) assert.ok(TEXT.includes(`\`## ${s}\``), `## ${s}`);
  for (const t of ["Observed:", "Inferred:", "Proposed:"]) assert.ok(TEXT.includes(`\`${t}\``), t);
  assert.match(TEXT, /\*\*The limits are cooperative\.\*\* You keep them; nothing here enforces them\./);
  assert.match(TEXT, /`--budget` bounds the bytes its page returns, not the CPU or the reads behind it/);
  assert.match(TEXT, /ask for this receipt\. Only once they approve it:/);
  assert.match(TEXT, /When the operator's message already gives all of it, that is the approved brief: start collecting\./);
  assert.doesNotMatch(TEXT, /spec_assess|--baseline-json|--attribution-json|\bexpire\b|^when:|^profile:/m);
  const coreLine = readFileSync(SPEC_MODE, "utf8").split("\n").find((l) => l.startsWith('core="${PI_CODING_AGENT_DIR'));
  assert.ok(coreLine);
  assert.equal(BLOCKS.length, 3, "the preflight, the preview and the approved write");
  assert.equal(BLOCKS[0]!.split("\n")[0], coreLine, "the same $core line, never a guessed path");
});

test("the published recipe runs as written: the preflight resolves an ancestor base and lists the change, the preview writes nothing, and the approved write binds the declared base with no snapshot or attribution", () => {
  const R = join(tmp, "project");
  write(R, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§app/rule": { kind: "behavior", requires: [], authority: "accepted", evidence: "verified", code: ["lib/rule.js"] },
  } }));
  write(R, ".sova/spec/claims/app/rule.md", "# §app/rule\n\nMeter fill warns at ≥80%.\n");
  write(R, "lib/rule.js", "export const threshold = 80;\n");
  write(R, ".gitignore", ".sova/spec/assessments/\n.sova/spec/drafts/\n");
  git(R, "init");
  git(R, "add", ".");
  git(R, "commit", "-m", "baseline");
  const B = git(R, "rev-parse", "HEAD");
  git(R, "checkout", "-q", "-b", "side");
  write(R, "lib/side.js", "1\n");
  git(R, "add", ".");
  git(R, "commit", "-qm", "side");
  git(R, "checkout", "-q", "master");
  write(R, "lib/rule.js", "export const threshold = 90;\n");
  write(R, "lib/new.js", "export const n = 1;\n");

  let r = sh(BLOCKS[0]!, { R, BASE: "master" });
  assert.deepEqual(r.out.trim().split("\n"), [R, `base ${B}`, "lib/new.js", "lib/rule.js"], r.err);
  r = sh(BLOCKS[0]!, { R, BASE: "side" });
  assert.doesNotMatch(r.out, /^base /m, "a base that isn't an ancestor of HEAD prints no base");

  const [coreLine] = BLOCKS[0]!.split("\n");
  const vars = { R, B, N: "change-review", F: "lib/rule.js", WHO: "reviewer", D: '{"decisions":[],"files":[]}' };
  r = sh(`set -e\n${coreLine}\n${BLOCKS[1]}`, vars);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).written, false);
  assert.ok(!existsSync(join(R, ".sova/spec/assessments")), "the preview writes nothing");

  const aLine = BLOCKS[1]!.split("\n")[0]!;
  r = sh(`${coreLine}\n${aLine}\n${BLOCKS[2]}`, vars);
  assert.ok(r.code === 0 || r.code === 1, r.err);
  const store = join(R, ".sova/spec/assessments/change-review");
  const packet = JSON.parse(readFileSync(join(store, "packet.json"), "utf8"));
  assert.equal(packet.query.base, B, "the declared base, not a task start");
  assert.deepEqual(packet.query.paths, ["lib/rule.js"], "only the scoped file");
  assert.deepEqual(packet.query.baseline, { inputs: [] }, "no declared snapshot");
  assert.ok(Object.values(packet.attribution).every((v) => v === null), "attribution stays null");
  assert.equal(JSON.parse(readFileSync(join(store, "record.json"), "utf8")).by, "reviewer");
});
