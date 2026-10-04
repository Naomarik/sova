// The Spec review playbook (playbooks/spec-review, §tools.spec/review-playbook): it is operator-run
// (no schedule), its entry names every ceiling and report section its driver checks, and the driver
// refuses an incomplete brief, collects only inside a frozen one, stops at its ceilings, writes a
// receipt only after a preview within the byte ceiling, and expires only its own run folders. On
// throwaway repositories and agent dirs only; the spec tools are the repo's canonical copies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error: a plain .mjs script, no types
import * as sr from "../playbooks/spec-review/scripts/spec-review.mjs";

const PLAYBOOK = fileURLToPath(new URL("../playbooks/spec-review/", import.meta.url));
const SCRIPT = join(PLAYBOOK, "scripts", "spec-review.mjs");
const CORE = fileURLToPath(new URL("../pi-config/extensions/spec/core", import.meta.url));

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "spec-review-playbook-")));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (label: string) => {
  const d = join(tmp, `${label}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const write = (root: string, p: string, s: string) => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), s);
};
const git = (root: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=master", "-C", root, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A project with a two-claim spec, committed; returns its root and the base commit. */
function project() {
  const root = fresh("project");
  write(root, ".sova/spec/manifest.json", JSON.stringify({ formatVersion: 1, boundary: { include: ["lib"], exclude: [] }, claims: {
    "§app/rule": { kind: "behavior", requires: [], authority: "accepted", evidence: "verified", code: ["lib/rule.js"] },
    "§other/rule": { kind: "behavior", requires: [], authority: "accepted", evidence: "verified", code: ["lib/other.js"] },
  } }));
  write(root, ".sova/spec/claims/app/rule.md", "# §app/rule\n\nMeter fill warns at ≥80%.\n");
  write(root, ".sova/spec/claims/other/rule.md", "# §other/rule\n\nOther promise.\n");
  write(root, "lib/rule.js", "export const threshold = 80;\n");
  write(root, "lib/other.js", "export const other = 1;\n");
  write(root, ".gitignore", ".sova/spec/assessments/\n.sova/spec/drafts/\n");
  git(root, "init");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

/** An agent dir whose spec core is the given directory (the canonical one unless a stand-in). */
function agent(core = CORE) {
  const a = fresh("agent");
  mkdirSync(join(a, "extensions", "spec"), { recursive: true });
  symlinkSync(core, join(a, "extensions", "spec", "core"));
  return a;
}
/** A stand-in core: sova-spec.mjs burns CPU or sleeps as STUB_* says, then prints a fixed census. */
function stubCore() {
  const c = fresh("stub-core");
  write(c, "sova-spec.mjs", `const burn = Number(process.env.STUB_BURN_MS || 0), sleep = Number(process.env.STUB_SLEEP_MS || 0);
const until = Date.now() + burn; while (Date.now() < until) Math.sqrt(Math.random());
if (sleep) await new Promise((r) => setTimeout(r, sleep));
process.stdout.write(JSON.stringify({ tool: "sova-spec", exit: 0, census: { claimed: [] } }) + "\\n");\n`);
  return c;
}

const runCli = (agentDir: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", input: opts.input, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...opts.env }, timeout: 120_000 });
  assert.ifError(r.error);
  return { code: r.status, out: r.stdout + r.stderr };
};
const limits = (o: Record<string, string> = {}) => {
  const v = { minutes: "20", "report-chars": "4000", "cpu-seconds": "120", "write-bytes": "0", "model-runs": "0", tokens: "200000", "retain-days": "7", ...o };
  return Object.entries(v).flatMap(([k, x]) => [`--${k}`, x]);
};
const brief = (root: string, base: string, extra: string[] = [], o: Record<string, string> = {}) => ["--question", "Does lib/rule.js still match §app/rule?", "--kind", "assess", "--root", root, "--base", base, ...extra, ...limits(o)];
const runsDir = (a: string) => join(a, "sova", "playbooks", "spec-review", "runs");
/** plan --write; returns the run id. */
const freeze = (a: string, args: string[]) => {
  const r = runCli(a, ["plan", ...args, "--write"]);
  assert.equal(r.code, 0, r.out);
  const id = /run (sr-\d{14}-[a-f0-9]{4})/.exec(r.out)?.[1];
  assert.ok(id, r.out);
  return id!;
};
const ledger = (a: string, id: string) => readFileSync(join(runsDir(a), id, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const setBrief = (a: string, id: string, patch: Record<string, unknown>) => {
  const p = join(runsDir(a), id, "brief.json");
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), ...patch }));
};

test("the playbook is operator-run: catalog entry with title, description and hint, and no schedule or standing profile", async () => {
  const { listPlaybooks, parseFrontmatter } = await import("./playbooks");
  const cat = await listPlaybooks(undefined, { userDir: join(fresh("nouser"), "absent") });
  const p = cat.playbooks.find((x) => x.id === "spec-review");
  assert.ok(p, "spec-review is shipped");
  assert.equal(p.title, "Spec review");
  assert.ok(p.description.length > 0 && (p.promptHint?.length ?? 0) > 0);
  assert.equal(p.schedule, undefined, "no schedule");
  const { fields } = parseFrontmatter(readFileSync(join(PLAYBOOK, "PLAYBOOK.md"), "utf8"));
  assert.deepEqual(Object.keys(fields).sort(), ["description", "promptHint", "title"], "only the dialog's keys: no when, profile, tz or task");
});

test("PLAYBOOK.md names every ceiling and report section the driver checks, and no retired tool", () => {
  const doc = readFileSync(join(PLAYBOOK, "PLAYBOOK.md"), "utf8");
  for (const k of Object.keys(sr.LIMITS)) assert.ok(doc.includes(`--${k}`), `--${k}`);
  for (const s of sr.REPORT_SECTIONS) assert.ok(doc.includes(`\`## ${s}\``), `## ${s}`);
  for (const t of ["Observed:", "Inferred:", "Proposed:"]) assert.ok(doc.includes(`\`${t}\``), t);
  assert.doesNotMatch(doc, /spec_assess|--baseline-json|--attribution-json/);
});

test("plan refuses a brief missing anything, one problem per flag, and writes nothing", () => {
  const a = agent();
  const r = runCli(a, ["plan"]);
  assert.equal(r.code, 1, r.out);
  for (const k of ["question", "kind", "root", "base", ...Object.keys(sr.LIMITS)]) assert.match(r.out, new RegExp(`problem: --${k}: missing`), k);
  assert.match(r.out, /problem: scope: missing/);
  assert.ok(!existsSync(runsDir(a)), "nothing written");
});

test("plan: a base that isn't an ancestor of HEAD, a subfolder root, an assess with sessions and a ceiling out of range are each refused; a folder that isn't git couldn't be checked", () => {
  const { root, base } = project();
  const a = agent();
  git(root, "checkout", "-q", "-b", "side");
  write(root, "lib/rule.js", "export const threshold = 85;\n");
  git(root, "commit", "-qam", "side");
  const side = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "master");
  let r = runCli(a, ["plan", ...brief(root, side, ["--id", "§app/rule"])]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--base .*: not an ancestor of HEAD/);
  r = runCli(a, ["plan", ...brief(join(root, "lib"), base, ["--id", "§app/rule"])]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--root: the checkout's top level/);
  r = runCli(a, ["plan", ...brief(root, base, ["--session", "abc"], { "write-bytes": "99999999999" })]);
  assert.equal(r.code, 1);
  assert.match(r.out, /--session: only a retro/);
  assert.match(r.out, /--write-bytes: a whole number/);
  r = runCli(a, ["plan", ...brief(fresh("not-git"), base, ["--id", "§app/rule"])]);
  assert.equal(r.code, 2, r.out);
  assert.ok(!existsSync(runsDir(a)));
});

test("plan previews without writing; --write freezes the brief with its deadline and retention", () => {
  const { root, base } = project();
  const a = agent();
  write(root, "lib/rule.js", "export const threshold = 90;\n");
  const pre = runCli(a, ["plan", ...brief(root, base, ["--changed"])]);
  assert.equal(pre.code, 0, pre.out);
  assert.match(pre.out, /preview: nothing written/);
  assert.ok(!existsSync(runsDir(a)));
  const id = freeze(a, brief(root, base, ["--changed"]));
  const b = JSON.parse(readFileSync(join(runsDir(a), id, "brief.json"), "utf8"));
  assert.equal(b.base, base);
  assert.deepEqual(b.scope.changed, ["lib/rule.js"], "changed since base, frozen at plan");
  assert.equal(Date.parse(b.deadline) - Date.parse(b.createdAt), 20 * 60_000);
  assert.equal(Date.parse(b.expiresAt) - Date.parse(b.deadline), 7 * 86_400_000);
  assert.equal(lstatSync(join(runsDir(a), id, "brief.json")).mode & 0o777, 0o600);
});

test("run: an id outside the brief is refused until this run's census surfaces it; paths outside the scope are refused", () => {
  const { root, base } = project();
  const a = agent();
  write(root, "lib/rule.js", "export const threshold = 90;\n");
  write(root, "lib/other.js", "export const other = 2;\n");
  const id = freeze(a, brief(root, base, ["--path", "lib/rule.js"]));
  let r = runCli(a, ["run", id, "spec", "packet", "§app/rule"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /refused: §app\/rule is outside this run's scope/);
  r = runCli(a, ["run", id, "spec", "census"]);
  assert.ok(r.code === 0 || r.code === 1, r.out);
  assert.deepEqual(ledger(a, id).at(-1).surfaced, ["§app/rule"], "only the claims of in-scope changed files");
  r = runCli(a, ["run", id, "spec", "packet", "§app/rule", "--part", "prose"]);
  assert.ok(r.code === 0 || r.code === 1, r.out);
  assert.match(r.out, /Meter fill warns/);
  assert.match(runCli(a, ["run", id, "spec", "packet", "§other/rule"]).out, /refused: §other\/rule is outside/);
  assert.match(runCli(a, ["run", id, "git", "diff", "lib/other.js"]).out, /refused: lib\/other.js is outside/);
  assert.match(runCli(a, ["run", id, "git", "diff", "../x"]).out, /refused/);
  r = runCli(a, ["run", id, "git", "stat"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /lib\/rule\.js/);
  assert.doesNotMatch(r.out, /lib\/other\.js/, "git forms carry the brief's paths");
  assert.match(runCli(a, ["run", id, "spec", "census", "--base", "HEAD"]).out, /refused: spec census takes no arguments/);
  assert.match(runCli(a, ["run", id, "sh", "-c", "true"]).out, /refused: sh: not a form/);
  assert.equal(ledger(a, id).filter((e) => e.refused).length, 6);
});

test("assess: a write needs a preview of the same query, fits the byte ceiling, is measured, and never repeats a fingerprint", () => {
  const { root, base } = project();
  const a = agent();
  write(root, "lib/rule.js", "export const threshold = 90;\n");
  const id = freeze(a, brief(root, base, ["--changed"], { "write-bytes": "200000" }));
  let r = runCli(a, ["run", id, "assess", "prepare", "one", "--write"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /preview the same query first/);
  assert.match(runCli(a, ["run", id, "assess", "prepare", "one", "--baseline-json", "{}"]).out, /--baseline-json isn't allowed/);
  r = runCli(a, ["run", id, "assess", "prepare", "one"]);
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(root, ".sova/spec/assessments")), "a preview writes nothing");
  r = runCli(a, ["run", id, "assess", "prepare", "one", "--write"]);
  assert.equal(r.code, 0, r.out);
  const name = `${id}-one`;
  const bytes = lstatSync(join(root, ".sova/spec/assessments", name, "packet.json")).size;
  const w = ledger(a, id).at(-1);
  assert.equal(w.written.name, name);
  assert.equal(w.wroteBytes, bytes, "measured, not estimated");
  const packet = JSON.parse(readFileSync(join(root, ".sova/spec/assessments", name, "packet.json"), "utf8"));
  assert.equal(packet.query.base, base, "the brief's base");
  assert.deepEqual(packet.query.baseline, { inputs: [] }, "no declared snapshot");
  assert.ok(Object.values(packet.attribution).every((v) => v === null), "attribution stays null");
  r = runCli(a, ["run", id, "assess", "prepare", "two", "--write"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /already wrote a receipt with that fingerprint/);
  r = runCli(a, ["run", id, "assess", "status", "one"]);
  assert.ok(r.code === 0 || r.code === 1, r.out);
  assert.match(runCli(a, ["run", id, "assess", "status", "elsewhere"]).out, /not a receipt this run wrote/);
  const s = JSON.parse(runCli(a, ["status", id, "--json"]).out);
  assert.equal(s.wroteBytes, bytes);
  assert.deepEqual(s.receipts.map((x: { name: string }) => x.name), [name]);
});

test("assess: a preview bigger than the bytes left is refused as a ceiling, and nothing is written", () => {
  const { root, base } = project();
  const a = agent();
  write(root, "lib/rule.js", "export const threshold = 90;\n");
  const id = freeze(a, brief(root, base, ["--changed"], { "write-bytes": "0" }));
  assert.equal(runCli(a, ["run", id, "assess", "prepare", "big"]).code, 0);
  const r = runCli(a, ["run", id, "assess", "prepare", "big", "--write"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /refused: the preview was \d+ bytes and 0 of the write ceiling are left; narrow the query/);
  assert.ok(!existsSync(join(root, ".sova/spec/assessments")));
});

test("retro: assessment forms are refused, and sessions are scope only a retro takes", () => {
  const { root, base } = project();
  const a = agent();
  const id = freeze(a, ["--question", "How did the spec work go?", "--kind", "retro", "--root", root, "--base", base, "--session", "s-1", ...limits()]);
  const r = runCli(a, ["run", id, "assess", "prepare", "x"]);
  assert.equal(r.code, 2);
  assert.match(r.out, /belong to an assess run/);
  assert.equal(runCli(a, ["run", id, "git", "log"]).code, 0);
});

test("ceilings: CPU spent stops the next call; the deadline stops a call in flight and every later one", () => {
  const { root, base } = project();
  const a = agent(stubCore());
  const id = freeze(a, brief(root, base, ["--changed"], { "cpu-seconds": "1" }));
  let r = runCli(a, ["run", id, "spec", "census"], { env: { STUB_BURN_MS: "1300" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /reached: cpu/);
  r = runCli(a, ["run", id, "spec", "census"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^stop: ceiling cpu reached/m);
  assert.deepEqual(ledger(a, id).at(-1).ceiling, ["cpu"]);

  const id2 = freeze(a, brief(root, base, ["--changed"]));
  setBrief(a, id2, { deadline: new Date(Date.now() + 1500).toISOString() });
  r = runCli(a, ["run", id2, "spec", "census"], { env: { STUB_SLEEP_MS: "20000" } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /stop: ceiling time reached while this ran/);
  assert.equal(ledger(a, id2).at(-1).timedOut, true);
  r = runCli(a, ["run", id2, "spec", "census"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^stop: ceiling time reached/m);
  assert.equal(runCli(a, ["status", id2]).code, 1);
});

test("report: length, the fixed sections in order and tagged findings are checked; a passing report is kept in the run folder", () => {
  const ok = ["## Question", "q", "## Findings", "- Observed: lib/rule.js:1 says 90 (ledger #2)", "- Proposed: amend §app/rule; settles with the meter test", "## Unknown", "u", "## Coverage", "c", "## Cost", "c", "## Method proposals", "None.", "## Stopped because", "answered", ""].join("\n");
  assert.deepEqual(sr.checkReport(ok, 4000), []);
  assert.match(sr.checkReport(ok, 100).join("\n"), /over the brief's 100/);
  assert.match(sr.checkReport(ok.replace("## Unknown\nu\n", ""), 4000).join("\n"), /missing sections: ## Unknown/);
  assert.match(sr.checkReport(ok.replace("- Observed:", "- Saw"), 4000).join("\n"), /starts with none of/);
  assert.deepEqual(sr.checkReport(ok.replace(/- Observed[^\n]*\n- Proposed[^\n]*/, "None."), 4000), []);
  const { root, base } = project();
  const a = agent();
  const id = freeze(a, brief(root, base, ["--id", "§app/rule"]));
  assert.equal(runCli(a, ["report", id], { input: "## Question\nonly this" }).code, 1);
  assert.ok(!existsSync(join(runsDir(a), id, "report.md")));
  assert.equal(runCli(a, ["report", id], { input: ok }).code, 0);
  assert.equal(readFileSync(join(runsDir(a), id, "report.md"), "utf8"), ok);
});

test("expire: previews by default, removes only its own expired run folders, skips anything else, and never touches receipts", () => {
  const { root, base } = project();
  const a = agent();
  write(root, "lib/rule.js", "export const threshold = 90;\n");
  const old = freeze(a, brief(root, base, ["--changed"], { "write-bytes": "200000", "retain-days": "0" }));
  runCli(a, ["run", old, "assess", "prepare", "keep"]);
  assert.equal(runCli(a, ["run", old, "assess", "prepare", "keep", "--write"]).code, 0);
  setBrief(a, old, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const live = freeze(a, brief(root, base, ["--changed"]));
  const odd = freeze(a, brief(root, base, ["--changed"]));
  setBrief(a, odd, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  writeFileSync(join(runsDir(a), odd, "notes.txt"), "someone else's");
  const elsewhere = fresh("elsewhere");
  symlinkSync(elsewhere, join(runsDir(a), "sr-20200101000000-abcd"));

  let r = runCli(a, ["expire"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`would remove: ${old}`));
  assert.match(r.out, new RegExp(`skipped: ${odd} · notes.txt isn't the driver's own`));
  assert.match(r.out, /skipped: sr-20200101000000-abcd · not a plain directory/);
  assert.ok(existsSync(join(runsDir(a), old)), "a preview removes nothing");
  r = runCli(a, ["expire", "--write"]);
  assert.match(r.out, new RegExp(`removed: ${old}`));
  assert.deepEqual(readdirSync(runsDir(a)).sort(), [live, odd, "sr-20200101000000-abcd"].sort());
  assert.ok(existsSync(join(elsewhere)), "the symlink's target is untouched");
  assert.ok(existsSync(join(root, ".sova/spec/assessments", `${old}-keep`, "packet.json")), "the receipt stays");
});
