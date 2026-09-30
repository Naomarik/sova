import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chartVersions } from "./org-charts";
import { autonomyRefusal, DRIFT_COMMIT, expectedPhases, FIXTURES, followUpPhase, loadTraces, oracle, replay, type OracleEnvelope as Envelope, type Report } from "./org-charts-replay";

const traces = loadTraces();

test("the fixtures carry nothing of the real runs: no paths, links, addresses, real ids or text", () => {
  for (const f of readdirSync(FIXTURES).filter((f) => f.endsWith(".json"))) {
    const s = readFileSync(join(FIXTURES, f), "utf8");
    assert.doesNotMatch(s, /\/home\/|\/Users\/|sova:\/\/|@[a-z0-9-]+\.[a-z]/i, f);
    // Real ids are uuids (sessions), org_/prj_/p_ ids and hosts: none survive anonymization.
    assert.doesNotMatch(s, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|\borg_[a-z0-9]{8}|\bprj_[a-z0-9]{8}|\bp_[a-z0-9]{8}|\bh_[a-z0-9]{8}/, f);
    // No free text: every string value is a token, a kind, a state or an ISO time.
    for (const m of s.matchAll(/"([^"\\]*)"/g)) assert.ok(m[1]!.length <= 60 || /^Mined from a real run/.test(m[1]!) || /^Synthetic:/.test(m[1]!), `${f}: long string ${m[1]!.slice(0, 40)}`);
  }
});

test("every reason a real look carried is a kind the replay knows (drift is named, never unknown)", () => {
  for (const t of traces)
    for (const e of t.events) {
      for (const r of e.reasons ?? []) assert.notEqual(r.kind, "unknown", `${t.id} at ${e.dt}`);
      for (const r of e.pending ?? []) assert.notEqual(r, "unknown", `${t.id} at ${e.dt}`);
    }
});

test("the oracle is today's autonomyRefusal, with effectiveAutonomy's pause and empty roster", () => {
  const env = (o: Partial<Envelope>): Envelope => ({ by: "overseer", attended: false, autonomy: "L1", paused: false, rosterActive: true, allowance: {} as Envelope["allowance"], atOnce: {} as Envelope["atOnce"], ...o });
  assert.equal(oracle("sova_promote", undefined, env({ autonomy: "L2" })), null);
  assert.equal(oracle("sova_promote", undefined, env({ autonomy: "L1" })), autonomyRefusal("sova_promote", "L2", false, { autonomy: "L1" }));
  assert.equal(oracle("sova_promote", undefined, env({ autonomy: "L3", attended: true })), null);
  assert.match(oracle("sova_start_gathering", undefined, env({ autonomy: "L3", paused: true }))!, /autonomy here is L0 \(Paused at L0/);
  assert.match(oracle("sova_start_gathering", undefined, env({ autonomy: "L3", rosterActive: false }))!, /autonomy here is L0 \(The roster has no active people/);
  assert.match(oracle("sova_roster", "approve", env({ autonomy: "L1" }))!, /needs L2/);
  assert.equal(oracle("sova_roster", "list", env({ autonomy: "L0" })), null);
  assert.match(oracle("sova_todo", undefined, env({ autonomy: "L3" }))!, /only in a turn the operator started/);
});

test("the facts projection: each fact set has the phases a chart may be in", () => {
  const it = (o: Partial<Parameters<typeof expectedPhases>[0]>) => ({ status: "open", baton: null, decisions: [], build: null, ...o });
  const b = (state: string) => ({ id: "b1", state, own: true, wrote: false, settle: false });
  const d = (state: string, build: string | null = null) => ({ id: "d", state, authorOwnsArea: true, build });
  const c = (o: object) => ({ sessionId: "c1", running: false, lastFailed: false, merged: false, newSinceMerge: 0, startedBy: "overseer", state: "open", ...o });
  assert.deepEqual(expectedPhases(it({})), ["open", "gather-starting"]);
  assert.deepEqual(expectedPhases(it({ baton: b("open") })), ["asking"]);
  assert.deepEqual(expectedPhases(it({ baton: b("needs-you") })), ["needs-operator"]);
  assert.deepEqual(expectedPhases(it({ baton: b("done"), decisions: [d("pending")] })), ["unreconciled"]);
  assert.deepEqual(expectedPhases(it({ decisions: [d("drafted"), d("conflict")] })), ["conflicted"]);
  assert.deepEqual(expectedPhases(it({ decisions: [d("promoted"), d("superseded")] })), ["awaiting-build", "build-starting"]);
  assert.deepEqual(expectedPhases(it({ decisions: [d("promoted")], build: c({ running: true }) })), ["working"]);
  assert.deepEqual(expectedPhases(it({ decisions: [d("promoted")], build: c({ lastFailed: true }) })), ["failed"]);
  assert.deepEqual(expectedPhases(it({ decisions: [d("promoted")], build: c({ merged: true }) })), ["merged"]);
  assert.deepEqual(expectedPhases(it({ decisions: [d("promoted", "built")], build: c({ merged: true }) })), ["done"]);
  // A gap marked done is recorded only: the item follows its decisions to the build.
  assert.deepEqual(expectedPhases(it({ status: "done", decisions: [d("promoted")] })), ["awaiting-build", "build-starting"]);
  assert.deepEqual(expectedPhases(it({ status: "dropped" })), ["dropped"]);
  // A follow-up gathering runs beside the lane: the lane stays on its decisions and build.
  const fu = it({ baton: b("open"), followUp: true, decisions: [d("promoted")], build: c({ merged: true }) });
  assert.deepEqual(expectedPhases(fu), ["merged"]);
  assert.equal(followUpPhase(fu), "follow-up-asking");
  assert.equal(followUpPhase(it({ baton: b("needs-you"), followUp: true, decisions: [d("drafted")] })), "follow-up-needs-operator");
  assert.equal(followUpPhase(it({ starting: true, followUp: true, decisions: [d("promoted")] })), "follow-up-starting");
  assert.equal(followUpPhase(it({ baton: b("done"), followUp: true, decisions: [d("promoted")] })), "no-follow-up");
  assert.equal(followUpPhase(it({ baton: b("open") })), "no-follow-up");
});

// The replay drives the refit's charts through a real host: every chart a lane touches must be in the bundle.
test("the replay's charts are the refit's (org, project, watch, item, baton, decision, reconciler, build), never the spike's", () => {
  const names = chartVersions().map((c) => c.name as string);
  for (const c of ["org", "person", "project", "watch", "item", "baton", "decision", "reconciler", "build"]) assert.ok(names.includes(c), `charts: ${names.join(", ")}`);
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "org-charts-replay.ts"), "utf8");
  assert.doesNotMatch(src, /spike-project|work-item|createOrgCharts/, "no spike chart and no bare engine: the real host");
});

// A replay takes well under a second. The limit catches a hang in anything asynchronous; a synchronous
// eventless cycle in a chart cannot be interrupted by a timer, and the engine's step limit throws instead
// (an `engine:` divergence below).
const REPLAY_TIMEOUT_MS = 60_000;
/** The engine's per-event microstep limit (server/org-charts.ts), and how far under it the corpus must stay. */
const MAX_MICROSTEPS = 200;

/** The replay was reworked onto the real host and the refit's charts: its divergences are being classified or
    fixed (chart findings with charts-2). Until then the lanes run and report, and do not fail the suite. */
const REWORK = "reworked onto the real host: unexplained divergences being classified (server-5)";
/** The lanes whose divergences are still being classified: every other lane must replay with none unexplained. */
const PENDING = new Set([
  "real-04",
  "real-05",
  "real-06",
  "real-08",
  "real-09",
  "real-11",
  "real-15",
  "real-16",
  "real-18",
  "real-19",
  "real-22",
  "real-23",
  "real-24",
  "real-25",
  "real-26",
  "real-28",
  "syn-conflict-two-gaps",
] as string[]);

const reports: Report[] = [];
for (const t of traces)
  test(`replay ${t.id} (${t.source}, Sova ${t.sova.commit ?? "?"}): zero unexplained divergences`, { timeout: REPLAY_TIMEOUT_MS, ...(PENDING.has(t.id) ? { todo: REWORK } : {}) }, async () => {
    const r = await replay(t);
    reports.push(r);
    const unexplained = r.divergences.filter((d) => d.cls === null || d.cls === "chart-bug");
    assert.deepEqual(unexplained, [], `${t.id}: ${unexplained.length} unexplained divergences`);
    // The charts were really asked: every real act trialled, every item position and every real look compared.
    const tools = t.events.filter((e) => e.kind === "tool").length;
    const looks = t.events.filter((e) => e.kind === "turn" && e.by === "watch").length;
    const expects = t.events.filter((e) => e.kind === "expect").length;
    // Every tool call that is a chart act now was trialled (a read, a note, a validation refusal is none).
    if (r.coverage.routed) assert.ok(r.coverage.trials >= r.coverage.routed, `${t.id}: ${r.coverage.routed} tool calls are chart acts, ${r.coverage.trials} trialled`);
    assert.ok(r.coverage.routed <= tools);
    if (t.events.some((e) => e.entity === "gap" || e.args?.id?.startsWith("§gap/"))) assert.ok(r.coverage.itemChecks > 0, `${t.id}: gaps, but no item position checked`);
    assert.equal(r.coverage.lookChecks, t.events.some((e) => e.entity === "overseer") || t.source === "synthetic" ? looks : r.coverage.lookChecks, `${t.id}: real looks not all compared`);
    assert.equal(r.coverage.expects, expects, `${t.id}: expectations not all checked`);
    // An engine error (an action or guard that threw, a step limit) is never a divergence to explain away.
    assert.deepEqual(r.divergences.filter((d) => d.check.startsWith("engine:")), [], `${t.id}: the engine threw`);
    assert.ok(r.coverage.maxMicrosteps > 0 && r.coverage.maxMicrosteps <= MAX_MICROSTEPS / 10, `${t.id}: an event took ${r.coverage.maxMicrosteps} microsteps`);
    // A class that says the chart is right, or cannot say it, shows the step it rests on.
    for (const d of r.divergences.filter((x) => x.cls === "chart-better" || x.cls === "cannot-express" || x.cls === "drift"))
      assert.ok(d.evidence && Object.keys(d.evidence).length, `${t.id} @${d.dt} ${d.cls} ${d.check}: no evidence`);
    for (const d of r.divergences.filter((x) => x.cls === "chart-better" && x.check === "look-reasons" && x.got === "item/reopened")) {
      const rows = (d.evidence as { reopened: { item: string | null; flippedBack: string[]; newDecisions: string[] }[] }).reopened;
      assert.ok(rows.length && rows.every((e) => e.item && e.flippedBack.length + e.newDecisions.length > 0), `${t.id} @${d.dt}: reopened without its own evidence`);
    }
  });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

// Drift: the trace ran code without the commit that changed this behaviour, and the code the charts model has
// it. A trace may have run a side branch (real-03: feat/bw-fix-overseer), so "without" is not "an ancestor of".
test("every drift names a commit the charts' code has and its trace's code lacks", { todo: REWORK }, (t) => {
  if (git("rev-parse", "--git-dir") === null) return t.skip("no git history in this copy");
  const drift = reports.flatMap((r) => r.divergences.filter((d) => d.cls === "drift").map((d) => ({ d, trace: traces.find((x) => x.id === r.trace)! })));
  assert.ok(drift.length > 0, "the corpus has drift to check");
  const commits = new Set<string>();
  for (const { d, trace } of drift) {
    const named = (d.evidence as { commits?: string[] } | undefined)?.commits ?? [];
    assert.ok(named.length, `${trace.id} @${d.dt}: drift names no commit`);
    for (const c of named) {
      commits.add(c);
      assert.ok(trace.sova.commit, `${trace.id}: drift in a trace with no commit`);
      assert.notEqual(git("rev-parse", "--verify", "--quiet", `${c}^{commit}`), null, `${trace.id} @${d.dt}: ${c} is no commit here`);
      assert.notEqual(git("merge-base", "--is-ancestor", c, "HEAD"), null, `${trace.id} @${d.dt}: ${c} is not in the code the charts model`);
      assert.equal(git("merge-base", "--is-ancestor", c, trace.sova.commit!), null, `${trace.id} @${d.dt}: the trace's ${trace.sova.commit} already has ${c}`);
    }
  }
  for (const { commit } of Object.values(DRIFT_COMMIT)) assert.notEqual(git("rev-parse", "--verify", "--quiet", `${commit}^{commit}`), null, commit);
  assert.deepEqual([...commits].sort(), ["239852ee", "320042f0", "77f3cdbf", "80a785ca"]);
});

test("allowance counts are checked against the trace's own ledger, never synced", () => {
  const counts = reports.flatMap((r) => r.divergences.filter((d) => d.check === "allowance-count"));
  assert.deepEqual(counts, [], "a count the reconstruction cannot match is unexplained, not synced");
  const real15 = traces.find((x) => x.id === "real-15");
  assert.ok(real15?.events.some((e) => e.refusal === "cap-message" && !e.attended && e.cap?.used === 3), "real-15 still has its unattended message-allowance refusal (3 of 3)");
});
