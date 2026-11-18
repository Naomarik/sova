import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratchRoot } from "./test-scratch";

/**
 * The A/B cycle's commands as a campaign runs them (playbooks/ab-cycle/scripts: runner, score, chart, record), on a
 * made-up campaign in a scratch project whose arms are shell commands that print fixed replies: no model, no cost.
 * The counting, the check and the arm rule are covered in-process by ab-cycle-scripts.test.ts; this file holds what
 * needs the processes: the files they write, what they print and their exit codes.
 */

const script = (name: string) => fileURLToPath(new URL(`../playbooks/ab-cycle/scripts/${name}.mjs`, import.meta.url));
const root = scratchRoot("ab-cycle-int-");
after(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=master", "-c", "commit.gpgSign=false", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const run = (name: string, ...a: string[]) => spawnSync(process.execPath, [script(name), ...a], { cwd: root, encoding: "utf8" });
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const put = (p: string, v: unknown) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`);
};

// The project: a repository whose master holds the text under test, and one experiment commit that changes it.
const project = join(root, "project");
mkdirSync(project, { recursive: true });
git(project, "init", "-q");
put(join(project, "tool.txt"), "Draws a chart.\nRead the guide when unsure.\n");
git(project, "add", "tool.txt");
git(project, "commit", "-qm", "base");
const master = git(project, "rev-parse", "HEAD");
put(join(project, "tool.txt"), "Draws a chart.\nRead the guide first.\n");
git(project, "commit", "-qam", "guide first (experiment, never lands)");
const changed = git(project, "rev-parse", "HEAD");

// The campaign, in the project's ignored cache; each arm runs in a folder of its own outside the project.
const campaign = join(project, ".cache", "ab", "demo");
const record = join(project, ".sova", "ab", "vis-demo.jsonl");
const armDir = (a: string) => {
  const d = join(root, "arms", a);
  mkdirSync(d, { recursive: true });
  return d;
};
const PROMPT = "Please draw the monthly revenue for the northern region as a stacked bar chart";
put(join(campaign, "campaign.json"), { subject: "Does it read the guide first?", record: "vis-demo", testModels: [{ model: "fake/one", effort: "low" }], parallel: 2, timeoutSec: 20 });
put(
  join(campaign, "cases.jsonl"),
  [
    { id: "f01", group: "fail", prompt: PROMPT, expect: "Reads the guide", check: { contains: "guide" } },
    { id: "f02", group: "fail", prompt: "Chart the weekly sign-ups", expect: "Reads the guide", check: { contains: "guide" } },
    { id: "f03", group: "fail", prompt: "Plot the error rate", expect: "Reads the guide", check: { contains: "guide" } },
    { id: "p01", group: "pass", prompt: "Say hello", expect: "Doesn't break", check: { not: { contains: "broken" } } },
    { id: "p02", group: "pass", prompt: "Say goodbye", expect: "Doesn't break", check: { not: { contains: "broken" } } },
    { id: "s01", group: "sealed", prompt: "Held back", expect: "Reads the guide", check: { contains: "guide" } },
  ]
    .map((k) => JSON.stringify(k))
    .join("\n") + "\n",
);
// B fixes f01 and f02, leaves f03 and breaks p02; it expected f01 and f03, and thought p01 at risk.
const B_REPLIES = "case {case} in f01|f02) echo 'I read the guide';; p02) echo 'broken';; *) echo 'plain';; esac";
const arms0 = { A: { label: "master", baseline: true, how: "command", command: "echo plain", cwd: armDir("A"), ref: master } };
const arms1 = {
  B: { label: "guide first", change: "Tells it to read the guide first", base: master, ref: changed, how: "command", command: B_REPLIES, cwd: armDir("B"), url: "http://127.0.0.1:4814", agentDir: join(armDir("B"), ".agent"), problem: "skips the guide before drawing", why: "A rule that says when unsure is read as optional", expectFix: ["f01", "f03"], mayBreak: ["p01"], knobs: ["wording"] },
  C: { label: "no change", change: "Rewords nothing that matters", base: master, ref: master, how: "command", command: "echo plain", cwd: armDir("C"), problem: "skips the guide before drawing", why: "A control with the same text" },
};
put(join(campaign, "rounds", "0", "arms.json"), arms0);
put(join(campaign, "rounds", "1", "arms.json"), arms1);
const lines = () => readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a round is run, scored and charted with each arm's prediction beside what it did, and the record gains a line per attempt, the losing one too", () => {
  for (const n of ["0", "1"]) {
    const r = run("runner", campaign, "--round", n);
    assert.equal(r.status, 0, r.stderr);
    const s = run("score", campaign, "--round", n);
    assert.equal(s.status, 0, s.stderr);
    if (n === "1") {
      assert.match(s.stdout, /^B predicted vs observed: expected to fix 2: 1 fixed, 1 not; 1 fixed without being expected; at risk 1: 0 broken; 1 broken without being expected$/m);
      assert.match(s.stdout, /^C stated no prediction: 0 fixed, 0 broken$/m);
      assert.match(s.stdout, /^best: B$/m, "picked by pass rate, whatever the prediction did");
    }
  }
  const scores = json(join(campaign, "rounds", "1", "scores.json"));
  const p = scores.arms.B.prediction;
  assert.deepEqual([p.base, p.fixedExpected.ids, p.notFixed.ids, p.fixedUnexpected.ids, p.brokeExpected.ids, p.brokeUnexpected.ids, p.missing.n], [{ round: 0, arm: "A" }, ["f01"], ["f03"], ["f02"], [], ["p02"], 0]);
  assert.equal(scores.arms.A, undefined, "round 1 runs its candidates only");
  assert.equal(json(join(campaign, "rounds", "0", "scores.json")).arms.A.prediction, undefined, "master states none");
  const row = readFileSync(join(campaign, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.round === 1);
  assert.deepEqual(row.arms.B.prediction, { stated: true, problem: "skips the guide before drawing", expectFix: 2, mayBreak: 1, fixedExpected: 1, notFixed: 1, fixedUnexpected: 1, brokeExpected: 0, brokeUnexpected: 1, missing: 0 });

  const chart = run("chart", campaign, "--round", "1");
  assert.equal(chart.status, 0, chart.stderr);
  assert.match(chart.stdout, /^\| B \| skips the guide before drawing \| 2 cases \| 1 of 2 \| 1 \| 1 case \| 0 \| 1 \|$/m);
  assert.match(chart.stdout, /^\| C \| no prediction stated \| - \| - \| 0 \| - \| - \| 0 \|$/m);
  assert.equal(readFileSync(join(campaign, "rounds", "1", "chart.md"), "utf8"), chart.stdout);
  const sample = run("chart", campaign, "--sample");
  assert.match(sample.stdout, /\*\*Predicted vs observed\*\*[\s\S]*no prediction stated/, "the first stop shows a made-up one");

  assert.match(run("record", "show", "vis-demo", "--project", project).stdout, /^No record named vis-demo yet: this campaign starts it\.$/m);
  const add = run("record", "add", campaign, "--round", "1", "--outcome", "carried", "--note", "beat the noise");
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /vis-demo\.jsonl: B carried, C dropped \(round 1 of demo\)/);
  const [b, c] = lines();
  assert.deepEqual(
    { ...b, date: "" },
    {
      v: 1,
      kind: "attempt",
      date: "",
      campaign: "demo",
      round: 1,
      arm: "B",
      problem: "skips the guide before drawing",
      change: "Tells it to read the guide first",
      why: "A rule that says when unsure is read as optional",
      text: "tool.txt\n- Read the guide when unsure.\n+ Read the guide first.",
      knobs: ["wording"],
      models: [{ model: "fake/one", effort: "low", cases: 5, base: 40, arm: 60 }],
      all: { base: 40, arm: 60 },
      predicted: { fix: 2, risk: 1 },
      observed: { fixedExpected: 1, notFixed: 1, fixedUnexpected: 1, brokeExpected: 0, brokeUnexpected: 1 },
      outcome: "carried",
      note: "beat the noise",
    },
  );
  assert.deepEqual([c.arm, c.outcome, c.predicted, c.all, c.text, c.files], ["C", "dropped", null, { base: 40, arm: 40 }, undefined, undefined]);
  const written = readFileSync(record, "utf8");
  for (const leak of [root, "127.0.0.1", ".agent", "f01", "p01", PROMPT, "I read the guide"]) assert.ok(!written.includes(leak), `${leak} is not in the record`);

  const again = run("record", "add", campaign, "--round", "1", "--outcome", "dropped");
  assert.equal(again.status, 3);
  assert.match(again.stderr, /round 1 of demo is already in the record \(2 lines\): --replace rewrites them/);
  assert.equal(run("record", "add", campaign, "--round", "1", "--outcome", "dropped", "--replace").status, 0);
  assert.deepEqual(lines().map((l) => [l.arm, l.outcome]), [["B", "dropped"], ["C", "dropped"]]);

  const close = run("record", "close", campaign, "--verdict", "park", "--note", "no arm beat the noise twice");
  assert.equal(close.status, 0, close.stderr);
  assert.deepEqual({ ...lines()[2], date: "" }, { v: 1, kind: "close", date: "", campaign: "demo", verdict: "park", master, rounds: 1, note: "no arm beat the noise twice" });
  const show = run("record", "show", "vis-demo", "--project", project);
  assert.match(show.stdout, /^vis-demo: 2 attempts in 1 campaign, 0 carried, 0 made it worse\.$/m);
  assert.match(show.stdout, /^### skips the guide before drawing$/m);
  assert.match(run("record", "show", "--project", project).stdout, /^- vis-demo: 2 attempts in 1 campaign, 0 carried, 0 made it worse$/m);
  const check = run("record", "check", "--campaign", campaign);
  assert.equal(check.status, 0, check.stderr);
});

test("the commands refuse, and write nothing: a line repeating a case, a prediction naming a sealed case, an arm that still holds the record", () => {
  const before = readFileSync(record, "utf8");
  // A reason that repeats a case's words: add stops at exit 1 naming the field.
  put(join(campaign, "rounds", "1", "arms.json"), { ...arms1, C: { ...arms1.C, why: `It was asked: ${PROMPT.toLowerCase()}` } });
  const leak = run("record", "add", campaign, "--round", "1", "--outcome", "dropped", "--replace");
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /round 1, arm C isn't written:\n {2}why holds 8 or more words in a row from a case or a saved reply/);
  assert.equal(readFileSync(record, "utf8"), before);
  // The same words planted in the record by hand: check finds them against the campaign.
  writeFileSync(record, `${before}${JSON.stringify({ ...lines()[1], note: PROMPT })}\n`);
  const check = run("record", "check", "vis-demo", "--campaign", campaign);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /vis-demo\.jsonl:4: note holds 8 or more words in a row from a case or a saved reply/);
  writeFileSync(record, before);

  // A prediction naming a sealed case stops the scorer and the runner.
  put(join(campaign, "rounds", "1", "arms.json"), { ...arms1, B: { ...arms1.B, expectFix: ["f01", "s01"] } });
  for (const r of [run("score", "total", campaign, "--round", "1"), run("runner", campaign, "--round", "1")]) {
    assert.equal(r.status, 3);
    assert.match(r.stderr, /arm B: expectFix names s01, a sealed case/);
  }
  put(join(campaign, "rounds", "1", "arms.json"), arms1);

  // An arm whose folder holds the record: the round doesn't start, and nothing new is run.
  put(join(campaign, "rounds", "2", "arms.json"), { B: { ...arms1.B, cwd: armDir("B2") }, D: { ...arms1.C, cwd: armDir("D") } });
  put(join(armDir("D"), ".sova", "ab", "vis-demo.jsonl"), before);
  const held = run("runner", campaign, "--round", "2");
  assert.equal(held.status, 3);
  assert.match(held.stderr, /round 2 doesn't start:\narm D: .*\.sova[/\\]ab is there for its test chats to read/);
  assert.ok(!/arm B:/.test(held.stderr), "only the arm that holds it is named");
  assert.equal(existsSync(join(campaign, "rounds", "2", "results")), false);
  rmSync(join(armDir("D"), ".sova"), { recursive: true });
  assert.equal(run("runner", campaign, "--round", "2").status, 0, "removed in the arm, the round runs");
  // Master's arm in the campaign's own worktree, where the record is written.
  put(join(campaign, "rounds", "3", "arms.json"), { A: { ...arms0.A, cwd: project } });
  const own = run("runner", campaign, "--round", "3");
  assert.equal(own.status, 3);
  assert.match(own.stderr, /arm A: .* is inside the campaign's own worktree, where the record is written/);
});
