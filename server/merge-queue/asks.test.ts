// Run: pnpm test server/merge-queue/asks.test.ts
// When the merge thread needs the user it never waits in its own chat: merge.ask wakes the chat that owns the
// entry's branch (a worker resolved to the chat that runs it) with exactly one marked merge-queue message naming
// the question's id; that chat relays the user's answer with merge.reply, which reaches the thread as its next
// event. No chat that can take it: the question is held on the tab and one notification opens the tab. Only the
// thread asks, only the chat asked relays, only the operator starts fresh or clears.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { MergeEntry } from "../../shared/merge-queue";
import type { SessionSummary } from "../../shared/protocol";
import type { Caller } from "../project-services/engine";
import { scratchRoot } from "../test-scratch";
import { askTarget, askUser, type AskDeps } from "./asks";
import { merger } from "./routes";
import { makeKit } from "./testing/queue-kit";
import { MergeThread, type ThreadDeps } from "./thread";

const T0 = Date.parse("2026-11-03T10:00:00Z");
const row = (id: string, x: Partial<SessionSummary> = {}) => ({ id, path: `/s/${id}.jsonl`, title: `chat ${id}`, archived: false, live: null, ...x }) as SessionSummary;
const entry = (session?: string) => ({ id: "mq_1", branch: "feat/x", commit: "a".repeat(40), target: "master", ...(session ? { session } : {}) }) as MergeEntry;

function keeper(dir: string) {
  const woken: { path: string; text: string }[] = [];
  const deps: ThreadDeps = {
    now: () => T0,
    file: join(dir, "threads.json"),
    session: async (id) => ({ id, path: `/t/${id}.jsonl`, createdAt: new Date(T0).toISOString() }),
    create: async () => ({ ok: true, id: "t1", path: "/t/t1.jsonl", memory: { type: "uniichat" } }),
    wake: async (path, text) => (woken.push({ path, text }), { ok: true }),
    retryMs: [0, 0],
    log: () => {},
  };
  return { t: new MergeThread(deps), woken };
}

function deps(sessions: SessionSummary[], refuse = false) {
  const sent: { path: string; text: string; ask: string; choices: string[] }[] = [];
  const notified: { title: string; body: string; hash: string; tag: string }[] = [];
  const d: AskDeps = {
    sessions: async () => sessions,
    // The decision on the branch's card (queue.ts askDecision); `refuse`: it couldn't be raised.
    decide: async (a, chat) => {
      if (refuse) throw new Error("no entry to raise it on");
      sent.push({ path: chat.path, text: a.question, ask: a.id, choices: a.choices });
      return true;
    },
    notify: async (n) => void notified.push(n),
    project: () => ({ id: "p1", name: "sova" }),
    log: () => {},
  };
  return { d, sent, notified };
}

describe("asking the user through the branch's chat", () => {
  test("askTarget: the recorded chat; a worker's chat for a worker; none for an archived, terminal-held, queue or unknown chat", () => {
    const list = [row("P"), row("W", { workerSession: true, workerOf: { id: "P", path: "/s/P.jsonl" } }), row("A", { archived: true }), row("L", { live: { pid: 9, status: "idle" } as SessionSummary["live"] }), row("Q", { queueChat: { role: "thread" } })];
    assert.equal(askTarget(entry("P"), list)?.id, "P");
    assert.equal(askTarget(entry("W"), list)?.id, "P");
    for (const id of ["A", "L", "Q", "Z"]) assert.equal(askTarget(entry(id), list), null, id);
    assert.equal(askTarget(entry(), list), null);
    assert.equal(askTarget(undefined, list), null);
  });

  test("the owning chat shows it as one decision on the branch's card (its id, the question, its choices); nothing to relay; no notification", async () => {
    const { t } = keeper(scratchRoot("mq-asks-"));
    const { d, sent, notified } = deps([row("P"), row("W", { workerSession: true, workerOf: { id: "P", path: "/s/P.jsonl" } })]);
    const ask = await askUser(t, "/proj", { question: "Which hostnames must never be public?", entry: entry("W"), choices: ["None", "Some"] }, d);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.path, "/s/P.jsonl", "a worker's: the chat that runs it");
    assert.equal(sent[0]!.text, "Which hostnames must never be public?");
    assert.equal(sent[0]!.ask, ask.id);
    assert.deepEqual(sent[0]!.choices, ["None", "Some"]);
    assert.deepEqual(ask.askedIn, { session: "P", path: "/s/P.jsonl" });
    assert.equal(ask.onTab, undefined);
    assert.equal(ask.branch, "feat/x");
    assert.deepEqual(notified, []);
    assert.equal(t.openAsk("/proj")?.id, ask.id);
  });

  test("the owner archived, refusing, or none: held on the tab, one notification that opens the tab, no message", async () => {
    for (const [name, list, refuse, e] of [
      ["archived", [row("P", { archived: true })], false, entry("P")],
      ["refused", [row("P")], true, entry("P")],
      ["no entry", [row("P")], false, undefined],
    ] as const) {
      const { t } = keeper(scratchRoot("mq-asks-"));
      const { d, sent, notified } = deps([...list], refuse);
      const ask = await askUser(t, "/proj", { question: "What else must never reach the public repo?", ...(e ? { entry: e } : {}) }, d);
      assert.deepEqual(sent, [], name);
      assert.equal(ask.onTab, true, name);
      assert.equal(notified.length, 1, `${name}: exactly one notification`);
      assert.equal(notified[0]!.hash, "#/projects/p1/merge-queue");
      assert.match(notified[0]!.title, /The merge thread needs you · sova/);
    }
  });

  test("the answer closes the question and reaches the thread as its next event, once", async () => {
    const { t, woken } = keeper(scratchRoot("mq-asks-"));
    t.notify("/proj", { kind: "queued", entry: entry() });
    await t.idle("/proj");
    const { d } = deps([row("P")]);
    const ask = await askUser(t, "/proj", { question: "Is example.org public?", entry: entry("P") }, d);
    const r = t.answer("/proj", ask.id, "Yes, it's our public site.", { kind: "chat", session: "P", from: 'the user, relayed by their chat "chat P"' });
    assert.ok(r.ok);
    await t.idle("/proj");
    assert.equal(woken.length, 1);
    assert.match(woken[0]!.text, new RegExp(`^Answer to your question ${ask.id} \\(about feat/x\\), from the user, relayed by their chat "chat P":\\nYes, it's our public site\\.`));
    assert.equal(t.openAsk("/proj"), undefined);
    const again = t.answer("/proj", ask.id, "No", { kind: "operator", from: "the user" });
    assert.equal(again.ok, false);
    assert.equal(t.answer("/proj", "ak_nope", "x", { kind: "operator", from: "u" }).ok, false);
  });
});

describe("who may ask, relay, start fresh and clear", () => {
  test("only the thread asks; no chat relays the answer, the asked one included (the operator's page may); fresh and clear are the operator's", async () => {
    const k = makeKit();
    try {
      const asks = new Map<string, { id: string; question: string; at: string; askedIn: { session: string; path: string } }>();
      const answered: string[] = [];
      const bys: unknown[] = [];
      const call = merger({
        queues: k.queues,
        served: { isListed: () => true, served: async () => true, bareView: async () => ({}) as never },
        rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
        isThreadChat: (_root, sid) => sid === "thread-1",
        threadAsk: async (_root, q) => {
          const a = { id: "ak_1", question: q.question, at: "now", askedIn: { session: "owner-1", path: "/s/owner-1.jsonl" } };
          asks.set(a.id, a);
          return a;
        },
        askOf: (_root, id) => asks.get(id),
        threadAnswer: async (_root, id, text, by) => (answered.push(`${id}:${text}`), bys.push(by), { ...asks.get(id)!, answered: { at: "now", by: "chat" as const } }),
        threadFresh: async () => true,
        clearChats: async () => 2,
      });
      const as = (id: string): Caller => ({ kind: "session", id, root: k.repo.root, own: [] });
      const op: Caller = { kind: "operator" };
      const project = k.repo.root;
      const ask = await call("merge.ask", { project, text: "Which names are private?" }, as("thread-1"));
      assert.equal(ask.ok, true, JSON.stringify(ask));
      for (const who of ["owner-1", "someone"]) assert.equal((await call("merge.ask", { project, text: "q" }, as(who))).ok, false, `${who} can't ask`);
      assert.equal((await call("merge.ask", { project }, as("thread-1"))).ok, false, "a question needs its text");
      // No chat relays the answer, not even the chat asked in: its model could answer for the user. The user's own next
      // message there is the answer (channel.ts takes it server-side). The operator's own page still answers.
      for (const who of ["owner-1", "someone", "thread-1"]) {
        const r = await call("merge.reply", { project, ask: "ak_1", text: "go with ours" }, as(who));
        assert.equal(r.error?.code, "forbidden", `${who}: ${JSON.stringify(r.error)}`);
        assert.match(r.error!.message, /your user's own next message in this chat is the answer/);
      }
      assert.deepEqual(answered, [], "no chat's answer reached the thread");
      assert.equal((await call("merge.reply", { project, ask: "ak_1", text: "typed on the tab" }, op)).ok, true, "the check can tell: the user's page answers");
      assert.deepEqual(answered, ["ak_1:typed on the tab"]);
      assert.deepEqual(bys, [{ kind: "operator" }]);
      // A chat's script on the operator's route never relays (not even the chat asked in's own), nor does a card's
      // command: neither reaches the thread.
      for (const [name, who] of [["a chat's script", { kind: "operator", fromChat: true } as Caller], ["a card's command", { kind: "operator", fromCard: true } as Caller]] as const) {
        const r = await call("merge.reply", { project, ask: "ak_1", text: "x" }, who);
        assert.equal(r.error?.code, "forbidden", `${name}: ${JSON.stringify(r.error)}`);
      }
      assert.equal(answered.length, 1, "none of them reached the thread");
      for (const verb of ["merge.fresh", "merge.clear"]) {
        for (const who of ["thread-1", "owner-1"]) assert.equal((await call(verb, { project, chat: "all" }, as(who))).ok, false, `${who} can't ${verb}`);
        assert.equal((await call(verb, { project, chat: "all" }, op)).ok, true, `the operator may ${verb}`);
      }
    } finally {
      await k.done();
    }
  });
});
