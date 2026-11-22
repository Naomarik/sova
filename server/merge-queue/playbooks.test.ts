// Run: pnpm test server/merge-queue/playbooks.test.ts
// The merge thread's playbooks and the review kit as files: the conflict-hunks parser, the review verdict's
// shape, the shipped profile, and the guard that the review kit is never a registered skill.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { excludedTools, profileFileError } from "../../shared/profiles";
import { findProfile } from "../profile-sources";
// @ts-expect-error: a plain .mjs script of the playbook, typed by use here
import { hunksOf } from "../../system-playbooks/merge-queue/scripts/conflict-hunks.mjs";
import { checkReviewText, FINDING_MAX, MAX_FINDINGS, REVIEW_KINDS as KINDS } from "./review-verdict";
import { reviewerText } from "./review-step";

const REPO = join(import.meta.dirname, "..", "..");

test("conflict hunks: diff3 and plain markers, several per file, base null without diff3", () => {
  const text = ["a", "<<<<<<< HEAD", "ours1", "||||||| base", "b0", "=======", "theirs1", ">>>>>>> master", "mid", "<<<<<<< HEAD", "o2", "=======", "t2", "t2b", ">>>>>>> master", "end"].join("\n");
  assert.deepEqual(hunksOf(text), [
    { line: 2, ours: ["ours1"], base: ["b0"], theirs: ["theirs1"] },
    { line: 10, ours: ["o2"], base: null, theirs: ["t2", "t2b"] },
  ]);
  assert.deepEqual(hunksOf("no markers\n======= alone\n"), []);
});

test("review verdict (merge.review's check): ok carries no findings, notes and blocking need one, kinds and lines checked, at most ten", () => {
  const ok = (v: "ok" | "notes" | "blocking", t?: string) => checkReviewText(v, t);
  assert.deepEqual(ok("ok"), { text: "", summary: "", findings: [] }, "ok may say nothing");
  assert.deepEqual(ok("ok", " Fine. "), { text: "Fine.", summary: "Fine.", findings: [] });
  assert.deepEqual(ok("notes", " One note.\n\n- [dead-code] server/x.ts:3: unused export "), {
    text: "One note.\n- [dead-code] server/x.ts:3: unused export",
    summary: "One note.",
    findings: [{ kind: "dead-code", file: "server/x.ts", line: 3, text: "unused export" }],
  });
  assert.deepEqual((ok("notes", "N.\n- [missing-test] no test for the empty case") as { findings: unknown[] }).findings, [{ kind: "missing-test", text: "no test for the empty case" }]);
  assert.deepEqual((ok("notes", "N.\n- [naming] a.ts: x says nothing") as { findings: unknown[] }).findings, [{ kind: "naming", file: "a.ts", text: "x says nothing" }]);
  const why = (r: ReturnType<typeof checkReviewText>) => ("why" in r ? r.why : "accepted");
  assert.match(why(ok("ok", "Fine.\n- [hack] a.ts:1: x")), /no findings/);
  assert.match(why(ok("blocking", "Bad.")), /at least one finding/);
  assert.match(why(ok("notes")), /needs a one-sentence summary/);
  assert.match(why(ok("notes", "- [hack] a.ts:1: x")), /starts with its summary/);
  assert.match(why(ok("notes", "x".repeat(301) + "\n- [hack] y")), /summary must be at most 300/);
  assert.match(why(ok("notes", "S.\n- [style] a.ts:1: tabs")), /kind must be one of/);
  assert.match(why(ok("notes", "S.\n- [hack] a.ts:0: x")), /line must be a positive/);
  assert.match(why(ok("notes", "S.\n- [hack]")), /must read/);
  assert.match(why(ok("notes", "S.\nloose words")), /must read "- \[kind\]/);
  assert.match(why(ok("notes", "S.\n- [hack] " + "y".repeat(401))), /at most 400/);
  assert.match(why(ok("notes", ["S.", ...Array(11).fill("- [other] f.ts: y")].join("\n"))), /at most 10/);
  assert.deepEqual(KINDS, ["dead-code", "duplication", "hack", "missing-test", "naming", "other"]);
});

test("review text as kept at the format's maximum: whole, every finding parsed, nothing cut", () => {
  const lines = ["s", ...Array.from({ length: MAX_FINDINGS }, (_, i) => `- [other] f${i}.ts:${i + 1}: ${String(i).repeat(FINDING_MAX)}`)];
  const long = checkReviewText("blocking", lines.join("\n")) as { text: string; summary: string; findings: { file?: string; line?: number; text: string }[] };
  assert.equal(long.text, lines.join("\n"));
  assert.equal(long.summary, "s");
  assert.equal(long.findings.length, MAX_FINDINGS);
  assert.deepEqual(long.findings.at(-1), { kind: "other", file: "f9.ts", line: 10, text: "9".repeat(FINDING_MAX) });
});

test("the reviewer's first message names the change Sova wrote for it, says it has no shell, and gives the verdict's format", () => {
  const o = { runId: "mr_1", projectId: "p", root: "/p", copy: "/copy", base: "b".repeat(40), commit: "a".repeat(40), branch: "feat/x", kit: ".sova/playbooks/review", change: { summary: "/run/review/change.txt", diff: "/run/review/change.diff" } };
  const text = reviewerText(o, "master");
  assert.ok(text.includes("/run/review/change.txt") && text.includes("/run/review/change.diff"));
  assert.match(text, /you have no shell/);
  assert.match(text, /- \[kind\] file:line: text/);
  for (const kind of KINDS) assert.ok(text.includes(kind), kind);
  assert.doesNotMatch(text, /git show|verdict\.mjs/, "nothing it would need a shell for");
});

test("the review kit is never a registered skill: not under a skills folder, not in pi's skill settings", () => {
  const kit = join(REPO, ".sova", "playbook-config", "review");
  assert.ok(existsSync(join(kit, "PLAYBOOK.md")) && existsSync(join(kit, "references", "checklist.md")));
  assert.ok(!existsSync(join(kit, "SKILL.md")), "a SKILL.md would make it loadable as a skill");
  for (const dir of [".agents/skills", ".pi/skills", "pi-config/skills"]) {
    const d = join(REPO, dir);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) assert.ok(!/review/i.test(name) || !readFileSync(join(d, name, "SKILL.md"), "utf8").includes("Review kit"), `${dir}/${name} carries the review kit`);
  }
  const settings = join(REPO, ".pi", "settings.json");
  if (existsSync(settings)) assert.doesNotMatch(readFileSync(settings, "utf8"), /playbooks\/review/);
  // Every point of the simple review is in its checklist.
  const checklist = readFileSync(join(kit, "references", "checklist.md"), "utf8");
  for (const kind of KINDS) assert.match(checklist, new RegExp(`\\[${kind}\\]`));
});

test("the merge-reviewer profile ships with Sova, read only: no shell, edit tools, web, workers, timers or worktrees", async () => {
  const raw = JSON.parse(readFileSync(join(REPO, "profiles", "system", "merge-reviewer.json"), "utf8"));
  assert.equal(profileFileError(raw), null);
  assert.equal((await findProfile({ source: "sova", id: "merge-reviewer" }, null))?.id, "merge-reviewer");
  assert.deepEqual([...raw.remove].sort(), ["edit", "mcp", "shell", "timers", "web", "workers", "worktrees"]);
  // What that removes: bash and background jobs with the shell, edit and write with the edit tools.
  const gone = excludedTools(raw.remove, ["read", "bash", "edit", "write", "background_job", "grep", "find", "ls"]);
  for (const t of ["bash", "background_job", "edit", "write"]) assert.ok(gone.includes(t), t);
  for (const t of ["read", "grep", "find", "ls"]) assert.ok(!gone.includes(t), t);
  // The kit asks for nothing it could only run with a shell.
  const kit = join(REPO, ".sova", "playbook-config", "review");
  assert.equal(existsSync(join(kit, "scripts")), false, "the kit has no scripts: the reviewer can't run them");
  assert.doesNotMatch(readFileSync(join(kit, "PLAYBOOK.md"), "utf8"), /`(node|git|pnpm|bash) /);
  assert.deepEqual(raw.grant, []);
});

test("the merge-thread profile ships with Sova, is valid, and has no web, workers or timers", async () => {
  const raw = JSON.parse(readFileSync(join(REPO, "profiles", "system", "merge-thread.json"), "utf8"));
  assert.equal(profileFileError(raw), null);
  const listed = await findProfile({ source: "sova", id: "merge-thread" }, null);
  assert.equal(listed?.id, "merge-thread", "found by an explicit Sova pick, for every project");
  assert.equal(raw.id, "merge-thread");
  for (const r of ["web", "workers", "timers"]) assert.ok(raw.remove.includes(r));
  assert.deepEqual(raw.grant, []);
  assert.equal(raw.overseerMayStart, false);
});

test("both queue profiles name their modes outright: mode normal, no minor modes, so mode.json's default never reaches them", async () => {
  for (const id of ["merge-thread", "merge-reviewer"]) {
    const raw = JSON.parse(readFileSync(join(REPO, "profiles", "system", `${id}.json`), "utf8"));
    assert.equal(raw.mode, "normal", id);
    assert.deepEqual(raw.minorModes, [], id);
    const listed = await findProfile({ source: "sova", id }, null);
    assert.equal(listed?.mode, "normal", `${id}: the parsed profile keeps it`);
    assert.deepEqual(listed?.minorModes, [], `${id}: [] (none), not absent (inherit the default)`);
    // Memory still can't be named by a profile: the thread's keeper switches it on itself.
    assert.match(profileFileError({ ...raw, minorModes: ["memory"] }) ?? "", /memory is for chats only/);
  }
});
