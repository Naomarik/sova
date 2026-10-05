// Run: pnpm test -- server/harness/pi/wire-compat.test.ts. Uses a throwaway PI_CODING_AGENT_DIR in the OS
// temp dir; ~/.pi is never read or written, and with no credentials there no model is ever called.
//
// The wire per consumer (shared/protocol.ts WireVersion), through the server's real paths: a ChatSession's
// clients (events, hello, append, history), the watch tail (snapshot, append, history) and GET
// /api/transcript (whole branch, tail, light). A consumer that doesn't ask gets today's frames byte for byte
// (the W3.0 control frames, golden/wire/expected/faux/*/frames.json) and today's rows; one that asks for
// wire 2 gets every v1 event through fromV1 (pinned in golden/wire/v2/) and every row with `facts` in place
// of `meta`, cut at the same rows. Record a missing v2 golden:
// SOVA_GOLDEN_MODE=record pnpm test -- server/harness/pi/wire-compat.test.ts.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage, TranscriptItem, V1EventFrame, WatchServerMessage } from "../../../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-wire-compat-")));
process.env.PI_CODING_AGENT_DIR = agentDir; // before any server module computes its paths
process.env.PORT = "0";
const sessionsDir = join(agentDir, "sessions", "--tmp-wire--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats } = await import("../../chat-manager");
type ChatClient = import("../../chat-manager").ChatClient;
const { canonicalPath } = await import("../../paths");
const { app, server } = await import("../../index");
const { AUTH_COOKIE, sovaToken } = await import("../../auth");
const { SessionTail } = await import("../../watch");
const { rowsOf } = await import("../../transcript");
const { branchOf, parsePi } = await import("./reader");
const { factsFromMeta, fromV1 } = await import("../../../shared/wire-v1");
const { rowsFor, withRows, onWire } = await import("../../wire-rows");
const { v1Frame } = await import("./wire");
const g = await import("./golden/golden");
if (!server.listening) await new Promise((r) => server.once("listening", r));

after(async () => {
  await disposeAllChats();
  server.close();
  server.closeAllConnections?.();
  rmSync(agentDir, { recursive: true, force: true });
});

const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
const WIRE = join(g.GOLDEN_DIR, "wire");
const V2 = join(WIRE, "v2");
const FAUX = join(g.GOLDEN_DIR, "fixtures/faux");
const mode: import("./golden/golden").Mode = process.env.SOVA_GOLDEN_MODE === "record" ? "record" : "compare";
const accept = new Set((process.env.SOVA_GOLDEN_ACCEPT ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const produced = new Set<string>();

function check(fixture: string, probe: string, output: unknown) {
  const set: import("./golden/golden").FixtureSet = { name: "faux", private: false, expected: join(V2, "faux"), fixtures: [] };
  const r = g.settle(set, fixture, probe, g.compact(g.encode(output)), mode, accept);
  produced.add(r.path);
  const where = relative(g.REPO, r.path);
  if (r.status === "missing") assert.fail(`no expected file ${where}. Record it: SOVA_GOLDEN_MODE=record pnpm test -- server/harness/pi/wire-compat.test.ts`);
  if (r.status === "differs") assert.fail(`${where}: differs at ${r.where}${r.detail ? ` (${r.detail})` : ""}. An intended change needs a CHANGES.md line and SOVA_GOLDEN_ACCEPT=${probe}.`);
}

/** A client as server/ws.ts makes one: every message as the JSON string the socket would carry. */
function client(opts: { wire?: 2; tail?: boolean; pull?: boolean } = {}): { c: ChatClient; got: string[] } {
  const got: string[] = [];
  const c: ChatClient = {
    send: (m) => void got.push(JSON.stringify(m)),
    sendRaw: (json) => void got.push(json),
    ...(opts.wire ? { wire: 2 as const } : {}),
    ...(opts.tail ? { tail: true } : {}),
    ...(opts.tail && opts.pull ? { pull: { prefetch: false } } : {}),
  };
  return { c, got };
}

const parsed = (got: readonly string[]) => got.map((s) => JSON.parse(s) as { type: string; v?: number; items?: TranscriptItem[] } & Record<string, unknown>);
/** JSON of a value, as a socket would carry and a browser parse it. */
const viaJson = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** No v2 row carries `meta` and no v1 row `facts`; every v2 row with facts has them as its v1 row's meta mapped. */
function assertRows(v1: readonly TranscriptItem[], v2: readonly TranscriptItem[], where: string) {
  assert.equal(v2.length, v1.length, `${where}: the same rows`);
  v1.forEach((r1, i) => {
    const r2 = v2[i]!;
    assert.equal("facts" in r1, false, `${where}: a wire-1 row carries no facts`);
    assert.equal("meta" in r2, false, `${where}: a wire-2 row carries no meta`);
    assert.deepEqual(r2.facts, viaJson(factsFromMeta(r1.meta)), `${where}: row ${i}'s facts are its meta's`);
    const { meta: _m, ...rest1 } = r1;
    const { facts: _f, ...rest2 } = r2;
    assert.deepEqual(rest2, rest1, `${where}: row ${i} is otherwise the same`);
  });
}

let n = 0;
/** A session file in the sessions dir with these lines, the header's cwd and id made this run's. */
function sessionFile(lines: Record<string, unknown>[]): string {
  n++;
  const id = `0000000${n}-wire-compat`;
  const out = lines.map((l) => (l.type === "session" ? { ...l, id, cwd } : l));
  const path = join(sessionsDir, `2026-10-05T00-00-0${n % 10}-000Z_${id}.jsonl`);
  writeFileSync(path, `${out.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}
const jsonl = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

type Sdk = {
  _emit(e: unknown): void;
  sessionManager: { getLeafId(): string | null; getEntry(id: string): unknown };
};

const faux = readdirSync(FAUX).filter((d) => existsSync(join(FAUX, d, "events.json"))).sort();

describe("a chat's clients, per wire, on every faux stream", () => {
  test("every faux scenario has an event stream and control frames", () => {
    assert.ok(faux.length > 0);
    for (const name of faux) assert.ok(existsSync(join(WIRE, "expected/faux", name, "frames.json")), name);
  });
  for (const name of faux) {
    test(`faux/${name}`, async () => {
      const events = JSON.parse(readFileSync(join(FAUX, name, "events.json"), "utf8")) as { type: string; message?: unknown }[];
      const control = JSON.parse(readFileSync(join(WIRE, "expected/faux", name, "frames.json"), "utf8")) as string[];
      assert.equal(control.length, events.length, "one control frame per event");
      const text = readFileSync(join(FAUX, name, "session.jsonl"), "utf8");
      const path = sessionFile(jsonl(text));
      const chat = await acquireChat(path, true);
      const one = client();
      const two = client({ wire: 2 });
      chat.attach(one.c);
      chat.attach(two.c);

      // The hello: wire 1 is the file's rows (the M2 rows golden's builder), wire 2 those rows mapped.
      const hello1 = parsed(one.got).find((m) => m.type === "hello")!;
      const hello2 = parsed(two.got).find((m) => m.type === "hello")!;
      assert.equal(JSON.stringify(hello1.items), JSON.stringify(rowsOf(branchOf(parsePi(text).entries))), "wire 1: the hello's rows are today's");
      assertRows(hello1.items!, hello2.items!, "hello");
      assert.deepEqual({ ...hello2, items: null }, { ...hello1, items: null }, "the hello is otherwise the same");
      check(name, "rows", hello2.items);
      one.got.length = 0;
      two.got.length = 0;

      // The stream, through the session's own listeners. The entry pi writes a message as stands where
      // the control frames found it (the leaf, read once the event has waited for the write).
      const sdk = (chat as unknown as { session: Sdk }).session;
      const sm = sdk.sessionManager;
      const leafId = sm.getLeafId.bind(sm);
      const entryOf = sm.getEntry.bind(sm);
      let leaf: { type: "message"; id: string; message: unknown } | null = null;
      sm.getLeafId = () => (leaf ? leaf.id : leafId());
      sm.getEntry = (id: string) => (leaf && id === leaf.id ? leaf : entryOf(id));
      try {
        for (const [i, ev] of events.entries()) {
          const entryId = (JSON.parse(control[i]!) as { entryId?: string }).entryId;
          leaf = ev.type === "message_end" && entryId ? { type: "message", id: entryId, message: ev.message } : null;
          sdk._emit(ev);
          await new Promise((r) => setImmediate(r));
          leaf = null;
        }
      } finally {
        sm.getLeafId = leafId;
        sm.getEntry = entryOf;
      }

      const isEvent = (s: string) => (JSON.parse(s) as { type: string }).type === "event";
      // Wire 1: today's frames, byte for byte.
      assert.deepEqual(one.got.filter(isEvent), control, "wire 1: the control frames, byte for byte");
      // Wire 2: each control frame through fromV1, one frame per event, in order.
      const frames2 = two.got.filter(isEvent);
      const want2 = control.flatMap((f) => fromV1(JSON.parse(f) as V1EventFrame).map((event) => ({ type: "event", v: 2, event })));
      assert.deepEqual(parsed(frames2), viaJson(want2), "wire 2: fromV1 of every control frame");
      check(name, "frames", frames2);
      // Everything else each client got is the same message, its rows mapped.
      const rest1 = parsed(one.got.filter((s) => !isEvent(s)));
      const rest2 = parsed(two.got.filter((s) => !isEvent(s)));
      assert.equal(rest2.length, rest1.length, "the same other messages");
      rest1.forEach((m1, i) => {
        const m2 = rest2[i]!;
        if (Array.isArray(m1.items) && m1.type !== "queue") assertRows(m1.items, m2.items!, `${m1.type} ${i}`);
        else assert.deepEqual(m2, m1, `${m1.type} ${i}`);
      });

      // An entry appended outside a turn: its rows go out as an append, on each wire.
      one.got.length = 0;
      two.got.length = 0;
      sdk._emit({ type: "entry_appended", entry: { type: "model_change", id: "zz-model", parentId: null, timestamp: "2026-10-05T00:00:00.000Z", provider: "anthropic", modelId: "claude-opus-5" } });
      const append1 = parsed(one.got).find((m) => m.type === "append")!;
      const append2 = parsed(two.got).find((m) => m.type === "append")!;
      assert.equal(append1.items![0]!.meta?.type, "model_change", "wire 1: the row's meta");
      assertRows(append1.items!, append2.items!, "append");
      assert.deepEqual(append2.items![0]!.facts, { setting: "model" }, "wire 2: the change in the contract's words");
      await chat.dispose();
    });
  }
});

describe("v2 frames are fromV1 of v1 frames, on every recorded input", () => {
  for (const file of ["live-test.json", "effects.json"]) {
    test(file, () => {
      const seqs = JSON.parse(readFileSync(join(WIRE, "inputs", file), "utf8")) as { calls: { fn: string; args: unknown[] }[] }[];
      let count = 0;
      for (const seq of seqs)
        for (const call of seq.calls) {
          if (call.fn !== "applyEvent") continue;
          const frame = v1Frame(call.args[0]) as ChatServerMessage;
          assert.deepEqual(onWire(frame, 2), fromV1(frame as V1EventFrame).map((event) => ({ type: "event", v: 2, event })));
          assert.deepEqual(onWire(frame, 1), [frame], "wire 1: the frame itself");
          count++;
        }
      assert.ok(count > 0);
    });
  }
});

// ---- A long session: every cut (tail, history chunks, older rows) is the same on both wires.

const at = (i: number) => new Date(Date.UTC(2026, 9, 5, 0, 0, i)).toISOString();
/** A session past the tail's size: replies with usage, tool calls and results, a model change, a compaction. */
function longSession(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id: "long", timestamp: at(0), cwd }];
  let parent: string | null = null;
  let k = 0;
  const add = (e: Record<string, unknown>) => {
    const id = `e${++k}`;
    lines.push({ ...e, id, parentId: parent, timestamp: at(k) });
    parent = id;
    return id;
  };
  const big = (i: number) => `${"lorem ipsum dolor sit amet ".repeat(400)} ${i}`;
  add({ type: "model_change", provider: "anthropic", modelId: "claude-opus-5" });
  for (let i = 0; i < 90; i++) {
    add({ type: "message", message: { role: "user", content: [{ type: "text", text: `ask ${i}` }], timestamp: 1 } });
    add({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: big(i) }, { type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}` } }], provider: "anthropic", model: "claude-opus-5", usage: { input: 10 + i, output: 5, cacheRead: 100, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 1 },
    });
    add({ type: "message", message: { role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: big(i) }], isError: i % 7 === 0, timestamp: 1 } });
    if (i === 40) add({ type: "compaction", summary: "x".repeat(900), firstKeptEntryId: "e2", tokensBefore: 12345, details: { readFiles: ["a"] } });
  }
  return lines;
}

describe("a long session's cuts, per wire", () => {
  const lines = longSession();
  const path = sessionFile(lines);
  const text = readFileSync(path, "utf8");

  test("a chat's tail hellos and history, at attach and after a branch move", async () => {
    const chat = await acquireChat(path, true);
    const push1 = client({ tail: true });
    const push2 = client({ wire: 2, tail: true });
    const pull1 = client({ tail: true, pull: true });
    const pull2 = client({ wire: 2, tail: true, pull: true });
    const whole1 = client();
    const whole2 = client({ wire: 2 });
    const all = [push1, push2, pull1, pull2, whole1, whole2];
    const compare = (when: string) => {
      const [p1, p2, q1, q2, w1, w2] = all.map((x) => parsed(x.got));
      const hello = (ms: ReturnType<typeof parsed>) => ms.find((m) => m.type === "hello")!;
      const history = (ms: ReturnType<typeof parsed>) => ms.filter((m) => m.type === "history");
      assert.ok((hello(p1!).older as number) > 0, `${when}: the hello is cut`);
      assert.ok(history(p1!).length > 1, `${when}: more than one history chunk`);
      for (const [a, b, what] of [[p1!, p2!, "push"], [q1!, q2!, "pull"], [w1!, w2!, "whole"]] as const) {
        const h1 = hello(a);
        const h2 = hello(b);
        assert.equal(h2.older, h1.older, `${when} ${what}: cut at the same row`);
        assert.deepEqual(h2.olderSummary, h1.olderSummary, `${when} ${what}: the same summary`);
        assertRows(h1.items!, h2.items!, `${when} ${what} hello`);
        const c1 = history(a);
        const c2 = history(b);
        assert.deepEqual(c2.map((m) => m.left), c1.map((m) => m.left), `${when} ${what}: the same chunks`);
        c1.forEach((m, i) => assertRows(m.items!, c2[i]!.items!, `${when} ${what} history ${i}`));
      }
      // Wire 1 is today's: the hello's rows, put back together, are the whole branch's.
      const whole = JSON.stringify(rowsOf(branchOf(parsePi(text).entries)));
      assert.equal(JSON.stringify(hello(w1!).items), whole, `${when}: a whole wire-1 hello is today's rows`);
      const rebuilt = [...history(p1!)].reverse().flatMap((m) => m.items!).concat(hello(p1!).items!);
      assert.equal(JSON.stringify(rebuilt), whole, `${when}: a tail wire-1 hello and its history are today's rows`);
      for (const x of all) x.got.length = 0;
    };
    for (const x of all) chat.attach(x.c);
    compare("attach");
    const afterMove = (chat as unknown as { afterBranchMove(): () => void }).afterBranchMove();
    afterMove();
    compare("after a branch move");
    await chat.dispose();
  });

  test("the watch tail's snapshot, history and append", async () => {
    const run = async (wire: 1 | 2, pull: boolean) => {
      const got: WatchServerMessage[] = [];
      const raw: string[] = [];
      const tail = new SessionTail(path, (m) => void got.push(viaJson(m)), undefined, undefined, pull ? undefined : (json) => void raw.push(json), pull ? { prefetch: false } : undefined, wire);
      await (tail as unknown as { snapshot(): Promise<void> }).snapshot();
      return { tail, got, raw: raw.map((s) => JSON.parse(s) as { left: number; items: TranscriptItem[] }) };
    };
    for (const pull of [false, true]) {
      const a = await run(1, pull);
      const b = await run(2, pull);
      const s1 = a.got[0] as Extract<WatchServerMessage, { type: "snapshot" }>;
      const s2 = b.got[0] as Extract<WatchServerMessage, { type: "snapshot" }>;
      assert.ok((s1.older ?? 0) > 0);
      assert.equal(s2.older, s1.older, "cut at the same row");
      assert.deepEqual(s2.olderSummary, s1.olderSummary);
      assertRows(s1.items, s2.items, "snapshot");
      assert.deepEqual(b.raw.map((m) => m.left), a.raw.map((m) => m.left), "the same history chunks");
      a.raw.forEach((m, i) => assertRows(m.items, b.raw[i]!.items, `history ${i}`));
      a.tail.close();
      b.tail.close();
    }
    // An append: the next lines' rows, on each wire.
    const a = await run(1, false);
    const b = await run(2, false);
    appendFileSync(path, `${JSON.stringify({ type: "message", id: "z1", parentId: lines.at(-1)!.id, timestamp: at(999), message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "anthropic", model: "claude-opus-5", usage: { input: 1, output: 1, cacheRead: 7, cacheWrite: 0 }, stopReason: "stop", timestamp: 1 } })}\n`);
    for (const t of [a, b]) await (t.tail as unknown as { readNew(): Promise<void> }).readNew();
    const ap1 = a.got.at(-1) as Extract<WatchServerMessage, { type: "append" }>;
    const ap2 = b.got.at(-1) as Extract<WatchServerMessage, { type: "append" }>;
    assert.equal(ap1.type, "append");
    assertRows(ap1.items, ap2.items, "append");
    assert.deepEqual(ap2.items[0]!.facts, { contextTokens: 8 }, "the reply's fill, in the contract's words");
    a.tail.close();
    b.tail.close();
  });

  test("GET /api/transcript: whole branch, tail, older rows and light, per wire", async () => {
    const get = async (q: string) => {
      const r = await app.request(`/api/transcript?path=${encodeURIComponent(path)}${q}`, { headers: AUTH });
      assert.equal(r.status, 200, q);
      return { text: await r.text() };
    };
    for (const q of ["", "&tail=1", "&view=light"]) {
      const one = await get(q);
      const two = await get(`${q}&wire=2`);
      const b1 = JSON.parse(one.text) as { items: TranscriptItem[]; older?: number; olderSummary?: unknown; context?: unknown };
      const b2 = JSON.parse(two.text) as typeof b1;
      assertRows(b1.items, b2.items, `GET${q}`);
      assert.deepEqual({ ...b2, items: null }, { ...b1, items: null }, `GET${q}: otherwise the same`);
      if (q === "") assert.equal(JSON.stringify(b1.items), JSON.stringify(rowsOf(branchOf(parsePi(readFileSync(path, "utf8")).entries))), "wire 1: today's rows");
      if (q === "&tail=1") {
        assert.ok((b1.older ?? 0) > 0);
        const first = b1.items[0]!.id;
        const older1 = JSON.parse((await get(`&before=${encodeURIComponent(first)}`)).text) as typeof b1;
        const older2 = JSON.parse((await get(`&before=${encodeURIComponent(first)}&wire=2`)).text) as typeof b1;
        assertRows(older1.items, older2.items, "GET before");
        assert.equal(older2.older, older1.older);
      }
      if (q === "&view=light") {
        const c = b2.items.find((it) => it.facts?.compaction)!.facts!.compaction!;
        assert.equal(c.details, undefined, "light: no compaction details");
        assert.equal(c.summary?.length, 400, "light: the summary cut");
        assert.equal(c.tokensBefore, 12345);
      }
    }
    // The light view's rows are the light wire-1 rows mapped (rowsFor), as every other route's.
    const light1 = JSON.parse((await get("&view=light")).text) as { items: TranscriptItem[] };
    assert.deepEqual(viaJson(rowsFor(light1.items, 2)), (JSON.parse((await get("&view=light&wire=2")).text) as { items: TranscriptItem[] }).items);
    assert.deepEqual(withRows({ type: "queue", items: [] } as unknown as ChatServerMessage, 2), { type: "queue", items: [] }, "a queue's items are not rows");
  });
});

test("no stale v2 expected files", () => {
  const stale: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!produced.has(p)) stale.push(relative(g.REPO, p));
    }
  };
  if (existsSync(V2)) walk(V2);
  assert.deepEqual(stale, [], "expected files no input produces: remove them");
});
