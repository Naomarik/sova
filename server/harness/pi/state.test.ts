// Run: pnpm test -- server/harness/pi/state.test.ts. pi's SessionState (§app.harness/state): a write is one
// call of pi's own append with the caller's object, nothing else on the path, so its bytes are the direct
// call's; a new session file seeded with state is today's hand-written [header, ...entries]; reads are live;
// the test-only check refuses an unregistered kind or a malformed record and is off by default.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { StateKind } from "../../../shared/harness";
import { BATON_HANDOFF, LOADOUT, OVERSEER, PROFILE, RULE, SUBAGENT_PROFILE } from "../state-kinds";
import { appendToClosedFile, createSessionFile, piSessionState, stateOf, stateViewOf, toolStateWriter } from "./state";
import { loadPi } from "./testing/load-pi.ts";

const { SessionManager } = (await loadPi()).agent;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-state-")));

/** Entry ids and ISO times replaced in order of appearance, on the raw text (key order untouched). */
function canonical(text: string): string {
  const ids = new Map<string, string>();
  return text
    .replace(/"(id|parentId)":"([0-9a-f]{8})"/g, (_, k: string, id: string) => {
      if (!ids.has(id)) ids.set(id, String(ids.size + 1).padStart(8, "0"));
      return `"${k}":"${ids.get(id)}"`;
    })
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "2000-01-01T00:00:00.000Z");
}

const header = (id: string, cwd: string) => ({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
const LOADOUT_DATA = { offSkills: ["s"], v: 1 as const, offContext: ["/a"] };

describe("piSessionState", () => {
  test("append is one appendCustomEntry with the kind's type and the caller's object, returning its id", () => {
    const calls: unknown[][] = [];
    const sm = { appendCustomEntry: (...a: unknown[]) => (calls.push(a), "abcd0001"), getBranch: () => [], getEntries: () => [] };
    const data = { ...LOADOUT_DATA };
    assert.equal(piSessionState(sm as any).append(LOADOUT, data), "abcd0001");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "sova-loadout");
    assert.equal(calls[0]![1], data, "the object itself, never a copy");
  });

  test("a write to an open file is the direct call's line, byte for byte", () => {
    const file = join(dir, "open.jsonl");
    writeFileSync(file, `${JSON.stringify(header("0198a000-0000-7000-8000-000000000001", dir))}\n${JSON.stringify({ type: "message", id: "aaaa0001", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } })}\n`);
    const twin = join(dir, "open-twin.jsonl");
    copyFileSync(file, twin);
    const id = piSessionState(SessionManager.open(file)).append(LOADOUT, LOADOUT_DATA);
    SessionManager.open(twin).appendCustomEntry("sova-loadout", LOADOUT_DATA);
    assert.match(id, /^[0-9a-f]{8}$/);
    assert.equal(canonical(readFileSync(file, "utf8")), canonical(readFileSync(twin, "utf8")));
    const last = readFileSync(file, "utf8").trimEnd().split("\n").at(-1)!;
    assert.match(last, new RegExp(`^\\{"type":"custom","customType":"sova-loadout","data":\\{"offSkills":\\["s"\\],"v":1,"offContext":\\["/a"\\]\\},"id":"${id}","parentId":"aaaa0001","timestamp":"[^"]+"\\}$`), "the data's key order as given");
  });

  test("appendToClosedFile is SessionManager.open plus the append", () => {
    const file = join(dir, "closed.jsonl");
    writeFileSync(file, `${JSON.stringify(header("0198a000-0000-7000-8000-000000000002", dir))}\n`);
    const twin = join(dir, "closed-twin.jsonl");
    copyFileSync(file, twin);
    appendToClosedFile(file, SUBAGENT_PROFILE, { v: 1, profile: "off" });
    SessionManager.open(twin).appendCustomEntry("subagent-profile", { v: 1, profile: "off" });
    assert.equal(canonical(readFileSync(file, "utf8")), canonical(readFileSync(twin, "utf8")));
  });

  test("branch() and file() read the manager live", () => {
    let branch: unknown[] = [];
    const sm = { appendCustomEntry: () => "", getBranch: () => branch, getEntries: () => [...branch, { type: "custom", id: "x2", parentId: null, customType: "sova-overseer", data: { v: 1 } }] };
    const state = piSessionState(sm as any);
    assert.equal(state.branch().latest(PROFILE), null);
    branch = [{ type: "custom", id: "x1", parentId: null, timestamp: "t", customType: "sova-profile", data: { v: 1, profile: null } }];
    assert.deepEqual(state.branch().latest(PROFILE), { id: "x1", parentId: null, at: "t", data: { v: 1, profile: null } });
    assert.equal(state.branch().has(OVERSEER), false);
    assert.equal(state.file().has(OVERSEER), true);
  });
});

describe("stateOf and toolStateWriter", () => {
  test("stateOf reads session.sessionManager on every call", () => {
    const wrote: string[] = [];
    const manager = (name: string) => ({ appendCustomEntry: () => (wrote.push(name), name), getBranch: () => [], getEntries: () => [] });
    const session = { sessionManager: manager("a") };
    const state = stateOf(session as any);
    state.append(OVERSEER, { v: 1 });
    session.sessionManager = manager("b");
    assert.equal(state.append(OVERSEER, { v: 1 }), "b");
    assert.deepEqual(wrote, ["a", "b"]);
  });

  test("toolStateWriter is one pi.appendEntry with the caller's object, and returns no id", () => {
    const calls: unknown[][] = [];
    const data = { v: 1 as const, n: 2, from: "p1", to: "p2", question: "q", briefing: "" };
    assert.equal(toolStateWriter({ appendEntry: (...a: unknown[]) => void calls.push(a) } as any).append(BATON_HANDOFF, data), "");
    assert.deepEqual(calls, [["sova-baton-handoff", data]]);
    assert.equal(calls[0]![1], data);
  });
});

describe("createSessionFile", () => {
  test("is today's hand-written file: header, then each seed record, written now", () => {
    const rule = { v: 1 as const, card: "c_1", option: "a", label: "L", createdAt: "2026-01-01T00:00:00.000Z", message: "m", id: "r_1", text: "t", acts: ["sova_send" as const], sessions: "any" as const };
    const made = createSessionFile({ cwd: dir, sessionsDir: join(dir, "a"), id: "0198a000-0000-7000-8000-000000000003", seed: [[OVERSEER, { v: 1 }], [RULE, rule]] });
    assert.equal(made.id, "0198a000-0000-7000-8000-000000000003");
    // today's steps (server/overseer.ts createOverseerFile), into another directory
    const sm = SessionManager.create(dir, join(dir, "b"), { id: "0198a000-0000-7000-8000-000000000003" });
    sm.appendCustomEntry("sova-overseer", { v: 1 });
    sm.appendCustomEntry("overseer-rule", rule);
    const want = `${[JSON.stringify(sm.getHeader()), ...sm.getEntries().map((e) => JSON.stringify(e))].join("\n")}\n`;
    assert.equal(canonical(readFileSync(made.path, "utf8")), canonical(want));
  });

  test("never overwrites: a second file at the same path throws", () => {
    // pi names the file `<time>_<id>.jsonl`, so both calls run at one pinned instant to resolve one path.
    const RealDate = globalThis.Date;
    const at = RealDate.parse("2026-01-02T03:04:05.006Z");
    globalThis.Date = class extends RealDate {
      constructor(...a: any[]) {
        if (a.length) super(...(a as [any]));
        else super(at);
      }
      static now = () => at;
    } as DateConstructor;
    try {
      const opts = { cwd: dir, sessionsDir: join(dir, "d"), id: "0198a000-0000-7000-8000-000000000004" };
      const made = createSessionFile(opts);
      assert.match(made.path, /2026-01-02T03-04-05-006Z_0198a000-0000-7000-8000-000000000004\.jsonl$/, "the pinned instant names the file");
      const before = readFileSync(made.path, "utf8");
      assert.throws(() => createSessionFile({ ...opts, seed: [[OVERSEER, { v: 1 }]] }), /EEXIST/);
      assert.equal(readFileSync(made.path, "utf8"), before);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("with no seed, the header alone", () => {
    const made = createSessionFile({ cwd: dir, sessionsDir: join(dir, "c") });
    const lines = readFileSync(made.path, "utf8").split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], "");
    assert.equal(JSON.parse(lines[0]!).id, made.id);
    assert.equal(JSON.parse(lines[0]!).type, "session");
  });
});

describe("stateViewOf", () => {
  test("reads raw entries and HEntries alike, in one list", () => {
    const view = stateViewOf([
      { type: "custom", id: "a1", parentId: null, timestamp: "t1", customType: "sova-loadout", data: LOADOUT_DATA },
      { type: "custom_message", id: "a2", parentId: "a1", customType: "sova-loadout", content: "", display: false },
      { id: "a3", parentId: "a2", kind: "state", key: "sova-loadout", data: { v: 1, offContext: [], offSkills: [] } },
      { id: "a4", parentId: "a3", kind: "note", noteType: "sova-loadout", content: "", display: false, inMessage: false },
    ]);
    assert.deepEqual(view.list(LOADOUT).map((r) => r.id), ["a1", "a3"]);
    assert.equal(view.latest(LOADOUT)?.id, "a3");
  });
});

describe("SOVA_STATE_ASSERT", () => {
  const rogue: StateKind<{ v: 1 }> = { type: "sova-rogue", owner: "sova", fold: "presence", parse: () => ({ v: 1 }) };
  const sm = () => ({ appendCustomEntry: () => "id", getBranch: () => [], getEntries: () => [] }) as any;

  test("off by default: nothing is checked", () => {
    const was = process.env.SOVA_STATE_ASSERT;
    delete process.env.SOVA_STATE_ASSERT;
    try {
      assert.equal(piSessionState(sm()).append(rogue, { v: 1 }), "id");
      assert.equal(piSessionState(sm()).append(LOADOUT, { v: 2 } as any), "id");
    } finally {
      if (was !== undefined) process.env.SOVA_STATE_ASSERT = was;
    }
  });

  test("on: an unregistered kind or a malformed record throws before the write", () => {
    const was = process.env.SOVA_STATE_ASSERT;
    process.env.SOVA_STATE_ASSERT = "1";
    try {
      assert.throws(() => piSessionState(sm()).append(rogue, { v: 1 }), /not a registered state kind/);
      assert.throws(() => toolStateWriter({ appendEntry: () => {} } as any).append(LOADOUT, { v: 2 } as any), /doesn't parse/);
      assert.equal(piSessionState(sm()).append(LOADOUT, LOADOUT_DATA), "id");
    } finally {
      if (was === undefined) delete process.env.SOVA_STATE_ASSERT;
      else process.env.SOVA_STATE_ASSERT = was;
    }
  });
});
