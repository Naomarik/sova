// The batch runner over the real worker registry and a stand-in for the chat processes: no process, no socket.
// What each discriminating case rules out is named where it matters.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "design-batch-"));
const { DESIGN_CONCURRENT } = await import("../../shared/design");
const { assertLaunchAllowed, deleteDesign, deliverDesign, DesignLimitError, installDesignHost, launchDesigns, pageProblem, retryDesign, onDesignHandIn, onLiveFrame } = await import("./batch");
const store = await import("./store");
const { sessionDesignTools } = await import("./tools");
const { WorkerRegistry } = await import("../chat-workers");
const { livePage } = await import("./live");

const PAGE = "<!doctype html><html><body>hi</body></html>";
const NOTE = { layout: "l", sections: "s", type: "t", color: "c" };

type Rec = { chatId: string; spec: { kind: string; extensions: string[]; builtins: unknown; appendSystemPrompt: string | null } };
interface Fake {
  rec: Rec;
  mirror: { sessionId: string; running: boolean; starting: boolean; compacting: boolean; model: null; thinking: string; worker: { proc: string; seq: number; lastSettled: unknown } };
  at: { pid: number; unit: string };
  closed: boolean;
  sends: { text: string; key: string; delivery?: string; report?: boolean }[];
  queued: boolean;
  call(m: string, a: unknown): Promise<unknown>;
}

let n = 0;
let parentOpens = 0;
let fakes: Fake[];
let registry: InstanceType<typeof WorkerRegistry>;
let parent: { sessionId: string; path: string };
let dir: string;

function makeRegistry(): void {
  registry = new WorkerRegistry(
    {
      start: async (rec) => {
        const f: Fake = {
          rec: rec as unknown as Rec,
          mirror: { sessionId: rec.chatId, running: false, starting: false, compacting: false, model: null, thinking: "low", worker: { proc: `p${++n}`, seq: 0, lastSettled: null } },
          at: { pid: n, unit: "u" },
          closed: false,
          sends: [],
          queued: false,
          call: async (m, a) => {
            if (m === "send") {
              f.sends.push(a as Fake["sends"][number]);
              return { queued: f.queued, turnId: null };
            }
            return null;
          },
        };
        fakes.push(f);
        return f as never;
      },
      stop: async () => {},
    },
    { dir: () => dir, openParent: async () => void parentOpens++, archived: () => false },
  );
  installDesignHost({
    workers: (p) => registry.bind(p),
    owner: (chatId) => {
      const r = registry.record(chatId);
      return r ? { parent: { sessionId: r.parent.sessionId, path: r.parent.path }, workerId: r.parent.workerId } : undefined;
    },
  });
}

const settleKeyed = new Map<Fake, number>();
function settle(f: Fake, outcome: "success" | "error" = "success", error?: string): void {
  const k = (settleKeyed.get(f) ?? 0) + 1;
  settleKeyed.set(f, k);
  f.mirror.worker.lastSettled = { key: `k${f.rec.chatId}#${k}`, outcome, ...(error ? { error } : {}) };
  registry.onState(f as never);
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function ticks(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick();
}

function newRun(models: string[], directions: string[]): string {
  const id = `r${++n}`;
  const now = new Date().toISOString();
  store.changeDesigns(parent.sessionId, (s) => {
    s.runs.push({
      id,
      phase: "setup",
      labels: [],
      createdAt: now,
      updatedAt: now,
      setup: { brief: "a page", models: models.map((ref) => ({ ref, name: ref, design: true, coordinator: false, vision: true, route: "tool" as const })), directions: directions.map((name) => ({ name, on: true })) },
    });
    s.cwd = dir;
    s.parentPath = parent.path;
  });
  return id;
}

const stat = (label: string) => store.designOf(parent.sessionId, label)!;
const finish = async (f: Fake, label: string): Promise<void> => {
  const tools = sessionDesignTools(parent, label);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  await tool("design_stream").execute("t", { label, html: PAGE }, undefined, undefined, undefined);
  await tool("design_hand_in").execute("t", { label, note: NOTE }, undefined, undefined, undefined);
  settle(f);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "design-batch-w-"));
  fakes = [];
  parentOpens = 0;
  settleKeyed.clear();
  parent = { sessionId: `s${++n}`, path: join(dir, "parent.jsonl") };
  makeRegistry();
});
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

test("a launch gives each model and direction its own label and session, and only the cap writes at once", async () => {
  const run = newRun(["zai/a", "zai/b"], ["Minimalist", "Heritage", "Immersive", "Playful"]);
  const labels = launchDesigns(parent, run, { brief: "the brief" });
  assert.deepEqual(labels, ["A", "B", "C", "D", "E", "F", "G", "H"]);
  await ticks();
  assert.equal(fakes.length, DESIGN_CONCURRENT);
  assert.equal(store.viewOf(parent.sessionId).designs.filter((d) => !d.sessionId).length, 2);
  // A design session has no shell or file tools, and runs as its own kind.
  assert.deepEqual(fakes[0]!.rec.spec.builtins, []);
  assert.equal(fakes[0]!.rec.spec.kind, "design");
  assert.ok(fakes[0]!.sends[0]!.text.includes("the brief"));
  await finish(fakes[0]!, "A");
  await ticks();
  assert.equal(fakes.length, DESIGN_CONCURRENT + 1, "one done lets one more start");
});

test("labels never repeat in a chat, even after one is deleted", async () => {
  const a = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, a, {});
  await ticks();
  deleteDesign(parent, "A");
  const b = newRun(["zai/a"], ["Heritage"]);
  assert.deepEqual(launchDesigns(parent, b, {}), ["B"]);
});

test("q2: ask above 12, stop at 24, whatever the caller checked", () => {
  for (const [count, confirmed, ok] of [[12, false, true], [13, false, false], [13, true, true], [24, true, true], [25, true, false]] as const) {
    if (ok) assertLaunchAllowed(count, confirmed);
    else assert.throws(() => assertLaunchAllowed(count, confirmed), DesignLimitError);
  }
  const big = newRun(Array.from({ length: 13 }, (_, i) => `zai/m${i}`), ["Minimalist"]);
  assert.throws(() => launchDesigns(parent, big, {}), DesignLimitError, "the runner is the wall");
  assert.equal(store.viewOf(parent.sessionId).designs.length, 0, "a refused launch starts nothing");
});

test("nothing reaches the main chat when designs finish or a user refines one (q6)", async () => {
  const run = newRun(["zai/a", "zai/b", "zai/c"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  for (const [i, f] of fakes.entries()) await finish(f, String.fromCharCode(65 + i));
  await deliverDesign(parent, "A", { text: "darker", key: "k1", by: "user", version: "refine" });
  settle(fakes[0]!);
  await ticks();
  for (const f of fakes) for (const s of f.sends) assert.equal(s.report, false, "no delivery reports back");
  // The rule itself: a settle nobody watches opens the parent to take a report, for an ordinary worker only.
  const noWatcher = async (kind: "worker" | "design"): Promise<boolean> => {
    const before = fakes.length;
    const ref = await registry.start({ key: `plain:${kind}`, session: { new: { dir } }, task: "x", spec: { kind, parent: { ...parent, workerId: `ag_${kind}` }, cwd: dir, model: null, thinking: null, builtins: [], extensions: [], flags: {}, appendSystemPrompt: null, env: {}, agentDir: null, lowered: true } });
    const f = fakes[before]!;
    settle(f);
    const live = (registry as unknown as { live: Map<string, { settleTimer: NodeJS.Timeout | null }> }).live.get(ref.chatId)!;
    const armed = live.settleTimer !== null;
    if (live.settleTimer) clearTimeout(live.settleTimer);
    return armed;
  };
  assert.equal(await noWatcher("worker"), true, "an ordinary worker is the case this can tell apart");
  assert.equal(await noWatcher("design"), false);
  assert.equal(parentOpens, 0);
});

test("an idle-stopped session takes a message by coming back on its own, with no resume command (t18)", async () => {
  const run = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  await finish(fakes[0]!, "A");
  // Its process stops as idle; the record waits.
  registry.onExit(fakes[0]!.rec.chatId, "idle");
  assert.equal(registry.record(fakes[0]!.rec.chatId)?.state, "idle");
  await deliverDesign(parent, "A", { text: "go on", key: "k2", by: "user" });
  assert.equal(fakes.length, 2, "the same session was started again");
  assert.equal(fakes[1]!.rec.chatId, fakes[0]!.rec.chatId);
  assert.equal(fakes[1]!.sends[0]!.text, "go on");
});

test("a message and a parent's message sent at once to a busy session both arrive, in order, and read Queued (t20)", async () => {
  const run = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  fakes[0]!.queued = true;
  const [a, b] = await Promise.all([deliverDesign(parent, "A", { text: "first", key: "k1", by: "user" }), deliverDesign(parent, "A", { text: "second", key: "k2", by: "main" })]);
  assert.deepEqual([a.queued, b.queued], [true, true]);
  // Sends go only through the session's own queue: the first message, then these two, in this order.
  assert.deepEqual(fakes[0]!.sends.slice(1).map((s) => [s.text, s.delivery]), [["first", "followUp"], ["second", "followUp"]]);
  assert.equal(stat("A").delivery?.state, "queued");
  assert.equal(stat("A").delivery?.key, "design-send:k2");
  // Its message entering the context clears the card's Queued.
  (registry as unknown as { onFeed(h: unknown, f: unknown): void }).onFeed(fakes[0], { t: "feed", cursor: { proc: fakes[0]!.mirror.worker.proc, seq: 1 }, event: { type: "message_start", message: { role: "user" }, sendKey: "design-send:k2" } });
  assert.equal(stat("A").delivery, undefined);
});

test("a message a session can't take stays visibly undelivered and throws, so the box keeps its text", async () => {
  const run = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  fakes[0]!.call = async () => {
    throw new Error("no such thing");
  };
  await assert.rejects(deliverDesign(parent, "A", { text: "x", key: "k", by: "user" }), /no such thing/);
  assert.equal(stat("A").delivery?.state, "undelivered");
});

test("a session stopped for good is replaced by a fresh one seeded from its stored page", async () => {
  const run = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  await finish(fakes[0]!, "A");
  await registry.stop(fakes[0]!.rec.chatId, "test");
  await deliverDesign(parent, "A", { text: "keep going", key: "k", by: "user" });
  await ticks();
  assert.equal(fakes.length, 2);
  assert.notEqual(fakes[1]!.rec.chatId, fakes[0]!.rec.chatId);
  assert.ok(fakes[1]!.sends[0]!.text.includes(PAGE));
  assert.ok(fakes[1]!.sends[0]!.text.includes("keep going"));
});

test("a turn that ends with no page fails with its reason, and Retry starts a fresh session", async () => {
  const run = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  settle(fakes[0]!, "error", "rate limited");
  await ticks();
  assert.equal(stat("A").status, "failed");
  assert.equal(stat("A").error, "rate limited");
  retryDesign(parent, "A");
  await ticks();
  assert.equal(fakes.length, 2);
  assert.notEqual(fakes[1]!.rec.chatId, fakes[0]!.rec.chatId);
  assert.notEqual(stat("A").status, "failed");
});

test("the hand-in makes a version, and the page written so far is told in order", async () => {
  const run = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  const heard: unknown[] = [];
  const off = onDesignHandIn((e) => heard.push(e));
  const chat = fakes[0]!.rec.chatId;
  onLiveFrame(chat, { gen: 1, at: 0, text: "<!doc" });
  onLiveFrame(chat, { gen: 1, at: 5, text: "type" });
  // A slice this server can't place is dropped until the resync says the page again.
  onLiveFrame(chat, { gen: 1, at: 99, text: "lost" });
  assert.equal(livePage(parent.sessionId, "A")?.text, "<!doctype");
  assert.equal(stat("A").status, "writing");
  await finish(fakes[0]!, "A");
  off();
  assert.equal(stat("A").status, "ready");
  assert.equal(stat("A").versions.length, 1);
  assert.deepEqual(heard, [{ sessionId: parent.sessionId, label: "A", version: 1, note: NOTE }]);
  assert.equal(livePage(parent.sessionId, "A"), null);
  assert.equal(store.readPage(parent.sessionId, "A"), PAGE);
});

test("a chat's designs are what they were after a restart, an archive leaves them, a deletion removes them", async () => {
  const run = newRun(["zai/a"], ["Minimalist"]);
  launchDesigns(parent, run, {});
  await ticks();
  await finish(fakes[0]!, "A");
  store.forgetDesignCache();
  assert.equal(store.viewOf(parent.sessionId).designs[0]?.status, "ready");
  assert.equal(store.readPage(parent.sessionId, "A"), PAGE);
  assert.equal(store.designFolderExists(parent.sessionId), true);
  store.removeDesignFiles(parent.sessionId);
  assert.equal(store.designFolderExists(parent.sessionId), false);
  store.setCoordinator(parent.sessionId, null);
  assert.equal(store.designFolderExists(parent.sessionId), false, "a late write doesn't bring it back");
});

test("a page that is empty or cut off is no page", () => {
  assert.equal(pageProblem(PAGE), null);
  for (const bad of ["", "   ", "<div>half", "<!doctype html><html><body>cut"]) assert.ok(pageProblem(bad), bad);
});

test("five six-design batches leave no session running once each has gone idle (t22)", async () => {
  for (let i = 0; i < 5; i++) {
    const run = newRun(["zai/a", "zai/b"], ["Minimalist", "Heritage", "Immersive"]);
    launchDesigns(parent, run, {});
    await ticks();
      for (const f of [...fakes]) {
      const label = store.viewOf(parent.sessionId).designs.find((d) => d.sessionId === f.rec.chatId)!.label;
      if (store.designOf(parent.sessionId, label)!.versions.length) continue;
      await finish(f, label);
      registry.onExit(f.rec.chatId, "idle");
    }
    await ticks();
  }
  // Idle stop lets each process go: none of the 30 sessions is left running once idle.
  const running = fakes.filter((f) => registry.wakeOwner(f.rec.chatId)?.running);
  assert.equal(running.length, 0);
  assert.equal(store.viewOf(parent.sessionId).designs.length, 30);
});
