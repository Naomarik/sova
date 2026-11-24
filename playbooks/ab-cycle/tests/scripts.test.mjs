import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratchRoot } from "./scratch.mjs";
import * as rec from "../scripts/record-lib.mjs";

/**
 * The A/B cycle's memory (../scripts/record-lib.mjs), in-process: a prediction beside what a round did, the subject's
 * record and the check that keeps anything private out of it, and the rule that no arm may hold the record. The
 * commands themselves (exit codes, the files they write) are in commands.test.mjs.
 */

const PLAYBOOK = fileURLToPath(new URL("..", import.meta.url));
const dir = scratchRoot("ab-cycle-scripts-");

test("these tests run in a throwaway home, and git started in their folder finds no repository", () => {
  assert.equal(process.env.HOME, join(dir, "home"));
  assert.equal(homedir(), join(dir, "home"));
  assert.equal(process.env.PI_CODING_AGENT_DIR, join(dir, "home", ".pi", "agent"));
  for (const name of ["CLAUDE_CONFIG_DIR", "GIT_DIR", "GIT_WORK_TREE", "SOVA_ROOT"]) assert.equal(process.env[name], undefined, name);
  const sub = join(dir, "plain", "folder");
  mkdirSync(sub, { recursive: true });
  assert.throws(() => execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: sub, stdio: "ignore" }));
});

const BUCKETS = ["fixedExpected", "notFixed", "fixedUnexpected", "brokeExpected", "brokeUnexpected", "missing"];

test("predicted beside observed: each pairing of the base's grade, the arm's grade and what was predicted is counted as the promise names it", () => {
  // Written by hand from references/ledger.md: [base, arm, predicted as] → where it is counted ("" = nowhere).
  const want = [
    ["fail", "pass", "expectFix", "fixedExpected"],
    ["fail", "pass", "mayBreak", "fixedUnexpected"],
    ["fail", "pass", "", "fixedUnexpected"],
    ["pass", "fail", "expectFix", "brokeUnexpected"],
    ["pass", "fail", "mayBreak", "brokeExpected"],
    ["pass", "fail", "", "brokeUnexpected"],
    ["fail", "fail", "expectFix", "notFixed"],
    ["fail", "fail", "mayBreak", ""],
    ["fail", "fail", "", ""],
    ["pass", "pass", "expectFix", ""],
    ["pass", "pass", "mayBreak", ""],
    ["pass", "pass", "", ""],
    ["none", "pass", "expectFix", "missing"],
    ["none", "fail", "", "missing"],
    ["pass", "none", "mayBreak", "missing"],
    ["fail", "none", "", "missing"],
    ["none", "none", "expectFix", "missing"],
    ["none", "none", "mayBreak", "missing"],
  ];
  const arm = { expectFix: [], mayBreak: [] };
  const grades = {};
  const baseGrades = {};
  want.forEach(([base, mine, as], i) => {
    const id = `k${i}`;
    if (as) arm[as].push(id);
    if (base !== "none") baseGrades[id] = base === "pass";
    if (mine !== "none") grades[id] = mine === "pass";
  });
  const p = rec.comparePrediction({ arm, grades: { m: grades }, baseGrades: { m: baseGrades }, base: { round: 0, arm: "A" } });
  for (const b of BUCKETS) {
    const ids = want.flatMap(([, , , where], i) => (where === b ? [`k${i}`] : [])).sort();
    assert.deepEqual([p[b].n, p[b].ids, p[b].perModel], [ids.length, ids, ids.length ? { m: ids.length } : {}], b);
  }
  // Only what both sides graded is compared: 12 cases, 6 passing on the base (rows 4-6, 10-12) and 6 on the arm (rows 1-3, 10-12).
  assert.deepEqual(p.compared, { n: 12, base: 50, arm: 50, perModel: { m: { n: 12, base: 50, arm: 50 } } });
  assert.equal(p.stated, true);
});

test("a case is counted once per test model, and an arm that stated no prediction says so while its fixes and breaks still show", () => {
  const grades = { glm: { a: true, b: false }, haiku: { a: false, b: false } };
  const baseGrades = { glm: { a: false, b: true }, haiku: { a: false, b: true } };
  const p = rec.comparePrediction({ arm: { problem: " skips the guide ", why: "w", expectFix: ["a"], mayBreak: [] }, grades, baseGrades });
  assert.deepEqual(p.fixedExpected, { n: 1, ids: ["a"], perModel: { glm: 1 } });
  assert.deepEqual(p.notFixed, { n: 1, ids: ["a"], perModel: { haiku: 1 } });
  assert.deepEqual(p.brokeUnexpected, { n: 2, ids: ["b"], perModel: { glm: 1, haiku: 1 } });
  assert.deepEqual([p.problem, p.compared.perModel.glm, p.compared.perModel.haiku], ["skips the guide", { n: 2, base: 50, arm: 50 }, { n: 2, base: 50, arm: 0 }]);
  assert.deepEqual(rec.predictionCounts(p), { stated: true, problem: "skips the guide", expectFix: 1, mayBreak: 0, fixedExpected: 1, notFixed: 1, fixedUnexpected: 0, brokeExpected: 0, brokeUnexpected: 2, missing: 0 });

  const silent = rec.comparePrediction({ arm: { change: "x" }, grades, baseGrades });
  assert.deepEqual([silent.stated, silent.fixedExpected.n, silent.fixedUnexpected.n, silent.brokeUnexpected.n], [false, 0, 1, 2]);
  const table = rec.predictionTable([{ arm: "B", prediction: p }, { arm: "C", prediction: silent }], (s) => s.toUpperCase());
  const rows = table.split("\n").filter((l) => /^\| [BC] /.test(l));
  assert.deepEqual(rows, [
    "| B | skips the guide | 1 case | 1 of 2 (GLM 1) | 0 | 0 cases | 0 | 2 (GLM 1, HAIKU 1) |",
    "| C | no prediction stated | - | - | 1 (GLM 1) | - | - | 2 (GLM 1, HAIKU 1) |",
  ]);
  assert.match(rec.samplePredictionTable(["glm"], (s) => s), /no prediction stated/, "the sample for the first stop shows one too");
});

test("a prediction naming an id that isn't a case, or a sealed case, is refused by name; master's arm is never read", () => {
  const cases = [{ id: "f01", group: "fail" }, { id: "p01", group: "pass" }, { id: "s01", group: "sealed" }];
  assert.deepEqual(rec.predictionProblems({ A: { baseline: true, expectFix: ["nope"] }, B: { expectFix: ["f01"], mayBreak: ["p01"] }, C: {} }, cases), []);
  const bad = rec.predictionProblems({ B: { expectFix: ["f01", "f99"], mayBreak: ["s01"] }, C: { expectFix: "f01" } }, cases);
  assert.equal(bad.length, 3);
  assert.match(bad[0], /^arm B: expectFix names f99, which isn't a case$/);
  assert.match(bad[1], /^arm B: mayBreak names s01, a sealed case/);
  assert.match(bad[2], /^arm C: expectFix must be a list of case ids$/);
  assert.equal(rec.onlySealed(["s01", "s01"], cases), true);
  assert.equal(rec.onlySealed(["s01", "f01"], cases), false);
  assert.equal(rec.onlySealed([], cases), false);
});

test("an arm is compared with the earlier arm at its base, else with Round 0's master", () => {
  const rounds = {
    0: { A: { baseline: true, ref: "m1" } },
    1: { B: { base: "m1", ref: "b1" }, C: { base: "m1", ref: "c1" } },
    2: { B: { base: "c1", ref: "b2" } },
  };
  const of = (r) => rounds[r];
  assert.deepEqual(rec.findBase(of, 2, rounds[2].B), { round: 1, arm: "C" });
  assert.deepEqual(rec.findBase(of, 1, rounds[1].B), { round: 0, arm: "A" });
  assert.deepEqual(rec.findBase(of, 2, { base: "gone" }), { round: 0, arm: "A" }, "a base no round ran falls back to master");
  assert.deepEqual(rec.findBase(of, 2, {}), { round: 0, arm: "A" });
  assert.equal(rec.findBase(() => undefined, 1, { base: "m1" }), null);
});

// ---- the record ----

const HOME = ["", "home", "someone", "project"].join("/");
const COPY = "http://127.0.0.1:4813";
const prediction = (over = {}) =>
  rec.comparePrediction({
    arm: { problem: "skips the guide before drawing", why: "The rule sits below the examples", expectFix: ["f01", "f02"], mayBreak: ["p01"], ...over },
    grades: { "zai_glm-5.3@low": { f01: true, f02: false, f03: true, p01: true, p02: false } },
    baseGrades: { "zai_glm-5.3@low": { f01: false, f02: false, f03: false, p01: true, p02: true } },
    base: { round: 0, arm: "A" },
  });
const MODELS = { "zai_glm-5.3@low": { model: "zai/glm-5.3", effort: "low" } };
const attempt = (over = {}, arm = {}, corpus) =>
  rec.attemptLine({ campaign: "vis-dsl", round: 2, armId: "B", arm: { change: "Moves the guide rule to the first line", knobs: ["tool-description"], ...arm }, prediction: prediction(), models: MODELS, outcome: "carried", date: "2026-11-18", diff: null, ...over }, corpus);

test("an attempt's line is built from named fields only: an arm's address and folders, and every case id, stay out of it", () => {
  const { line, textLeftOut } = attempt({ note: "beat the noise" }, { url: COPY, agentDir: `${HOME}/.agent`, cwd: HOME, label: "B", ref: "abc1234", base: "def5678" });
  assert.deepEqual(line, {
    v: 1,
    kind: "attempt",
    date: "2026-11-18",
    campaign: "vis-dsl",
    round: 2,
    arm: "B",
    problem: "skips the guide before drawing",
    change: "Moves the guide rule to the first line",
    why: "The rule sits below the examples",
    knobs: ["tool-description"],
    models: [{ model: "zai/glm-5.3", effort: "low", cases: 5, base: 40, arm: 60 }],
    all: { base: 40, arm: 60 },
    predicted: { fix: 2, risk: 1 },
    observed: { fixedExpected: 1, notFixed: 1, fixedUnexpected: 1, brokeExpected: 0, brokeUnexpected: 1 },
    outcome: "carried",
    note: "beat the noise",
  });
  assert.equal(textLeftOut, null);
  const written = JSON.stringify(line);
  for (const leak of [HOME, COPY, "127.0.0.1", ".agent", "f01", "f02", "p01"]) assert.ok(!written.includes(leak), `${leak} is not in the line`);
  assert.deepEqual(rec.checkLine(line), []);
  assert.equal(attempt({ prediction: rec.comparePrediction({ arm: {}, grades: {}, baseGrades: {} }) }).line.predicted, null, "no prediction stated");
});

const DIFF = ["diff --git a/tools/vis.ts b/tools/vis.ts", "index 111..222 100644", "--- a/tools/vis.ts", "+++ b/tools/vis.ts", "@@ -3 +3 @@", "-Read the guide when unsure.", "+Read the guide first.", "\\ No newline at end of file", "diff --git a/docs/old.md b/docs/old.md", "deleted file mode 100644", "--- a/docs/old.md", "+++ /dev/null", "@@ -1 +0,0 @@", "---- a rule that began with dashes"].join("\n");

test("the changed text is kept when it is short and clean; otherwise the line keeps the files and line counts and says why", () => {
  assert.deepEqual(rec.changedText(DIFF), { text: "tools/vis.ts\n- Read the guide when unsure.\n+ Read the guide first.\ndocs/old.md\n- --- a rule that began with dashes", files: ["tools/vis.ts", "docs/old.md"], added: 1, removed: 2 });
  assert.equal(attempt({ diff: DIFF }).line.text, rec.changedText(DIFF).text);
  const swap = (to) => DIFF.replace("Read the guide first.", to);
  const left = [
    [swap("x".repeat(rec.TEXT_CAP)), /longer than 1500 characters/],
    [swap(`See ${COPY}/guide`), /holds a URL/],
    [swap("Like case f01 does."), /holds a token shaped like a case id/],
  ];
  for (const [diff, why] of left) {
    const { line, textLeftOut } = attempt({ diff });
    assert.match(textLeftOut, why);
    assert.deepEqual([line.text, line.files, line.lines], [undefined, ["tools/vis.ts", "docs/old.md"], { added: 1, removed: 2 }]);
    assert.deepEqual(rec.checkLine(line), [], "what is kept instead passes the check");
  }
});

test("the check refuses anything private in any free text of a line, naming the field, and any field a record doesn't have", () => {
  const corpus = rec.corpusOf(["Please draw the monthly revenue for the northern region as a stacked bar chart", "short reply"]);
  const planted = [
    [`see ${HOME}/notes`, /a home folder or absolute path/],
    ["in ~/work it failed", /a home folder or absolute path/],
    ["under C:\\Users\\someone", /a home folder or absolute path/],
    [`opened ${COPY}/#/s/1`, /a URL/],
    ["the copy at localhost:4813", /a URL/],
    ["host 192.0.2.7 answered", /an IP address/],
    ["ask someone@example.com", /an email address/],
    ["as in f01 and p12", /a token shaped like a case id/],
    ["It was asked to draw the MONTHLY revenue for the northern region as a stacked chart", /8 or more words in a row from a case or a saved reply/],
  ];
  const clean = attempt({ note: "fine", diff: DIFF }).line;
  assert.deepEqual(rec.checkLine(clean, corpus), []);
  for (const field of ["problem", "change", "why", "note", "text"]) {
    for (const [text, what] of planted) {
      const bad = rec.checkLine({ ...clean, [field]: text }, corpus);
      assert.ok(bad.some((b) => b.field === field && what.test(b.what)), `${field}: ${text} → ${JSON.stringify(bad)}`);
    }
  }
  assert.match(rec.checkLine({ ...clean, text: undefined, files: [`${HOME}/x.ts`] })[0].what, /a home folder/);
  // The campaign's own case ids, whatever their shape, are refused by name where one stands as a word; with no campaign only the shape is known.
  const named = rec.corpusOf([], ["arrow-labels", "f07"]);
  for (const over of [{ why: "like arrow-labels" }, { note: "Arrow-Labels again" }, { text: undefined, files: ["docs/arrow-labels.md"] }]) {
    const field = Object.keys(over).pop();
    assert.deepEqual(rec.checkLine({ ...clean, ...over }, named), [{ field, what: "holds a case id (arrow-labels)" }], field);
    assert.deepEqual(rec.checkLine({ ...clean, ...over }), [], `${field}: no campaign`);
  }
  assert.deepEqual(rec.checkLine({ ...clean, why: "narrow-labels and arrow-labels-wide are other words" }, named), []);
  // What the patterns must leave alone: a path inside the repository, a version, a model with its effort, a percentile.
  for (const ok of ["server/home/index.ts and src/Users/list.tsx", "pinned at 1.0.3, then 2.11.14", "zai/glm-5.3@low ran it", "fewer than 7 words shared: draw the monthly revenue for the northern"]) assert.deepEqual(rec.checkLine({ ...clean, why: ok }, corpus), [], ok);
  // Shapes: nothing an arm or a case holds can ride along under another name.
  const shape = (over) => rec.checkLine({ ...clean, ...over }).map((b) => b.field);
  assert.deepEqual(shape({ cwd: "x" }), ["cwd"]);
  assert.deepEqual(shape({ expectFix: ["k1"] }), ["expectFix"]);
  assert.deepEqual(shape({ outcome: "won" }), ["outcome"]);
  assert.deepEqual(shape({ problem: "" }), ["problem"]);
  assert.deepEqual(shape({ models: [{ model: "http://x/y", effort: "low", cases: 5, base: 40, arm: 60 }] }), ["models[0].model"]);
  assert.deepEqual(shape({ observed: { ...clean.observed, ids: 1 } }), ["observed"]);
  const close = rec.closeLine({ campaign: "vis-dsl", date: "2026-11-20", verdict: "land", master: "3c9e1f7a", rounds: 2, confirm: [{ model: "zai/glm-5.3", effort: "low", cases: 10, master: 40, winner: 80 }] });
  assert.deepEqual(rec.checkLine(close), []);
  assert.deepEqual(rec.checkLine({ ...close, master: HOME, verdict: "ship" }).map((b) => b.field), ["verdict", "master"]);
  assert.deepEqual(rec.checkRecord(`${JSON.stringify(clean)}\n\nnot json\n${JSON.stringify({ ...close, note: "see https://example.com/x" })}\n`), [
    { at: 3, field: "(line)", what: "isn't JSON" },
    { at: 4, field: "note", what: "holds a URL" },
  ]);
});

test("a record is shown grouped by problem, with the attempts that lost and the one that made it worse", () => {
  const worse = { ...attempt().line, campaign: "vis-2", round: 1, arm: "C", problem: "Skips the guide before drawing", change: "Adds a second reminder", outcome: "dropped", all: { base: 60, arm: 45 } };
  const other = { ...attempt({ prediction: rec.comparePrediction({ arm: {}, grades: {}, baseGrades: {} }) }).line, problem: "draws before it has the data", change: "Asks for the data first", outcome: "dropped", all: { base: 40, arm: 40 } };
  const close = rec.closeLine({ campaign: "vis-dsl", date: "2026-11-20", verdict: "park", master: "3c9e1f7a", rounds: 2 });
  const lines = [attempt().line, other, worse, close];
  assert.equal(rec.recordSummary("vis", lines), "vis: 3 attempts in 2 campaigns, 1 carried, 1 made it worse");
  assert.equal(rec.recordSummary("vis", []), "vis: no attempts yet");
  const md = rec.showRecord("vis", lines);
  assert.deepEqual(md.split("\n").filter((l) => l.startsWith("### ")), ["### skips the guide before drawing", "### draws before it has the data", "### Campaigns closed"], "one group per problem, however it is capitalised");
  assert.deepEqual(md.split("\n").filter((l) => l.startsWith("- **")).map((l) => l.split(" · ").slice(0, 2).join(" · ")), ["- **Carried** · vis-dsl round 2 arm B", "- **Dropped, made it worse** · vis-2 round 1 arm C", "- **Dropped** · vis-dsl round 2 arm B"]);
  assert.match(md, /Adds a second reminder/);
  assert.match(md, /No prediction stated\./);
  assert.match(md, /vis-dsl · 2026-11-20 · parked · 2 rounds/);
  const one = rec.showRecord("vis", lines, { campaign: "vis-2" });
  assert.deepEqual(one.split("\n").filter((l) => l.startsWith("- **")).length, 1, "one campaign's lines only");
});

// ---- the outlook ----

const OUTLOOK = { seat: "1", improve: "likely", lost: "The rule moved up but still reads as optional", next: "Make the rule a condition of drawing at all", gain: "+2 cases", recommend: "cycle", needs: "none" };
const outlook = (over = {}) => rec.outlookLine({ campaign: "vis-dsl", round: 2, date: "2026-11-19", entry: { ...OUTLOOK, ...over } });

test("an outlook's line is built from its closing block's named fields, its expected gain one exact figure, and `needs: none` left out", () => {
  assert.deepEqual(outlook({ lost: "  The rule moved up\n but still reads as optional ", url: COPY }), { v: 1, kind: "outlook", date: "2026-11-19", campaign: "vis-dsl", round: 2, seat: "1", improve: "likely", lost: "The rule moved up but still reads as optional", next: "Make the rule a condition of drawing at all", gain: "+2 cases", recommend: "cycle" });
  assert.equal(outlook({ needs: "tool-code" }).needs, "tool-code");
  assert.equal("seat" in outlook({ seat: undefined }), false, "one consultant needs no seat");
  assert.deepEqual(rec.checkLine(outlook()), []);
  for (const [gain, want] of [["+2 cases", { n: 2, unit: "cases" }], ["+1 case", { n: 1, unit: "cases" }], ["0 cases", { n: 0, unit: "cases" }], ["+12.5 points on pass rate", { n: 12.5, unit: "points", on: "pass rate" }]]) {
    assert.deepEqual(rec.gainOf(gain), want, gain);
    assert.deepEqual(rec.checkLine(outlook({ gain })), [], gain);
  }
  for (const gain of ["a few cases", "+2", "+2 cases or more", "about +2 points", "+5 points"]) assert.deepEqual(rec.checkLine(outlook({ gain })).map((b) => b.field), ["gain"], gain);
});

test("an outlook's line is refused naming its field: an unknown word, a case id or a case's words in its free text, a field a record doesn't have", () => {
  const corpus = rec.corpusOf(["Please draw the monthly revenue for the northern region as a stacked bar chart"], ["arrow-labels"]);
  const fields = (over, c = corpus) => rec.checkLine({ ...outlook(), ...over }, c).map((b) => b.field);
  assert.deepEqual(fields({ improve: "maybe" }), ["improve"]);
  assert.deepEqual(fields({ recommend: "land" }), ["recommend"]);
  assert.deepEqual(fields({ needs: "Tool Code" }), ["needs"]);
  assert.deepEqual(fields({ seat: "a seat" }), ["seat"]);
  assert.deepEqual(fields({ round: -1 }), ["round"]);
  assert.deepEqual(fields({ lost: "" }), ["lost"]);
  assert.deepEqual(fields({ expectFix: ["f01"] }), ["expectFix"]);
  for (const field of ["lost", "next"]) {
    assert.deepEqual(fields({ [field]: "The same slip as arrow-labels" }), [field], `${field}: a case id by name`);
    assert.deepEqual(fields({ [field]: "as in f01" }, undefined), [field], `${field}: a token shaped like a case id`);
    assert.deepEqual(fields({ [field]: "It was asked to draw the monthly revenue for the northern region as a stacked chart" }), [field], `${field}: 8 words from a case`);
  }
  assert.deepEqual(rec.checkLine({ ...outlook(), gain: "+2 points on arrow-labels" }, corpus), [{ field: "gain", what: "holds a case id (arrow-labels)" }]);
});

test("a record shows each round's outlook under its campaign and round, its summary the last outlook, and a keep close as baseline kept", () => {
  const futile = { ...outlook({ seat: undefined, improve: "futile", recommend: "keep", gain: "+0 cases", needs: "tool-code" }), round: 3 };
  const keep = rec.closeLine({ campaign: "vis-dsl", date: "2026-11-21", verdict: "keep", master: "3c9e1f7a", rounds: 2 });
  assert.deepEqual(rec.checkLine(keep), []);
  const lines = [attempt().line, outlook(), futile, keep];
  assert.equal(rec.recordSummary("vis", lines), "vis: 1 attempt in 1 campaign, 1 carried, 0 made it worse; last outlook: futile, keep the baseline");
  assert.equal(rec.recordSummary("vis", [{ ...outlook(), round: 0 }]), "vis: no attempts yet; last outlook: likely, run another cycle");
  const md = rec.showRecord("vis", lines);
  assert.deepEqual(md.split("\n").filter((l) => l.startsWith("### ")), ["### skips the guide before drawing", "### Outlooks", "### Campaigns closed"]);
  assert.match(md, /^- \*\*Likely to improve\*\* · vis-dsl round 2 seat 1 · 2026-11-19 · expected \+2 cases · run another cycle$/m);
  assert.match(md, /^- \*\*Futile to improve\*\* · vis-dsl round 3 · 2026-11-19 · expected \+0 cases · keep the baseline · needs: tool-code$/m);
  assert.match(md, /^ {2}- Won or lost: The rule moved up but still reads as optional$/m);
  assert.match(md, /^ {2}- Next: Make the rule a condition of drawing at all$/m);
  assert.match(md, /vis-dsl · 2026-11-21 · baseline kept · 2 rounds/);
  assert.ok(!/parked/.test(md), "keep is never shown as parked");
});

test("the table Expected gain vs observed: each outlook's figure beside every arm's cases turned and points against its base", () => {
  const t = rec.gainTable(1, [OUTLOOK, { ...OUTLOOK, seat: "2", improve: "unlikely", gain: "+5 points on pass rate" }], [{ arm: "B", prediction: prediction() }]);
  // prediction(): f01 and f03 fixed, p02 broken; 40% → 60% on 5 cases.
  assert.match(t, /^\*\*Expected gain vs observed\*\* \(Round 1's outlook\)$/m);
  assert.match(t, /^\| 1 \| likely \| \+2 cases \| B \+1 case \(2 fixed, 1 broken\), \+20 points \|$/m);
  assert.match(t, /^\| 2 \| unlikely \| \+5 points on pass rate \| B \+1 case \(2 fixed, 1 broken\), \+20 points \|$/m);
  assert.match(rec.gainTable(0, [{ ...OUTLOOK, seat: undefined }], []), /^\| 1 \| likely \| \+2 cases \| no arm ran \|$/m);
});

/** The records committed in the project the playbook ships in: the nearest folder above it holding .sova/ab, if any. */
function committedRecords() {
  for (let d = dirname(PLAYBOOK); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, ".sova", "ab"))) return join(d, ".sova", "ab");
  return null;
}

test("every committed record passes the check, and so do the lines references/record.md shows", () => {
  const committed = committedRecords();
  for (const f of committed ? readdirSync(committed).filter((x) => x.endsWith(".jsonl")) : []) {
    assert.match(f, /^[a-z0-9]+(-[a-z0-9]+)*\.jsonl$/, f);
    assert.deepEqual(rec.checkRecord(readFileSync(join(committed, f), "utf8")), [], f);
  }
  const page = readFileSync(join(PLAYBOOK, "references", "record.md"), "utf8");
  const shown = [...page.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(shown.map((l) => l.kind), ["attempt", "outlook", "close"]);
  for (const line of shown) assert.deepEqual(rec.checkLine(line), [], line.kind);
});

// ---- no arm holds the record ----

test("a round is refused while a test chat could read the record: in an arm's folder, above it in its repository, or in the campaign's own worktree", () => {
  const mk = (...p) => {
    const d = join(dir, ...p);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const project = mk("project");
  const campaign = mk("project", ".cache", "ab", "demo");
  assert.equal(rec.projectOf(campaign), project);
  assert.equal(rec.projectOf(mk("elsewhere", "demo")), null);

  const clean = mk("arms", "clean");
  const holds = mk("arms", "holds");
  mk("arms", "holds", ".sova", "ab");
  const repo = mk("arms", "repo");
  writeFileSync(join(repo, ".git"), "gitdir: elsewhere\n");
  mk("arms", "repo", ".sova", "ab");
  const inRepo = mk("arms", "repo", "packages", "app");
  const fenced = mk("arms", "holds", "sub");
  writeFileSync(join(fenced, ".git"), "gitdir: elsewhere\n");

  // What git would say (the real question is asked in the integration file): only `tracked` still has the record in its HEAD commit.
  const tracked = mk("arms", "tracked");
  const refused = (arm, cwd = clean) => rec.armRefusals({ B: arm }, { project, cwd, tracks: (d) => d === tracked });
  assert.deepEqual(refused({ how: "sova", cwd: clean, agentDir: join(clean, ".agent") }), []);
  assert.deepEqual(refused({ how: "command", command: "true" }), [], "a command arm with no cwd runs where the runner does");
  assert.deepEqual(refused({ how: "sova", cwd: fenced }), [], "a repository of its own below a folder that holds one doesn't see it");
  assert.deepEqual(refused({ how: "rescore", from: 1, cwd: holds }), [], "a rescore runs nothing");
  for (const arm of [{ how: "sova", cwd: holds }, { how: "sova", cwd: clean, agentDir: join(holds, ".agent") }, { how: "command", cwd: clean, worktree: holds }, { how: "sova", cwd: inRepo }]) {
    const r = refused(arm);
    assert.equal(r.length, 1, JSON.stringify(arm));
    assert.match(r[0], /^arm B: .*\.sova[/\\]ab is there for its test chats to read/);
  }
  assert.match(refused({ how: "command", command: "true" }, holds)[0], /^arm B: /);
  for (const arm of [{ how: "sova", cwd: tracked }, { how: "sova", cwd: clean, agentDir: join(tracked, ".agent") }]) assert.match(refused(arm)[0], /^arm B: the repository .* is in still has \.sova[/\\]ab in its HEAD commit/, "a delete left uncommitted hides nothing from git");
  for (const cwd of [project, campaign]) assert.match(refused({ how: "sova", cwd })[0], /^arm B: .* is inside the campaign's own worktree, where the record is written/);
  assert.deepEqual(rec.armRefusals({ B: { how: "sova", cwd: project } }, { project: null, cwd: clean }), [], "no project known, and no record there yet");
});
