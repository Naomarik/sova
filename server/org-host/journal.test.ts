// Run: node scripts/run-tests.mjs server/org-host/journal.test.ts. The redo journal with history in it:
// torn last lines, rows and events once on replay, journals from before
// row keys, a failed commit before and after its journal, the safety acts, effect answers during an
// outage, the capture gap across a restart, and a stale index.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { HistoryInput } from "../../shared/org-history";
import type { EngineOptions, Step } from "../statecharts";
import { OrgHost, type ComposeContext, type HistoryComposer, type OrgHostOptions } from "./index";
import { appendLines, type TornTail } from "./log";
import { applyJournal, missingOf, replayJournals, type Journal } from "./store";
import { HOST_STATECHARTS } from "./test-statechart";

const dirs: string[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const d of locked.splice(0)) chmodSync(d, 0o755);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function place() {
  const root = mkdtempSync(join(tmpdir(), "org-journal-"));
  dirs.push(root);
  return { root, workspaceDir: join(root, "ws"), stateDir: join(root, "state") };
}

function open(where: { workspaceDir: string; stateDir: string }, more: Partial<OrgHostOptions> = {}) {
  return OrgHost.open({ orgId: "o1", ...where, durable: false, statecharts: HOST_STATECHARTS as unknown as EngineOptions["statecharts"], ...more });
}

const operator = { by: "operator" };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, what: string, guardMs = 10_000): Promise<void> {
  const end = Date.now() + guardMs;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`still waiting: ${what}`);
    await tick(5);
  }
}

/** One event per saved, refused or held step: the act's step gets the caller's actors and rationale. */
function composer(opts: { fail?: () => boolean } = {}): HistoryComposer {
  return (steps: Step[], ctx: ComposeContext): HistoryInput[] => {
    if (opts.fail?.()) throw new Error("the disk is full");
    return steps
      .filter((s) => s.event !== "sova/resumed")
      .map((s, i) => {
        const mine = ctx.act && s.sessionId === ctx.act.sessionId && s.event === ctx.act.event;
        return {
          kind: s.event === "effect/done" ? "merge.observed" : "request.made",
          outcome: s.refused ? "refused" : s.held ? "held" : "done",
          projects: { primary: "p1" },
          actors: mine ? { initiatedBy: { kind: "operator" }, ...(ctx.provenance?.actors ?? {}) } : {},
          source: { adapter: "test", version: 1, key: `${ctx.journalId}:${i}:${s.event}` },
          ...(mine && ctx.provenance?.rationale ? { rationale: ctx.provenance.rationale } : {}),
        } satisfies HistoryInput;
      });
  };
}

function eventLines(ws: string): Record<string, unknown>[] {
  const dir = join(ws, "history", "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("torn last lines", () => {
  test("a live append never cuts a fragment, even a 2-byte one: it is kept, closed with a newline, and reported", () => {
    const at = place();
    const file = join(at.root, "seg.jsonl");
    writeFileSync(file, '{"a":1}\n{"');
    const torn: TornTail[] = [];
    appendLines(file, ['{"b":2}'], false, (t) => torn.push(t));
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"\n{"b":2}\n');
    assert.deepEqual(torn, [{ file, fragment: '{"', cut: false }]);
  });

  test("a replay cuts the fragment only when it begins a line of the journal not yet on disk", () => {
    const at = place();
    const file = join(at.root, "seg.jsonl");
    writeFileSync(file, '{"a":1}\n{"k":"j1:0","x');
    const torn: TornTail[] = [];
    appendLines(file, ['{"k":"j1:0","x":1}'], false, (t) => torn.push(t), true);
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"k":"j1:0","x":1}\n');
    assert.equal(torn[0]?.cut, true);
    // a fragment no line of the journal begins with is kept, even on a replay
    writeFileSync(file, '{"a":1}\n{"other');
    appendLines(file, ['{"k":"j2:0"}'], false, (t) => torn.push(t), true);
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n{"other\n{"k":"j2:0"}\n');
    assert.equal(torn[1]?.cut, false);
  });

  test("a host's torn segment is a workspace problem (kind log), and the next row starts on its own line", async () => {
    const at = place();
    const host = await open(at);
    await host.start("p/1", "host-probe", {}, operator);
    const seg = readdirSync(host.paths.portableLog)[0]!;
    writeFileSync(join(host.paths.portableLog, seg), readFileSync(join(host.paths.portableLog, seg), "utf8") + '{"at":');
    await host.act("p/1", "count", {}, operator);
    assert.ok(host.problems().some((p) => p.kind === "log" && p.file.endsWith(seg) && /cut short/.test(p.why)));
    assert.equal(host.log.rows({ session: "p/1" }).filter((r) => r.event === "count").length, 1);
    await host.close();
  });
});

describe("replay", () => {
  test("a torn multi-row append: replay appends only the rows missing, each once, and checks them", () => {
    const at = place();
    const file = join(at.root, "log", "2026-10.jsonl");
    const j: Journal = {
      id: "j1",
      at: 1,
      snapshots: [],
      rows: [0, 1, 2].map((i) => ({ file, row: { at: i + 1, org: "o1", session: "s", statechart: "c", event: `e${i}`, by: null, envelope: {}, before: [], after: [], changed: {}, effects: [], j: "j1", k: `j1:${i}` } })),
    };
    // the first row made it, the second tore
    mkdirSync(join(at.root, "log"), { recursive: true });
    const lines = j.rows.map((r) => JSON.stringify(r.row));
    writeFileSync(file, `${lines[0]}\n${lines[1]!.slice(0, 10)}`);
    applyJournal(j, false, true);
    assert.deepEqual(readFileSync(file, "utf8").split("\n").filter(Boolean), lines);
    assert.deepEqual(missingOf(j), []);
  });

  test("a journal written before rows had keys still replays its rows once (by its journal id)", () => {
    const at = place();
    const jdir = join(at.root, "journal");
    const file = join(at.root, "log", "2026-10.jsonl");
    mkdirSync(jdir, { recursive: true });
    const old = { id: "000000000000001-1-000001", at: 1, snapshots: [], rows: [{ file, row: { at: 1, org: "o1", session: "s", statechart: "c", event: "old", by: null, envelope: {}, before: [], after: [], changed: {}, effects: [], j: "000000000000001-1-000001" } }] };
    writeFileSync(join(jdir, `${old.id}.json`), JSON.stringify(old));
    assert.deepEqual(replayJournals(jdir, false), { applied: 1, problem: null });
    writeFileSync(join(jdir, `${old.id}.json`), JSON.stringify(old));
    assert.deepEqual(replayJournals(jdir, false), { applied: 1, problem: null });
    assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 1, "appended once");
  });

  test("a replayed purge is checked: a rationale file still there makes the journal a problem", () => {
    const at = place();
    const gone = join(at.root, "rationale.json");
    writeFileSync(gone, "{}");
    const j: Journal = { id: "j2", at: 1, snapshots: [], rows: [], history: { lines: [], files: [], removes: [gone] } };
    assert.deepEqual(missingOf(j), [`${gone} (still there)`]);
    applyJournal(j, false, true);
    assert.deepEqual(missingOf(j), []);
  });
});

describe("a failed commit", () => {
  test("before its journal: nothing changes, the act is refused with the sentence, and saving recovers", async () => {
    const at = place();
    let fail = false;
    const host = await open(at);
    host.setHistoryComposer(composer({ fail: () => fail }));
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "count", {}, operator);
    const before = eventLines(at.workspaceDir).length;
    fail = true;
    const r = await host.act("p/1", "count", {}, operator);
    assert.equal(r.taken, false);
    assert.equal(r.refusal?.sentence, "History can't be saved right now: the disk is full. Nothing was done.");
    assert.equal(host.data("p/1")?.["n"], 1, "memory is back to what the files hold");
    assert.equal(host.log.rows({ session: "p/1" }).filter((x) => x.event === "count").length, 1);
    assert.equal(eventLines(at.workspaceDir).length, before);
    assert.deepEqual(readdirSync(host.paths.journal), []);
    assert.ok(host.problems().some((p) => p.kind === "history"));
    fail = false;
    const again = await host.act("p/1", "count", {}, operator);
    assert.equal(again.taken, true, again.refusal?.sentence);
    assert.equal(host.data("p/1")?.["n"], 2);
    assert.ok(!host.problems().some((p) => p.kind === "history"));
    await host.close();
    const reopened = await open(at);
    assert.equal(reopened.data("p/1")?.["n"], 2);
    await reopened.close();
  });

  test("a journal-phase failure (beforeJournal) restores memory and refuses", async () => {
    const at = place();
    let fail = false;
    const host = await open(at, { commitHooks: { beforeJournal: () => { if (fail) throw new Error("no space left"); } } });
    host.setHistoryComposer(composer());
    await host.start("p/1", "host-probe", {}, operator);
    fail = true;
    const r = await host.act("p/1", "count", {}, operator);
    assert.match(r.refusal?.sentence ?? "", /^History can't be saved right now: no space left\. Nothing was done\.$/);
    assert.equal(host.data("p/1")?.["n"] ?? 0, 0);
    fail = false;
    assert.equal((await host.act("p/1", "count", {}, operator)).taken, true);
    await host.close();
  });

  test("after its journal: applied again at once; taken when that works, else 'saved, not applied', never 'nothing was done'", async () => {
    const at = place();
    let crash = false;
    let retryFails = false;
    const host = await open(at, { commitHooks: { afterJournal: () => { if (crash) throw new Error("killed"); }, retryApply: () => { if (retryFails) throw new Error("still failing"); } } });
    host.setHistoryComposer(composer());
    await host.start("p/1", "host-probe", {}, operator);
    crash = true;
    const ok = await host.act("p/1", "count", {}, operator);
    assert.equal(ok.taken, true, "the retry applied it");
    assert.deepEqual(readdirSync(host.paths.journal), []);
    assert.equal(host.log.rows({ session: "p/1" }).filter((x) => x.event === "count").length, 1);
    retryFails = true;
    const pending = await host.act("p/1", "count", {}, operator);
    assert.equal(pending.taken, false);
    assert.equal(pending.refusal?.stage, "pending-apply");
    assert.equal(pending.refusal?.sentence, "Saved, but not applied yet: it takes effect when the workspace reloads.");
    assert.equal(readdirSync(host.paths.journal).length, 1);
    crash = false;
    retryFails = false;
    await host.reload();
    assert.deepEqual(readdirSync(host.paths.journal), []);
    assert.equal(host.log.rows({ session: "p/1" }).filter((x) => x.event === "count").length, 2, "the saved act took effect, once");
    assert.equal(host.data("p/1")?.["n"], 2);
    await host.close();
  });
});

describe("history can't be saved", () => {
  function outage(at: { workspaceDir: string; stateDir: string }) {
    const events = join(at.workspaceDir, "history", "events");
    mkdirSync(events, { recursive: true });
    return {
      start() {
        chmodSync(events, 0o500);
        locked.push(events);
      },
      end() {
        chmodSync(events, 0o755);
        locked.splice(locked.indexOf(events), 1);
      },
    };
  }

  test("only a listed safety act goes (hold/cancel), covered by a capture gap recorded once saving works; others are refused", async () => {
    const at = place();
    let fail = false;
    const host = await open(at, { clock: () => 10_000 });
    host.setHistoryComposer(composer({ fail: () => fail }));
    await host.start("p/1", "host-probe", {}, operator);
    const held = await host.act("p/1", "gather/start", {}, { by: "overseer", attended: false, holdMs: 60_000, projectId: "prj1", overseerId: "po1" });
    assert.ok(held.held, "held");
    const out = outage(at);
    out.start();
    fail = true;
    const refused = await host.act("p/1", "count", {}, operator);
    assert.match(refused.refusal?.sentence ?? "", /^History can't be saved right now: .*Nothing was done\.$/);
    // a caller can't make an act a safety act: only the list decides
    const claimed = await host.act("p/1", "count", { safety: true }, operator);
    assert.equal(claimed.taken, false);
    const cancel = await host.act("p/1", "hold/cancel", { id: held.held!.id, reason: "stop it" }, operator);
    assert.equal(cancel.taken, true, cancel.refusal?.sentence);
    assert.ok(existsSync(join(at.stateDir, "org-history", "o1", "gap.json")), "the gap is noted host-local");
    out.end();
    fail = false;
    await host.act("p/1", "count", {}, operator);
    const gaps = eventLines(at.workspaceDir).filter((e) => e["kind"] === "history.gap");
    assert.equal(gaps.length, 1);
    assert.ok(!existsSync(join(at.stateDir, "org-history", "o1", "gap.json")));
    assert.equal(host.history.coverage({ role: "operator" }).gaps.length, 1);
    await host.close();
  });

  test("a restart mid-outage still records the gap", async () => {
    const at = place();
    let fail = false;
    const host = await open(at);
    host.setHistoryComposer(composer({ fail: () => fail }));
    await host.start("p/1", "host-probe", {}, operator);
    const held = await host.act("p/1", "gather/start", {}, { by: "overseer", attended: false, holdMs: 60_000, projectId: "prj1", overseerId: "po1" });
    const out = outage(at);
    out.start();
    fail = true;
    await host.act("p/1", "count", {}, operator);
    const c = await host.act("p/1", "hold/cancel", { id: held.held!.id, reason: "stop" }, operator);
    assert.equal(c.taken, true, c.refusal?.sentence);
    await host.close();
    out.end();
    const again = await open(at);
    again.setHistoryComposer(composer());
    await again.act("p/1", "count", {}, operator);
    assert.equal(eventLines(at.workspaceDir).filter((e) => e["kind"] === "history.gap").length, 1);
    await again.close();
  });

  test("an effect that finished during an outage: its answer waits, then is applied once with its event", async () => {
    const at = place();
    let fail = false;
    const host = await open(at);
    host.setHistoryComposer(composer({ fail: () => fail }));
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    host.effects.register("write", async () => {
      runs++;
      await gate;
      return { ok: true };
    });
    await host.start("p/1", "host-probe", {}, operator);
    assert.equal((await host.act("p/1", "go", {}, operator)).taken, true);
    const out = outage(at);
    out.start();
    fail = true;
    // make the host notice: an act fails, then the effect answers into the outage
    await host.act("p/1", "count", {}, operator);
    release();
    await tick(20);
    assert.deepEqual(host.configuration("p/1"), ["top", "busy"], "the answer waits");
    out.end();
    fail = false;
    assert.equal((await host.act("p/1", "count", {}, operator)).taken, true);
    await until(() => host.configuration("p/1")?.includes("idle") ?? false, "the waiting answer goes in");
    assert.equal(host.data("p/1")?.["done"], 1, "applied once");
    assert.equal(runs, 1);
    assert.equal(eventLines(at.workspaceDir).filter((e) => e["kind"] === "merge.observed").length, 1, "its event recorded");
    await host.close();
  });
});

describe("the index", () => {
  test("a stale index is rebuilt before the next prepare, so a key is never taken for new", async () => {
    const at = place();
    const host = await open(at);
    const ids = await host.record([{ kind: "request.made", outcome: "done", projects: { primary: "p1" }, actors: {}, source: { adapter: "t", version: 1, key: "k1" } }]);
    // the in-memory index loses the event (as when an update threw)
    (host.history.index as unknown as { reset(): void }).reset();
    host.history.stale = true;
    const again = await host.record([{ kind: "request.made", outcome: "done", projects: { primary: "p1" }, actors: {}, source: { adapter: "t", version: 1, key: "k1" } }]);
    assert.deepEqual(again, ids);
    assert.equal(eventLines(at.workspaceDir).length, 1);
    await host.close();
  });

  test("a corrupt index.json is rebuilt at open, before any act", async () => {
    const at = place();
    const host = await open(at);
    const [id] = await host.record([{ kind: "request.made", outcome: "done", projects: { primary: "p1" }, actors: {}, source: { adapter: "t", version: 1, key: "k1" } }]);
    await host.close();
    writeFileSync(join(at.stateDir, "org-history", "o1", "index.json"), "{not json");
    const again = await open(at);
    assert.deepEqual(await again.record([{ kind: "request.made", outcome: "done", projects: { primary: "p1" }, actors: {}, source: { adapter: "t", version: 1, key: "k1" } }]), [id]);
    await again.close();
  });
});

describe("the composer from the open on", () => {
  test("a timer due at boot is captured by the composer passed to open", async () => {
    const at = place();
    let now = 1_000;
    const host = await open(at, { clock: () => now, historyComposer: composer() });
    await host.start("p/1", "host-probe", {}, operator);
    await host.act("p/1", "wait", {}, operator);
    await host.close();
    const before = eventLines(at.workspaceDir).length;
    now += 1_000;
    const again = await open(at, { clock: () => now, historyComposer: composer() });
    assert.deepEqual(again.configuration("p/1"), ["top", "idle"], "the tick fired at boot");
    assert.ok(eventLines(at.workspaceDir).length > before, "its step has an event");
    await again.close();
  });
});

