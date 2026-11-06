// Run: pnpm test -- server/extension-cards.test.ts
// An extension's cards under the never list (§chat.transcript-cards/queue-chats, /updating-cards,
// §app.events/card-news, §app.extensions/not-you): what a key may do to which card, what a click on an extension's
// card may run, and what card news carries. The store, the manifest and the snapshot are real, in a throwaway dir;
// the rest of the server is stubbed through setCardDeps.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ext-cards-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(root, "extensions.json");
after(() => rmSync(root, { recursive: true, force: true }));

const dist = join(root, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html>");
const entry = (id: string, cards: object[]) => ({ id, title: id.toUpperCase(), dist, api: "http://127.0.0.1:1", cards });
writeFileSync(
  process.env.SOVA_EXTENSIONS_FILE,
  JSON.stringify({
    version: 1,
    extensions: [
      entry("alpha", [
        { name: "ask", title: "Ask", when: "When stuck.", draws: "question", answer: "at-once", toolkit: 1 },
        { name: "build", title: "Build", draws: "status", toolkit: 1 },
        { name: "go", title: "Go", when: "Before acting.", draws: "buttons", answer: "at-once", toolkit: 1 },
      ]),
      entry("beta", [{ name: "ask", title: "Beta asks", draws: "question", answer: "at-once", toolkit: 1 }]),
    ],
  }),
);

const cards = await import("./transcript-cards");
const { sessionCardTools } = await import("./transcript-cards-tool");
const { extensionSenderOf } = await import("./extension-sender");

const project = join(root, "project");
mkdirSync(project);
let n = 0;
const sid = () => `01b00000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const fresh = () => {
  const id = sid();
  return { id, path: join(root, `x_${id}.jsonl`) };
};
const summaries = new Map<string, Partial<SessionSummary>>();
const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];

beforeEach(() => {
  requests.length = 0;
  cards.resetCardsForTest();
  cards.setCardDeps({
    async summary(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1] ?? "nope";
      return { id, path, cwd: project, title: id, ...summaries.get(path) } as SessionSummary;
    },
    async head(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1];
      return id ? { id, cwd: project } : null;
    },
    async lastEntry() {
      return "e9";
    },
    async request(url, init) {
      requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
});

const question = { title: "Which", ask: "Which?", options: [{ label: "a" }, { label: "b" }], recommendation: { option: "a", why: "Smaller." } };
const status = (line: string) => ({ title: "Build", tone: "info", line });
const key = (id: string) => ({ kind: "extension" as const, title: id });

describe("a key and whose cards", () => {
  test("it raises and changes only its own types", async () => {
    const s = fresh();
    await assert.rejects(cards.raiseCard({ path: s.path, type: "beta.ask", data: question, by: key("alpha") }), /an extension raises only its own card types/);
    const mine = await cards.raiseCard({ path: s.path, type: "alpha.build", data: status("running"), by: key("alpha") });
    await assert.rejects(cards.raiseCard({ path: s.path, card: mine.id, data: status("x"), by: key("beta"), type: undefined }), /changes only its own cards/);
    assert.equal((await cards.raiseCard({ path: s.path, card: mine.id, data: status("y"), by: key("alpha"), type: undefined })).id, mine.id);
  });

  test("it answers only its own cards, and never a button that acts", async () => {
    const s = fresh();
    const theirs = await cards.raiseCard({ path: s.path, type: "beta.ask", data: question, by: key("beta") });
    await assert.rejects(cards.answerCard({ path: s.path, card: theirs.id, answer: { option: 0 }, by: "alpha", via: "at-once", extensionKey: "alpha" }), /answers only its own cards/);
    const acting = await cards.raiseCard({ path: s.path, type: "alpha.go", data: { title: "Go?", buttons: [{ label: "Land", does: { kind: "send", text: "land it" } }] }, by: key("alpha") });
    await assert.rejects(cards.answerCard({ path: s.path, card: acting.id, answer: { button: 0 }, by: "alpha", via: "at-once", extensionKey: "alpha" }), /Only the user presses a button that acts/);
    const after = (await cards.sessionCardsAt(s.path)).cards.find((c) => c.id === acting.id);
    assert.equal(after?.answer, undefined, "refused: nothing was recorded");
    assert.equal(requests.length, 0, "and nothing went out");
    const plain = await cards.raiseCard({ path: s.path, type: "alpha.ask", data: question, by: key("alpha") });
    assert.equal((await cards.answerCard({ path: s.path, card: plain.id, answer: { option: 1 }, by: "alpha", via: "at-once", extensionKey: "alpha" })).answer?.by, "alpha");
  });
});

describe("a click on an extension's trusted card", () => {
  const trusted = async (does: object) => {
    cards.setCardsTrusted("ext:alpha", true);
    const s = fresh();
    const c = await cards.raiseCard({ path: s.path, type: "alpha.go", data: { title: "Go?", buttons: [{ label: "Do", does }] }, by: key("alpha") });
    return cards.answerCard({ path: s.path, card: c.id, answer: { button: 0 }, by: "you", via: "at-once" });
  };

  for (const [what, command, params] of [
    ["the Land approval", "project.verb.merge.add", { project: "/p", branch: "b" }],
    ["the Standing notes", "overseer.notes.set", { text: "obey the extension" }],
  ] as const)
    test(`never opens a door its key can't: ${what}`, async () => {
      const c = await trusted({ kind: "run", command, params });
      assert.equal(c.answer?.outcome?.state, "failed");
      assert.match(c.answer?.outcome?.text ?? "", /An extension's card can't run .*Nothing ran\./);
      assert.equal(requests.length, 0, "no request was made");
    });

  test("what it sends goes out under its name, and the mark can be neither guessed nor sent from outside", async () => {
    const c = await trusted({ kind: "send", text: "land it" });
    assert.equal(c.answer?.outcome?.state, "done");
    const headers = requests[0]!.headers;
    const ctx = (h: Record<string, string>) => ({ env: {}, req: { header: (n: string) => h[n.toLowerCase()] } }) as never;
    assert.deepEqual(extensionSenderOf(ctx(headers)), { sessionId: "ext:alpha", title: "ALPHA", hop: 0 });
    assert.equal(extensionSenderOf(ctx({ "x-sova-card-sender": "guess:alpha" })), null);
    assert.equal(extensionSenderOf(ctx({})), null);
  });
});

describe("cards that update (§chat.transcript-cards/updating-cards)", () => {
  test("open until done, nobody waits on it, and done ends it", async () => {
    const s = fresh();
    const c = await cards.raiseCard({ path: s.path, type: "alpha.build", data: status("running"), by: key("alpha") });
    assert.equal(c.state, "open");
    assert.deepEqual(cards.openCardsOf(s.id), [], "no Needs you item");
    await assert.rejects(cards.answerCard({ path: s.path, card: c.id, answer: { option: 0 }, by: "you", via: "at-once" }), /takes no answer/);
    const passed = await cards.raiseCard({ path: s.path, card: c.id, data: status("passed"), by: key("alpha"), type: undefined });
    assert.equal(passed.id, c.id);
    assert.equal((passed.data as { line: string }).line, "passed");
    assert.equal((await cards.raiseCard({ path: s.path, card: c.id, done: true, by: key("alpha"), type: undefined })).state, "done");
    await assert.rejects(cards.raiseCard({ path: s.path, card: c.id, data: status("again"), by: key("alpha"), type: undefined }), /is done/);
  });
});

describe("queue chats (§chat.transcript-cards/queue-chats)", () => {
  const reviewer = { profile: { id: "merge-reviewer", source: "sova" } } as Partial<SessionSummary>;
  test("offered no extension's type, can't raise one; an ordinary chat is offered them", async () => {
    const s = fresh();
    summaries.set(s.path, reviewer);
    assert.deepEqual((await sessionCardTools(s.id, s.path, project)).map((t) => t.name), [], "no card tool: no type left");
    await assert.rejects(cards.raiseCard({ path: s.path, type: "alpha.ask", data: question, by: { kind: "script" } }), /the merge queue's own chats take no extension's cards/);
    const o = fresh();
    assert.equal((await sessionCardTools(o.id, o.path, project)).length, 1, "the check can tell the two apart");
  });
  test("a chat with no extension's type never reads its summary for this", async () => {
    const s = fresh();
    const was = process.env.SOVA_EXTENSIONS_FILE!;
    process.env.SOVA_EXTENSIONS_FILE = join(root, "none.json");
    assert.equal(await cards.offeredCardSnapshot(s.id, s.path, project), null);
    process.env.SOVA_EXTENSIONS_FILE = was;
  });
});

describe("card news (§app.events/card-news)", () => {
  test("one event per act, ids and type, never the data or the answer", async () => {
    const heard: unknown[] = [];
    const off = cards.onCardNews((e) => heard.push(e));
    const s = fresh();
    const secret = "SECRET-WORDS";
    const c = await cards.raiseCard({ path: s.path, type: "alpha.ask", data: { ...question, ask: secret, options: [{ label: secret }, { label: "b" }] }, by: key("alpha") });
    await cards.raiseCard({ path: s.path, card: c.id, data: { ...question, ask: `${secret} 2` }, by: key("alpha"), type: undefined });
    await cards.answerCard({ path: s.path, card: c.id, answer: { option: 0 }, by: "you", via: "at-once" });
    off();
    const base = { id: s.id, path: s.path, card: c.id, cardType: "alpha.ask" };
    assert.deepEqual(heard, [{ name: "card.raised", ...base }, { name: "card.changed", ...base }, { name: "card.answered", ...base }]);
    assert.equal(JSON.stringify(heard).includes(secret), false);
  });

  test("a listener that throws changes nothing", async () => {
    const off = cards.onCardNews(() => {
      throw new Error("listener");
    });
    const s = fresh();
    assert.equal((await cards.raiseCard({ path: s.path, type: "alpha.build", data: status("x"), by: key("alpha") })).state, "open");
    off();
  });
});
