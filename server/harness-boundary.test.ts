// Run: pnpm test -- server/harness-boundary.test.ts. The harness boundary (§app.harness/boundary): nothing
// outside server/harness/pi/ reaches pi beyond server/harness/boundary-baseline.json, a list that only
// shrinks. Five ratchets (pi imports; raw entry reads: calls, shapes, reaches; custom-entry writes and
// their wrappers; pi agent-session reaches through `.session`; uses of the adapter's raw custom-entry hand-out,
// `extensionEntries`), each exact per file, plus rules with no baseline at all (re-exports, the contract's
// types-only rule, test-only adapter imports, casts into the driving session, ad-hoc StateKinds) and the
// runner's coverage of every test file. The fixtures in server/harness/fixtures/boundary/ prove each rule's forms.
// SOVA_BOUNDARY_OUT=<absolute path> writes the computed baseline there (the assertions still run).
// This file sits at server/ top level on purpose: the server/*.test.ts glob runs it even if the harness
// glob were dropped, and the runner-coverage block asserts that glob.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import {
  type Baseline, type FileScan, EXCLUDED, baselineOf, formatBaseline, globRegex, growth, listFiles, runnerGlobs, scanRepo, scanText,
} from "./harness/boundary-scan.ts";

const REPO = resolve(import.meta.dirname, "..");
const BASELINE = "server/harness/boundary-baseline.json";
const FIXTURES = "server/harness/fixtures/boundary";

const files = listFiles(REPO);
const repo = scanRepo(REPO, files);
const actual = baselineOf(repo);
if (process.env.SOVA_BOUNDARY_OUT) {
  writeFileSync(process.env.SOVA_BOUNDARY_OUT, formatBaseline(actual));
  console.log(`[boundary] wrote the computed baseline to ${process.env.SOVA_BOUNDARY_OUT}`);
}
const baseline: Baseline = JSON.parse(readFileSync(join(REPO, BASELINE), "utf8"));

/** Every hit of one counter in one file, as `line (rule)`, for a failure message. */
const where = (hits: { line: number; rule: string }[]) => hits.slice(0, 8).map((h) => `:${h.line} (${h.rule})`).join(", ") + (hits.length > 8 ? ", …" : "");
const scanOf = (f: string): FileScan => repo.scans.get(f)!;
const fail = (problems: string[]) => assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);

// ---- 1. The scanner, proved on fixtures ------------------------------------------------------------

interface Block { file: string; name: string; path: string; expect: Record<string, unknown>; text: string }

function fixtureBlocks(file: string): Block[] {
  const text = readFileSync(join(REPO, FIXTURES, file), "utf8");
  const head = /^\/\/ ---- (.+?)(?: path=(\S+))? expect=(\{.*\})$/;
  const def = /default-path=(\S+)/.exec(text.slice(0, text.indexOf("\n// ---- ")))?.[1] ?? "server/fixture.ts";
  const blocks: Block[] = [];
  for (const line of text.split("\n")) {
    const m = head.exec(line);
    if (m) blocks.push({ file, name: m[1]!, path: m[2] ?? def, expect: JSON.parse(m[3]!), text: "" });
    else if (blocks.length) blocks.at(-1)!.text += `${line}\n`;
  }
  return blocks;
}

const resultOf = (s: FileScan) => ({
  imports: s.imports,
  calls: s.calls.length,
  shapes: s.shapes.length,
  reaches: s.reaches.length,
  writers: s.writers.length,
  session: s.sessionReaches.length,
  extension: s.extension.length,
  wrappers: s.wrappers.map((w) => w.name),
  violations: s.violations.map((v) => v.code),
});
const EMPTY = { imports: null, calls: 0, shapes: 0, reaches: 0, writers: 0, session: 0, extension: 0, wrappers: [], violations: [] };

describe("the boundary scanner, on fixtures", () => {
  const fixtureFiles = readdirSync(join(REPO, FIXTURES)).filter((f) => f.endsWith(".ts.txt")).sort();
  test("every rule has its fixture file, each with uniquely named blocks", () => {
    assert.deepEqual(fixtureFiles, ["contract.ts.txt", "escapes.ts.txt", "extension.ts.txt", "imports.ts.txt", "reaches.ts.txt", "readers.ts.txt", "session.ts.txt", "wrappers.ts.txt", "writers.ts.txt"]);
    for (const f of fixtureFiles) {
      const names = fixtureBlocks(f).map((b) => b.name);
      assert.ok(names.length >= 9, `${f}: ${names.length} blocks`);
      assert.equal(new Set(names).size, names.length, `${f}: a block name repeats`);
    }
  });
  for (const f of fixtureFiles)
    for (const b of fixtureBlocks(f))
      test(`${f}: ${b.name}`, () => {
        for (const k of Object.keys(b.expect)) assert.ok(k in EMPTY, `unknown expectation key ${k}`);
        assert.deepEqual(resultOf(scanText(b.path, b.text)), { ...EMPTY, ...b.expect }, `${f} block "${b.name}" at ${b.path}`);
      });
});

// ---- 2. Coverage sanity: the scan can't pass by seeing nothing -------------------------------------

describe("the scan sees the repository", () => {
  test("Zone A and Zone B are the size they should be, and the baseline is not empty", () => {
    assert.ok(repo.zoneA.length >= 1000, `Zone A: ${repo.zoneA.length} files`);
    assert.ok(repo.zoneA.includes("server/index.ts"));
    assert.ok(repo.zoneA.includes("src/App.tsx"));
    assert.ok(repo.zoneB.length >= 30, `Zone B: ${repo.zoneB.length} files`);
    assert.ok(repo.zoneB.includes("pi-config/extensions/mode/state.ts"));
    assert.ok(Object.keys(baseline.imports).length > 0 && Object.keys(baseline.readers).length > 0);
  });
  test("every exclusion names an existing path", () => {
    for (const e of EXCLUDED) assert.ok(existsSync(join(REPO, e)), `stale exclusion: ${e}`);
  });
});

// ---- 3-5. The ratchets -----------------------------------------------------------------------------

describe("the ratchets hold exactly at the baseline", () => {
  test("pi imports", () => {
    const problems: string[] = [];
    for (const [f, kind] of Object.entries(actual.imports)) {
      const was = baseline.imports[f];
      const hits = where(scanOf(f).importHits);
      if (!was) problems.push(`${f}${hits}: new pi import. Route it through server/harness/pi/ or shared/harness.ts; the baseline never grows without the user's say-so.`);
      else if (was === "type" && kind === "runtime") problems.push(`${f}${hits}: listed as a type-only import, now reaches pi at runtime. Keep it type-only, or move the code into server/harness/pi/.`);
      else if (was === "runtime" && kind === "type") problems.push(`${f}: stale, it is type-only now. Set its entry to "type" in ${BASELINE}.`);
    }
    for (const f of Object.keys(baseline.imports)) if (!actual.imports[f]) problems.push(`${f}: stale, it no longer reaches pi. Delete its entry from ${BASELINE}.`);
    fail(problems);
  });

  test("raw entry reads (calls, shapes, reaches)", () => {
    const problems: string[] = [];
    const zero = { calls: 0, shapes: 0, reaches: 0 };
    for (const f of new Set([...Object.keys(actual.readers), ...Object.keys(baseline.readers)])) {
      const now = actual.readers[f] ?? zero;
      const was = baseline.readers[f];
      if (!was) {
        const s = scanOf(f);
        problems.push(`${f}: new raw pi entry reads${where([...s.calls, ...s.shapes, ...s.reaches])}. Read through server/harness/ (the neutral reader, SessionState), not pi's entries.`);
        continue;
      }
      if (!actual.readers[f]) {
        problems.push(`${f}: stale, it has no raw reads left. Delete its entry from ${BASELINE}.`);
        continue;
      }
      for (const c of ["calls", "shapes", "reaches"] as const) {
        if (now[c] > (was[c] ?? 0)) problems.push(`${f}: ${c} ${was[c] ?? 0} → ${now[c]}, a new raw read${where(scanOf(f)[c])}. Read through server/harness/, not pi's entries.`);
        else if (now[c] < (was[c] ?? 0)) problems.push(`${f}: ${c} is ${now[c]}, below the baseline's ${was[c]}. Lower it to ${now[c]} in ${BASELINE} in this change.`);
      }
    }
    fail(problems);
  });

  test("custom-entry writes and the functions that forward an entry type", () => {
    const problems: string[] = [];
    for (const f of new Set([...Object.keys(actual.writers), ...Object.keys(baseline.writers)])) {
      const now = actual.writers[f] ?? 0;
      const was = baseline.writers[f];
      if (was === undefined) problems.push(`${f}: new custom-entry writes${where(scanOf(f).writers)}. Per-session state goes through SessionState, never a raw custom entry.`);
      else if (now > was) problems.push(`${f}: writes ${was} → ${now}${where(scanOf(f).writers)}. Per-session state goes through SessionState, never a raw custom entry.`);
      else if (now === 0) problems.push(`${f}: stale, it writes no custom entry now. Delete its entry from ${BASELINE}.`);
      else if (now < was) problems.push(`${f}: writes ${now}, below the baseline's ${was}. Lower it to ${now} in ${BASELINE} in this change.`);
    }
    for (const w of actual.wrappers) if (!baseline.wrappers.includes(w)) problems.push(`${w}: forwards its parameter as a custom entry's type, a new writer. Use SessionState's registered kinds instead.`);
    for (const w of baseline.wrappers) if (!actual.wrappers.includes(w)) problems.push(`${w}: stale wrapper, gone. Delete it from ${BASELINE}'s wrappers.`);
    fail(problems);
  });

  test("pi agent-session reaches through .session (§app.harness/boundary)", () => {
    const problems: string[] = [];
    for (const f of new Set([...Object.keys(actual.session), ...Object.keys(baseline.session ?? {})])) {
      const now = actual.session[f] ?? 0;
      const was = baseline.session?.[f];
      if (was === undefined) problems.push(`${f}: new reaches into pi's agent session${where(scanOf(f).sessionReaches)}. Ask the chat's driving session (chat.harness, shared/harness-session.ts) or a ChatSession method instead.`);
      else if (now > was) problems.push(`${f}: session reaches ${was} → ${now}${where(scanOf(f).sessionReaches)}. Ask chat.harness (shared/harness-session.ts) instead.`);
      else if (now === 0) problems.push(`${f}: stale, it has no session reach left. Delete its entry from ${BASELINE}'s session list.`);
      else if (now < was) problems.push(`${f}: session reaches ${now}, below the baseline's ${was}. Lower it to ${now} in ${BASELINE} in this change.`);
    }
    fail(problems);
  });

  test("raw custom entries handed out by extensionEntries (§app.harness/boundary)", () => {
    const problems: string[] = [];
    for (const f of new Set([...Object.keys(actual.extension), ...Object.keys(baseline.extension ?? {})])) {
      const now = actual.extension[f] ?? 0;
      const was = baseline.extension?.[f];
      if (was === undefined) problems.push(`${f}: new use of extensionEntries${where(scanOf(f).extension)}. Read state through a StateView (stateView, ToolCtx.state()); raw entries are only for the pi-config cores already listed.`);
      else if (now > was) problems.push(`${f}: extensionEntries ${was} → ${now}${where(scanOf(f).extension)}. Read state through a StateView instead.`);
      else if (now === 0) problems.push(`${f}: stale, it no longer uses extensionEntries. Delete its entry from ${BASELINE}'s extension list.`);
      else if (now < was) problems.push(`${f}: extensionEntries ${now}, below the baseline's ${was}. Lower it to ${now} in ${BASELINE} in this change.`);
    }
    fail(problems);
  });

  test("only the adapter imports the pi worker-transcript adapter", () => {
    const problems: string[] = [];
    for (const f of actual.piAdapter) if (!baseline.piAdapter.includes(f)) problems.push(`${f}: imports pi-config/extensions/subagents/adapters/pi.ts. Only server/harness/pi/ may.`);
    for (const f of baseline.piAdapter) if (!actual.piAdapter.includes(f)) problems.push(`${f}: stale, no longer imports the pi adapter. Delete it from ${BASELINE}'s piAdapter.`);
    fail(problems);
  });

  test("nothing re-exports a raw API, shared/harness*.ts hold types only, and no file has a rule-only escape", () => {
    const contract = repo.zoneA.filter((f) => /^shared\/harness(-[a-z]+)?\.ts$/.test(f));
    assert.deepEqual(contract, ["shared/harness-core.ts", "shared/harness-history.ts", "shared/harness-session.ts", "shared/harness-state.ts", "shared/harness-tools.ts", "shared/harness-wire.ts", "shared/harness.ts"]);
    fail(repo.zoneA.flatMap((f) => scanOf(f).violations.map((v) => `${f}:${v.line}: ${v.message}`)));
  });
});

// ---- 6. Runner coverage (a11) ----------------------------------------------------------------------

describe("the test runner runs every test file", () => {
  const globs = runnerGlobs(readFileSync(join(REPO, "scripts/run-tests.mjs"), "utf8"));
  test("GLOBS reads by AST, and the glob translation is the runner's", () => {
    assert.ok(globs.includes("server/*.test.ts") && globs.includes("server/harness/**/*.test.ts"), globs.join(", "));
    assert.ok(globRegex("server/harness/**/*.test.ts").test("server/harness/pi/contract.test.ts"));
    assert.ok(globRegex("server/harness/**/*.test.ts").test("server/harness/a.test.ts"));
    assert.ok(!globRegex("server/*.test.ts").test("server/harness/a.test.ts"));
  });
  test("every *.test.ts under server/, shared/ and src/ is matched by a glob", () => {
    const res = globs.map(globRegex);
    const tests = files.filter((f) => /^(server|shared|src)\/.*\.test\.ts$/.test(f));
    assert.ok(tests.length > 500, `${tests.length} test files`);
    const missed = tests.filter((f) => !res.some((r) => r.test(f)));
    assert.deepEqual(missed, [], `these test files never run: add a glob for them to scripts/run-tests.mjs GLOBS`);
  });
});

// ---- 7. HEAD growth guard ----------------------------------------------------------------------------

describe("the baseline in the working tree never grows past the committed one", () => {
  test("no new file, no higher count, no type → runtime", (t) => {
    let head: Baseline;
    try {
      head = JSON.parse(execFileSync("git", ["show", `HEAD:${BASELINE}`], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      console.log(`[boundary] HEAD guard skipped: no committed ${BASELINE} (or no git). The ratchets above still ran.`);
      t.skip?.("no committed baseline");
      return;
    }
    const grew = growth(head, baseline);
    assert.deepEqual(grew, [], `\n${BASELINE} grew against HEAD:\n${grew.join("\n")}\nThe baseline only shrinks: revert this edit and route the change through server/harness/ (growing it needs the user's say-so).\n`);
  });
});
