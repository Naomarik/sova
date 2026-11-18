// The A/B cycle's memory, as functions with no side effects at import (so a test can import them; the
// other scripts run at import): a round's prediction beside what it did (references/ledger.md), the
// subject's record and its check (references/record.md), and the rule that no arm may hold the record
// (references/arms.md). Node builtins only.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** A record's name: lowercase letters, digits and dashes. */
export const RECORD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The longest changed text a line keeps; a longer change keeps its files and line counts. */
export const TEXT_CAP = 1500;
/** How many words in a row from a case or a saved reply a line may never repeat. */
export const SHARED_WORDS = 8;
/** Where a project's records live, from its root. */
export const RECORD_DIR = join(".sova", "ab");

const OBSERVED = ["fixedExpected", "notFixed", "fixedUnexpected", "brokeExpected", "brokeUnexpected"];
const rate = (p, t) => (t ? Math.round((1000 * p) / t) / 10 : 0);
const isInt = (v) => Number.isInteger(v) && v >= 0;
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------
// A prediction, and what the round did
// ---------------------------------------------------------------------------------------------------

/** An arm's prediction as its arms.json entry states it. No `expectFix` list: none stated. */
export function predictionOf(arm) {
  return {
    stated: strings(arm?.expectFix),
    problem: typeof arm?.problem === "string" && arm.problem.trim() ? arm.problem.trim() : null,
    why: typeof arm?.why === "string" && arm.why.trim() ? arm.why.trim() : null,
    expectFix: strings(arm?.expectFix) ? [...new Set(arm.expectFix)] : [],
    mayBreak: strings(arm?.mayBreak) ? [...new Set(arm.mayBreak)] : [],
  };
}

/** Why a round's predictions can't be used: an id that isn't a case, or is a sealed case. One line each, naming the id. */
export function predictionProblems(arms, cases) {
  const group = new Map(cases.map((k) => [k.id, k.group]));
  const out = [];
  for (const [a, arm] of Object.entries(arms)) {
    if (arm.baseline) continue;
    for (const field of ["expectFix", "mayBreak"]) {
      if (arm[field] === undefined) continue;
      if (!strings(arm[field])) {
        out.push(`arm ${a}: ${field} must be a list of case ids`);
        continue;
      }
      for (const id of arm[field]) {
        if (!group.has(id)) out.push(`arm ${a}: ${field} names ${id}, which isn't a case`);
        else if (group.get(id) === "sealed") out.push(`arm ${a}: ${field} names ${id}, a sealed case: no prediction may name one`);
      }
    }
  }
  return out;
}

/** The arm a candidate is compared with: the arm of an earlier round whose ref is its base, else Round 0's master. */
export function findBase(armsOfRound, n, arm) {
  if (arm.base)
    for (let r = n - 1; r >= 0; r--) {
      const hit = Object.entries(armsOfRound(r) ?? {}).find(([, x]) => x.ref && x.ref === arm.base);
      if (hit) return { round: r, arm: hit[0] };
    }
  const master = Object.entries(armsOfRound(0) ?? {}).find(([, x]) => x.baseline);
  return master ? { round: 0, arm: master[0] } : null;
}

/**
 * One arm's prediction beside what the round did. `grades` and `baseGrades` are {model: {case: pass}}
 * (the arm's, and its base's); a case on one test model is one count. Nothing here judges whether the
 * prediction held: the counts are read against the noise.
 */
export function comparePrediction({ arm, grades, baseGrades, base = null, models }) {
  const p = predictionOf(arm);
  const expect = new Set(p.expectFix);
  const risk = new Set(p.mayBreak);
  const tally = () => ({ n: 0, ids: new Set(), perModel: {} });
  const t = Object.fromEntries([...OBSERVED, "missing"].map((k) => [k, tally()]));
  const add = (k, slug, id) => {
    t[k].n++;
    t[k].ids.add(id);
    t[k].perModel[slug] = (t[k].perModel[slug] ?? 0) + 1;
  };
  const compared = { n: 0, basePass: 0, armPass: 0, perModel: {} };
  const slugs = models ?? [...new Set([...Object.keys(grades ?? {}), ...Object.keys(baseGrades ?? {})])];
  for (const slug of slugs) {
    const mine = grades?.[slug] ?? {};
    const theirs = baseGrades?.[slug] ?? {};
    const per = { n: 0, basePass: 0, armPass: 0 };
    for (const id of new Set([...Object.keys(mine), ...Object.keys(theirs), ...expect, ...risk])) {
      const a = mine[id];
      const b = theirs[id];
      if (typeof a !== "boolean" || typeof b !== "boolean") {
        add("missing", slug, id);
        continue;
      }
      per.n++;
      if (b) per.basePass++;
      if (a) per.armPass++;
      if (!b && a) add(expect.has(id) ? "fixedExpected" : "fixedUnexpected", slug, id);
      else if (b && !a) add(risk.has(id) ? "brokeExpected" : "brokeUnexpected", slug, id);
      else if (!b && !a && expect.has(id)) add("notFixed", slug, id);
    }
    if (per.n) compared.perModel[slug] = { n: per.n, base: rate(per.basePass, per.n), arm: rate(per.armPass, per.n) };
    compared.n += per.n;
    compared.basePass += per.basePass;
    compared.armPass += per.armPass;
  }
  return {
    ...p,
    base,
    compared: { n: compared.n, base: rate(compared.basePass, compared.n), arm: rate(compared.armPass, compared.n), perModel: compared.perModel },
    ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { n: v.n, ids: [...v.ids].sort(), perModel: v.perModel }])),
  };
}

/** The ledger row's form: the counts without the ids. */
export function predictionCounts(p) {
  return { stated: p.stated, problem: p.problem, expectFix: p.expectFix.length, mayBreak: p.mayBreak.length, ...Object.fromEntries([...OBSERVED, "missing"].map((k) => [k, p[k].n])) };
}

/** True when every case a round graded is sealed: such a round compares no prediction. */
export function onlySealed(ids, cases) {
  const group = new Map(cases.map((k) => [k.id, k.group]));
  return ids.length > 0 && ids.every((id) => group.get(id) === "sealed");
}

/**
 * The table Predicted vs observed: one row per candidate arm. `rows` is [{arm, prediction}];
 * `label` turns a model's folder name into what the chart calls it.
 */
export function predictionTable(rows, label = (slug) => slug) {
  const cell = (v) => String(v).replace(/\|/g, "/").replace(/\s+/g, " ");
  // Per test model, when the round compared more than one.
  const split = (p, x) => (x.n && Object.keys(p.compared?.perModel ?? {}).length > 1 ? ` (${Object.entries(x.perModel).map(([s, c]) => `${label(s)} ${c}`).join(", ")})` : "");
  const out = ["**Predicted vs observed**", "", "| Arm | Aimed at | Expected to fix | Fixed | Fixed, not expected | Expected at risk | Broken | Broken, not expected |", "|---|---|---|---|---|---|---|---|"];
  const notes = [];
  for (const { arm, prediction: p } of rows) {
    const aimed = p.stated ? cell(p.problem ?? "(no problem named)").slice(0, 80) : "no prediction stated";
    const fixable = p.fixedExpected.n + p.notFixed.n;
    out.push(
      `| ${cell(arm)} | ${aimed} | ${p.stated ? plural(p.expectFix.length, "case") : "-"} | ${p.stated ? `${p.fixedExpected.n} of ${fixable}${split(p, p.fixedExpected)}` : "-"} | ${p.fixedUnexpected.n}${split(p, p.fixedUnexpected)} | ${p.stated ? plural(p.mayBreak.length, "case") : "-"} | ${p.stated ? `${p.brokeExpected.n}${split(p, p.brokeExpected)}` : "-"} | ${p.brokeUnexpected.n}${split(p, p.brokeUnexpected)} |`,
    );
    if (!p.base) notes.push(`${arm}: no base to compare with (no Round 0, and no earlier arm at its base).`);
    else if (p.missing.n) notes.push(`${arm}: ${plural(p.missing.n, "result")} not compared (graded on one side only, or not run).`);
  }
  out.push("", "Against each arm's base, a case counted once per test model. \"Fixed\" is out of the expected cases that failed on the base. These are counts, not a verdict: read them against the noise.");
  if (notes.length) out.push("", ...notes.map((s) => `- ${s}`));
  return out.join("\n");
}

/** A made-up table for the first stop, so the user sees it before anything runs. */
export function samplePredictionTable(slugs, label) {
  const per = (n) => Object.fromEntries(slugs.map((s) => [s, n]));
  const k = slugs.length;
  const t = (n, ids) => ({ n: n * k, ids, perModel: n ? per(n) : {} });
  const compared = { perModel: per(1) };
  const stated = {
    stated: true,
    problem: "greps before it asks the tool",
    expectFix: ["f01", "f02", "f03", "f04"],
    mayBreak: ["p01"],
    base: { round: 0, arm: "A" },
    compared,
    fixedExpected: t(3, ["f01", "f02", "f03"]),
    notFixed: t(1, ["f04"]),
    fixedUnexpected: t(1, ["f07"]),
    brokeExpected: t(0, []),
    brokeUnexpected: t(1, ["p04"]),
    missing: t(0, []),
  };
  const silent = { ...stated, stated: false, problem: null, expectFix: [], mayBreak: [], fixedExpected: t(0, []), notFixed: t(0, []), fixedUnexpected: t(2, ["f02", "f05"]), brokeUnexpected: t(0, []) };
  return predictionTable(
    [
      { arm: "B", prediction: stated },
      { arm: "C", prediction: silent },
    ],
    label,
  );
}

// ---------------------------------------------------------------------------------------------------
// The check: nothing private in a line
// ---------------------------------------------------------------------------------------------------

/** A text's words, lowercased, for the shared-words check. */
export const words = (s) => String(s ?? "").toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];

/** Every run of SHARED_WORDS words in the campaign's cases and saved replies. */
export function corpusOf(texts) {
  const runs = new Set();
  for (const text of texts) {
    const w = words(text);
    for (let i = 0; i + SHARED_WORDS <= w.length; i++) runs.add(w.slice(i, i + SHARED_WORDS).join(" "));
  }
  return runs;
}

const PRIVATE = [
  ["a home folder or absolute path", /(?<![\w.-])\/(?:home|Users|root)\/|(?<![\w/.-])~\/|(?<![A-Za-z])[A-Za-z]:\\/],
  ["a URL", /\b[a-z][a-z0-9+.-]*:\/\/|\blocalhost(?::\d+)?\b/i],
  ["an IP address", /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\w)|(?<![\w:])(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}(?![\w:])/i],
  ["an email address", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  ["a token shaped like a case id", /\b[fps]\d{2,}\b/],
];

/** What a piece of free text holds that a record may not: [] when it is clean. */
export function privateIn(text, corpus) {
  const s = String(text ?? "");
  const out = PRIVATE.filter(([, re]) => re.test(s)).map(([what]) => what);
  if (corpus?.size) {
    const w = words(s);
    for (let i = 0; i + SHARED_WORDS <= w.length; i++)
      if (corpus.has(w.slice(i, i + SHARED_WORDS).join(" "))) {
        out.push(`${SHARED_WORDS} or more words in a row from a case or a saved reply`);
        break;
      }
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CAMPAIGN = /^[A-Za-z0-9][\w.-]*$/;
const ARM = /^[A-Za-z][\w-]*$/;
const MODEL = /^[\w.+-]+(?:[/:][\w.+-]+)*$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const KNOB = /^[a-z][a-z0-9-]*$/;
const pct = (v) => v === null || (typeof v === "number" && v >= 0 && v <= 100);

const ATTEMPT_KEYS = ["v", "kind", "date", "campaign", "round", "arm", "problem", "change", "why", "text", "files", "lines", "knobs", "models", "all", "predicted", "observed", "outcome", "note"];
const CLOSE_KEYS = ["v", "kind", "date", "campaign", "verdict", "master", "rounds", "confirm", "note"];

/**
 * What is wrong with one line of a record: [{field, what}], [] when it may be written. Every field has
 * its own shape, unknown fields are refused, and free text holds nothing private (privateIn).
 */
export function checkLine(line, corpus) {
  const bad = [];
  const say = (field, what) => bad.push({ field, what });
  if (!line || typeof line !== "object" || Array.isArray(line)) return [{ field: "(line)", what: "isn't an object" }];
  const free = (field, v, required) => {
    if (v === undefined || v === null) return required ? say(field, "is missing") : undefined;
    if (typeof v !== "string" || (required && !v.trim())) return say(field, "must be text");
    for (const what of privateIn(v, corpus)) say(field, `holds ${what}`);
  };
  const shape = (field, ok, what) => (ok ? undefined : say(field, what));
  const model = (field, m, rates) => {
    if (!m || typeof m !== "object") return say(field, "must be an object");
    shape(`${field}.model`, typeof m.model === "string" && MODEL.test(m.model), "must be a model name");
    shape(`${field}.effort`, m.effort === null || m.effort === undefined || (typeof m.effort === "string" && KNOB.test(m.effort)), "must be an effort");
    shape(`${field}.cases`, isInt(m.cases), "must be a count");
    for (const r of rates) shape(`${field}.${r}`, pct(m[r]), "must be a pass rate (0 to 100)");
    for (const k of Object.keys(m)) if (!["model", "effort", "cases", ...rates].includes(k)) say(`${field}.${k}`, "isn't a field of a record");
  };

  shape("v", line.v === 1, "must be 1");
  shape("date", typeof line.date === "string" && DATE.test(line.date), "must be a date (YYYY-MM-DD)");
  shape("campaign", typeof line.campaign === "string" && CAMPAIGN.test(line.campaign), "must be a campaign's name");
  free("note", line.note, false);

  if (line.kind === "attempt") {
    for (const k of Object.keys(line)) if (!ATTEMPT_KEYS.includes(k)) say(k, "isn't a field of a record");
    shape("round", isInt(line.round), "must be a round number");
    shape("arm", typeof line.arm === "string" && ARM.test(line.arm), "must be an arm's id");
    free("problem", line.problem, true);
    free("change", line.change, true);
    free("why", line.why, true);
    free("text", line.text, false);
    if (line.files !== undefined) {
      if (!strings(line.files)) say("files", "must be a list of paths");
      else for (const f of line.files) for (const what of privateIn(f, corpus)) say("files", `holds ${what}`);
    }
    if (line.lines !== undefined) shape("lines", line.lines && isInt(line.lines.added) && isInt(line.lines.removed), "must be {added, removed}");
    if (line.knobs !== undefined) shape("knobs", strings(line.knobs) && line.knobs.every((k) => KNOB.test(k)), "must be a list of the card's knob ids");
    if (!Array.isArray(line.models) || !line.models.length) say("models", "must list the test models");
    else line.models.forEach((m, i) => model(`models[${i}]`, m, ["base", "arm"]));
    shape("all", line.all && typeof line.all === "object" && pct(line.all.base) && pct(line.all.arm) && line.all.base !== null && line.all.arm !== null, "must be {base, arm} pass rates");
    shape("predicted", line.predicted === null || (line.predicted && isInt(line.predicted.fix) && isInt(line.predicted.risk)), "must be {fix, risk} or null");
    shape("observed", line.observed && OBSERVED.every((k) => isInt(line.observed[k])) && Object.keys(line.observed).length === OBSERVED.length, `must be counts: ${OBSERVED.join(", ")}`);
    shape("outcome", line.outcome === "carried" || line.outcome === "dropped", "must be carried or dropped");
  } else if (line.kind === "close") {
    for (const k of Object.keys(line)) if (!CLOSE_KEYS.includes(k)) say(k, "isn't a field of a record");
    shape("verdict", ["land", "cycle", "park"].includes(line.verdict), "must be land, cycle or park");
    shape("master", line.master === null || (typeof line.master === "string" && COMMIT.test(line.master)), "must be a commit");
    shape("rounds", isInt(line.rounds), "must be a count");
    if (line.confirm !== undefined) {
      if (!Array.isArray(line.confirm)) say("confirm", "must list the test models");
      else line.confirm.forEach((m, i) => model(`confirm[${i}]`, m, ["master", "winner"]));
    }
  } else say("kind", "must be attempt or close");
  return bad;
}

/** A record file's lines: [{at, line}] for the ones that parse, and what is wrong with the others. */
export function parseRecord(text) {
  const lines = [];
  const bad = [];
  String(text ?? "")
    .split("\n")
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      try {
        lines.push({ at: i + 1, line: JSON.parse(raw) });
      } catch {
        bad.push({ at: i + 1, field: "(line)", what: "isn't JSON" });
      }
    });
  return { lines, bad };
}

/** Everything wrong with a record file: [{at, field, what}], [] when it passes. */
export function checkRecord(text, corpus) {
  const { lines, bad } = parseRecord(text);
  for (const { at, line } of lines) for (const b of checkLine(line, corpus)) bad.push({ at, ...b });
  return bad.sort((x, y) => x.at - y.at);
}

// ---------------------------------------------------------------------------------------------------
// Building lines
// ---------------------------------------------------------------------------------------------------

/** A unified diff as the lines it removed and added under each file's path, with the files and counts. */
export function changedText(diff) {
  const files = [];
  const out = [];
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const l of String(diff ?? "").split("\n")) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
    if (head) {
      inHunk = false;
      files.push(head[2]);
      out.push(head[2]);
    } else if (l.startsWith("@@")) inHunk = true;
    else if (inHunk && l.startsWith("+")) {
      added++;
      out.push(`+ ${l.slice(1)}`);
    } else if (inHunk && l.startsWith("-")) {
      removed++;
      out.push(`- ${l.slice(1)}`);
    }
  }
  return { text: out.join("\n"), files, added, removed };
}

/**
 * One attempt's line, built from named fields only: nothing else of an arm (its url, agentDir, cwd) or
 * of a case can reach it. `prediction` is the arm's entry in the round's scores; `models` that entry's
 * models; `diff` the arm's change as a unified diff, or null. A changed text that is too long or that
 * the check refuses is left out for the files and line counts: `textLeftOut` says why.
 */
export function attemptLine({ campaign, round, armId, arm, prediction, models, outcome, note, date, diff }, corpus) {
  const p = prediction;
  const line = { v: 1, kind: "attempt", date, campaign, round, arm: armId, problem: p.problem ?? "", change: typeof arm.change === "string" ? arm.change.trim().replace(/\s+/g, " ") : "", why: p.why ?? "" };
  let textLeftOut = null;
  const change = diff ? changedText(diff) : null;
  if (change?.files.length) {
    const refused = change.text.length > TEXT_CAP ? `it is longer than ${TEXT_CAP} characters` : privateIn(change.text, corpus).map((w) => `it holds ${w}`)[0];
    if (refused) {
      textLeftOut = refused;
      line.files = change.files;
      line.lines = { added: change.added, removed: change.removed };
    } else line.text = change.text;
  }
  if (strings(arm.knobs) && arm.knobs.length) line.knobs = [...arm.knobs];
  line.models = Object.entries(p.compared?.perModel ?? {}).map(([slug, c]) => ({ model: models?.[slug]?.model ?? slug, effort: models?.[slug]?.effort ?? null, cases: c.n, base: c.base, arm: c.arm }));
  line.all = { base: p.compared?.base ?? null, arm: p.compared?.arm ?? null };
  line.predicted = p.stated ? { fix: p.expectFix.length, risk: p.mayBreak.length } : null;
  line.observed = Object.fromEntries(OBSERVED.map((k) => [k, p[k].n]));
  line.outcome = outcome;
  if (typeof note === "string" && note.trim()) line.note = note.trim();
  return { line, textLeftOut };
}

/** A campaign's closing line. `confirm` is [{model, effort, cases, master, winner}] or absent. */
export function closeLine({ campaign, date, verdict, master, rounds, confirm, note }) {
  return { v: 1, kind: "close", date, campaign, verdict, master: master ?? null, rounds, ...(confirm?.length ? { confirm } : {}), ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}) };
}

// ---------------------------------------------------------------------------------------------------
// Showing a record
// ---------------------------------------------------------------------------------------------------

const attemptsOf = (lines) => lines.filter((l) => l.kind === "attempt");
/** An attempt made it worse when its pass rate over every test model is below its base's. */
export const madeWorse = (l) => l.kind === "attempt" && typeof l.all?.arm === "number" && typeof l.all?.base === "number" && l.all.arm < l.all.base;

/** "vis: 6 attempts in 2 campaigns, 2 carried, 1 made it worse". */
export function recordSummary(name, lines) {
  const a = attemptsOf(lines);
  if (!a.length) return `${name}: no attempts yet`;
  return `${name}: ${plural(a.length, "attempt")} in ${plural(new Set(a.map((l) => l.campaign)).size, "campaign")}, ${a.filter((l) => l.outcome === "carried").length} carried, ${a.filter(madeWorse).length} made it worse`;
}

const modelName = (m) => `${m.model}${m.effort ? ` · ${m.effort}` : ""}`;
const pc = (v) => (v === null || v === undefined ? "-" : `${v}%`);

/** A record as markdown, grouped by problem, losing attempts included. `campaign` keeps one campaign's lines. */
export function showRecord(name, allLines, { campaign } = {}) {
  const lines = campaign ? allLines.filter((l) => l.campaign === campaign) : allLines;
  const out = [`## The record: ${name}`, "", campaign ? `${recordSummary(name, lines)} (the lines of ${campaign} only).` : `${recordSummary(name, lines)}.`];
  // One group per problem name, however it is capitalised, in the order the names first appear.
  const groups = new Map();
  for (const l of attemptsOf(lines)) {
    const key = String(l.problem).trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { problem: l.problem, group: [] });
    groups.get(key).group.push(l);
  }
  for (const { problem, group } of groups.values()) {
    out.push("", `### ${problem}`, "", `${plural(group.length, "attempt")}, ${group.filter((l) => l.outcome === "carried").length} carried.`, "");
    for (const l of group) {
      const o = l.observed;
      out.push(`- **${l.outcome === "carried" ? "Carried" : madeWorse(l) ? "Dropped, made it worse" : "Dropped"}** · ${l.campaign} round ${l.round} arm ${l.arm} · ${l.date}${l.knobs?.length ? ` · knobs: ${l.knobs.join(", ")}` : ""}`);
      out.push(`  - Change: ${l.change}`);
      out.push(`  - Why: ${l.why}`);
      out.push(`  - Pass rate, base → arm: ${l.models.map((m) => `${modelName(m)} ${pc(m.base)} → ${pc(m.arm)} (${plural(m.cases, "case")})`).join("; ")}; all ${pc(l.all.base)} → ${pc(l.all.arm)}`);
      out.push(
        l.predicted
          ? `  - Expected to fix ${plural(l.predicted.fix, "case")}, at risk ${l.predicted.risk}. A case counted once per test model: of the expected fixes ${o.fixedExpected} happened and ${o.notFixed} didn't; ${o.fixedUnexpected} fixed without being expected; of the expected breaks ${o.brokeExpected} happened; ${o.brokeUnexpected} broken without being expected.`
          : `  - No prediction stated. A case counted once per test model: ${o.fixedUnexpected} fixed, ${o.brokeUnexpected} broken.`,
      );
      if (l.text) out.push("  - Text changed:", "", ...["```", ...l.text.split("\n"), "```"].map((s) => `    ${s}`), "");
      else if (l.files?.length) out.push(`  - Files changed (${l.lines?.added ?? 0} lines added, ${l.lines?.removed ?? 0} removed): ${l.files.join(", ")}`);
      if (l.note) out.push(`  - Note: ${l.note}`);
    }
  }
  const closes = lines.filter((l) => l.kind === "close");
  if (closes.length) {
    out.push("", "### Campaigns closed", "");
    for (const c of closes)
      out.push(
        `- ${c.campaign} · ${c.date} · ${c.verdict === "land" ? "land the winner" : c.verdict === "cycle" ? "another cycle" : "parked"} · ${plural(c.rounds, "round")}${c.master ? ` · master at ${c.master.slice(0, 10)}` : ""}${
          c.confirm?.length ? ` · confirm run, master → winner: ${c.confirm.map((m) => `${modelName(m)} ${pc(m.master)} → ${pc(m.winner)} (${plural(m.cases, "sealed case")})`).join("; ")}` : ""
        }${c.note ? ` · ${c.note}` : ""}`,
      );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------
// Where things are, and the rule that no arm holds the record
// ---------------------------------------------------------------------------------------------------

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The project a campaign folder sits in (<project>/.cache/ab/<campaign>), or null when it sits elsewhere. */
export function projectOf(campaignDir) {
  const W = resolve(campaignDir);
  return basename(dirname(W)) === "ab" && basename(dirname(dirname(W))) === ".cache" ? dirname(dirname(dirname(W))) : null;
}

/** A project's record file. */
export const recordFile = (project, name) => join(project, RECORD_DIR, `${name}.jsonl`);

/** The folder holding `.sova/ab` that a chat in `dir` could read: `dir` or one above it, up to its repository's top. Null: none. */
export function recordInSight(dir) {
  let d = real(dir);
  for (;;) {
    if (existsSync(join(d, RECORD_DIR))) return d;
    if (existsSync(join(d, ".git"))) return null;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * Why a round may not start: an arm whose folder (its cwd, its worktree, the folder holding its
 * agentDir) still holds the record, or sits inside the campaign's own worktree, where the record is
 * written. One line each, naming the arm. A rescore arm runs nothing, so it is never refused.
 */
export function armRefusals(arms, { project = null, cwd = process.cwd() } = {}) {
  const out = [];
  const own = project ? real(project) : null;
  for (const [a, arm] of Object.entries(arms)) {
    if (arm.how === "rescore") continue;
    const dirs = [arm.cwd ?? (arm.how === "command" ? cwd : null), arm.worktree, arm.agentDir ? dirname(arm.agentDir) : null].filter((d) => typeof d === "string" && d);
    for (const dir of new Set(dirs.map(real))) {
      if (own && (dir === own || dir.startsWith(own + sep))) {
        out.push(`arm ${a}: ${dir} is inside the campaign's own worktree, where the record is written. Every arm, master's too, runs in its own worktree (references/arms.md).`);
        continue;
      }
      const held = recordInSight(dir);
      if (held) out.push(`arm ${a}: ${join(held, RECORD_DIR)} is there for its test chats to read. Remove it in the arm before the round, as an uncommitted delete (references/arms.md).`);
    }
  }
  return [...new Set(out)];
}
