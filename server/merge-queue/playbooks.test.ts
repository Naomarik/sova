// Run: pnpm test server/merge-queue/playbooks.test.ts
// The merge thread's playbooks and the review kit as files: the blast-radius rule and Sova's map (a
// path → the checks it picks, each with its reason), the conflict-hunks parser, the review verdict's
// shape, the shipped profile, and the guard that the review kit is never a registered skill.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { profileFileError } from "../../shared/profiles";
import { findProfile } from "../profile-sources";
// @ts-expect-error: plain .mjs scripts of the playbooks, typed by use here
import { blastRadius, globRe } from "../../playbooks/merge-queue/scripts/blast-radius.mjs";
// @ts-expect-error: as above
import { hunksOf } from "../../playbooks/merge-queue/scripts/conflict-hunks.mjs";
// @ts-expect-error: as above
import { KINDS, TEXT_MAX, reviewText, validate } from "../../.sova/playbooks/review/scripts/verdict.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const SOVA_MAP = JSON.parse(readFileSync(join(REPO, ".sova", "playbooks", "merge-queue", "references", "blast-radius.json"), "utf8"));
type Pick = { id: string; why: string; select?: string[] };
const picks = (paths: string[]): Pick[] => blastRadius(paths, SOVA_MAP).picks;

test("globs: ** spans folders (including none), * stays in one, ? is one character", () => {
  assert.ok(globRe("statecharts/**").test("statecharts/src/a/b.cljs"));
  assert.ok(globRe("server/**/x.ts").test("server/x.ts"));
  assert.ok(globRe("server/**/x.ts").test("server/a/b/x.ts"));
  assert.ok(globRe("src/components/Composer*.tsx").test("src/components/ComposerBar.tsx"));
  assert.ok(!globRe("src/components/Composer*.tsx").test("src/components/x/Composer.tsx"));
  assert.ok(globRe("a?.ts").test("ab.ts") && !globRe("a?.ts").test("a/.ts"));
  assert.ok(!globRe("server/chat-host*").test("server/chat-hostess/x.ts"));
  assert.ok(globRe("a.b").test("a.b") && !globRe("a.b").test("axb"), "dots are literal");
});

test("Sova's map: each area picks its check with its reason; docs alone pick nothing", () => {
  const by = (paths: string[]) => Object.fromEntries(picks(paths).map((p) => [p.id, p]));
  assert.deepEqual(picks(["docs/a.md", "README.md", ".sova/spec/drafts/x/spec/a.md"]), []);
  const charts = by(["statecharts/src/org.cljs"]);
  assert.deepEqual(Object.keys(charts), ["statecharts"]);
  assert.match(charts.statecharts!.why, /^statecharts changed.*\(statecharts\/src\/org\.cljs\)$/);
  assert.deepEqual(Object.keys(by(["pi-config/extensions/spec/core/sova-spec.mjs"])), ["spec-replay"]);
  const composer = by(["src/components/Composer.tsx"]);
  assert.deepEqual(composer.tour?.select, ["scripts/e2e/focus-view.mjs", "scripts/e2e/instant-open.mjs"]);
  assert.match(composer.tour!.why, /composer changed/);
  assert.deepEqual(by(["server/tours/browser.ts"])["integration-group"]?.select, ["tours"]);
  assert.deepEqual(by(["server/chat-runtime/host.ts"])["integration-group"]?.select, ["trial"]);
});

test("one id hit by several rules is one pick: reasons joined, selections unioned without repeats", () => {
  const p = picks(["src/components/Composer.tsx", "src/components/TranscriptView.tsx", "src/lib/focus-view.ts"]);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.id, "tour");
  assert.deepEqual(p[0]!.select, ["scripts/e2e/focus-view.mjs", "scripts/e2e/instant-open.mjs", "scripts/e2e/transcript-follow.mjs", "scripts/e2e/transcript-drift.mjs", "scripts/e2e/jump-settle.mjs"]);
  assert.match(p[0]!.why, /composer changed.*; the transcript view changed/);
  const many = blastRadius(["statecharts/a", "statecharts/b", "statecharts/c", "statecharts/d"], SOVA_MAP).picks[0];
  assert.match(many.why, /\(statecharts\/a, statecharts\/b, statecharts\/c, \+1 more\)$/);
});

test("Sova's map names only paths that exist and tours that exist", () => {
  for (const r of SOVA_MAP.rules as { pick: { id: string; select?: string[] } }[]) {
    if (r.pick.id === "tour") for (const s of r.pick.select ?? []) assert.ok(existsSync(join(REPO, s)), `${s} is not a tour`);
  }
  const groups = readFileSync(join(REPO, "scripts", "test-groups.mjs"), "utf8");
  for (const r of SOVA_MAP.rules as { pick: { id: string; select?: string[] } }[]) {
    if (r.pick.id !== "integration-group") continue;
    for (const g of r.pick.select ?? []) if (g !== "merge-queue") assert.match(groups, new RegExp(`name: "${g}"`), `no slow group ${g}`);
  }
});

test("a check that takes one selector per run is one pick per selection", () => {
  const p = picks(["server/tours/browser.ts", "server/chat-runtime/host.ts", "server/tours/checks.ts"]);
  assert.deepEqual(p.map((x) => [x.id, x.select]), [["integration-group", ["tours"]], ["integration-group", ["trial"]]]);
  assert.match(p[0]!.why, /\(server\/tours\/browser\.ts, server\/tours\/checks\.ts\)$/);
});

test("a map with no rules, or none, picks nothing", () => {
  assert.deepEqual(blastRadius(["statecharts/a"], { rules: [] }).picks, []);
  assert.deepEqual(blastRadius(["statecharts/a"], null).picks, []);
});

test("conflict hunks: diff3 and plain markers, several per file, base null without diff3", () => {
  const text = ["a", "<<<<<<< HEAD", "ours1", "||||||| base", "b0", "=======", "theirs1", ">>>>>>> master", "mid", "<<<<<<< HEAD", "o2", "=======", "t2", "t2b", ">>>>>>> master", "end"].join("\n");
  assert.deepEqual(hunksOf(text), [
    { line: 2, ours: ["ours1"], base: ["b0"], theirs: ["theirs1"] },
    { line: 10, ours: ["o2"], base: null, theirs: ["t2", "t2b"] },
  ]);
  assert.deepEqual(hunksOf("no markers\n======= alone\n"), []);
});

test("review verdict: ok carries no findings, notes and blocking need one, kinds and lines checked, at most ten", () => {
  const f = { file: "server/x.ts", line: 3, kind: "dead-code", text: "unused export" };
  assert.deepEqual(validate({ verdict: "ok", summary: "Fine.", findings: [] }), { verdict: "ok", summary: "Fine.", findings: [] });
  assert.deepEqual(validate({ verdict: "notes", summary: " One note. ", findings: [f] }), { verdict: "notes", summary: "One note.", findings: [f] });
  assert.match(validate({ verdict: "ok", summary: "x", findings: [f] }), /no findings/);
  assert.match(validate({ verdict: "blocking", summary: "x", findings: [] }), /at least one finding/);
  assert.match(validate({ verdict: "maybe", summary: "x", findings: [] }), /verdict must be/);
  assert.match(validate({ verdict: "notes", summary: "", findings: [f] }), /summary/);
  assert.match(validate({ verdict: "notes", summary: "x", findings: [{ ...f, kind: "style" }] }), /kind must be/);
  assert.match(validate({ verdict: "notes", summary: "x", findings: [{ ...f, line: 0 }] }), /line/);
  assert.match(validate({ verdict: "notes", summary: "x", findings: Array(11).fill(f) }), /at most 10/);
  assert.deepEqual(KINDS, ["dead-code", "duplication", "hack", "missing-test", "naming", "other"]);
});

test("review text for merge.review: the summary, one line per finding, capped", () => {
  assert.equal(reviewText({ verdict: "ok", summary: "Fine.", findings: [] }), "Fine.");
  assert.equal(
    reviewText({ verdict: "notes", summary: "Two notes.", findings: [{ file: "a.ts", line: 3, kind: "naming", text: "x says nothing" }, { kind: "missing-test", text: "no test for the empty case" }] }),
    "Two notes.\n- [naming] a.ts:3: x says nothing\n- [missing-test] no test for the empty case",
  );
  const long = reviewText({ verdict: "notes", summary: "s", findings: Array(10).fill({ file: "f.ts", kind: "other", text: "y".repeat(400) }) });
  assert.equal(long.length, TEXT_MAX);
  assert.ok(long.endsWith("…"));
});

test("the review kit is never a registered skill: not under a skills folder, not in pi's skill settings", () => {
  const kit = join(REPO, ".sova", "playbooks", "review");
  assert.ok(existsSync(join(kit, "PLAYBOOK.md")) && existsSync(join(kit, "references", "checklist.md")));
  assert.ok(!existsSync(join(kit, "SKILL.md")), "a SKILL.md would make it loadable as a skill");
  for (const dir of [".claude/skills", ".pi/skills", "pi-config/skills"]) {
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

test("the merge-reviewer profile ships with Sova: no edit tools, web, workers, timers or worktrees", async () => {
  const raw = JSON.parse(readFileSync(join(REPO, "profiles", "merge-reviewer.json"), "utf8"));
  assert.equal(profileFileError(raw), null);
  assert.equal((await findProfile({ source: "sova", id: "merge-reviewer" }, null))?.id, "merge-reviewer");
  assert.deepEqual([...raw.remove].sort(), ["edit", "timers", "web", "workers", "worktrees"]);
  assert.deepEqual(raw.grant, []);
});

test("the merge-thread profile ships with Sova, is valid, and has no web, workers or timers", async () => {
  const raw = JSON.parse(readFileSync(join(REPO, "profiles", "merge-thread.json"), "utf8"));
  assert.equal(profileFileError(raw), null);
  const listed = await findProfile({ source: "sova", id: "merge-thread" }, null);
  assert.equal(listed?.id, "merge-thread", "listed among Sova's built-in profiles, for every project");
  assert.equal(raw.id, "merge-thread");
  for (const r of ["web", "workers", "timers"]) assert.ok(raw.remove.includes(r));
  assert.deepEqual(raw.grant, []);
  assert.equal(raw.overseerMayStart, false);
});
