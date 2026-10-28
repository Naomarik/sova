// Transcript cards on the server (§chat/transcript-cards): a project's card folders and their checks, the
// snapshot a session's tool is built from, every rule a raise checks, answering at once and gathered, trust,
// the agent's note and the open cards Needs you lists. What the rest of the server answers (summaries, the
// routes a button calls) is stubbed through setCardDeps; the store and the files are real, in a throwaway dir.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import { CARD_TOOL } from "../shared/transcript-cards";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-cards-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => rmSync(root, { recursive: true, force: true }));

const cards = await import("./transcript-cards");
const { sessionCardTools } = await import("./transcript-cards-tool");

const project = join(root, "project");
const writeCard = (name: string, card: unknown, dir = project) => {
  mkdirSync(join(dir, ".sova", "cards", name), { recursive: true });
  writeFileSync(join(dir, ".sova", "cards", name, "card.json"), typeof card === "string" ? card : JSON.stringify(card));
};
const base = { version: 1, toolkit: 1 };
writeCard("pick", { ...base, title: "Pick a format", when: "When a format must be chosen.", draws: "question", answer: "gather" });
writeCard("go", { ...base, title: "Go ahead?", when: "Before acting.", draws: "buttons", answer: "at-once" });
writeCard("build", { ...base, title: "Build", draws: "status" });
writeCard("plan", { ...base, title: "Plan", when: "While planning.", draws: "checklist", answer: "at-once", placement: "follow" });

let n = 0;
const sid = () => `01a00000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
const pathOf = (id: string) => join(root, "sessions", `x_${id}.jsonl`);
const summaries = new Map<string, Partial<SessionSummary> & { started?: boolean; parent?: string }>();
const requests: { url: string; body: unknown }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
let last: string | null = "e9";

beforeEach(() => {
  requests.length = 0;
  answer = { status: 200, body: { ok: true } };
  last = "e9";
  cards.resetCardsForTest();
  cards.setCardDeps({
    async summary(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1] ?? "nope";
      return { id, path, cwd: project, title: `Session ${id}`, ...summaries.get(path) } as SessionSummary;
    },
    async head(path) {
      const id = /x_(.+)\.jsonl$/.exec(path)?.[1];
      const o = summaries.get(path);
      return id ? { id, cwd: project, ...(o?.parent ? { parent: o.parent } : {}), ...(o?.started ? { started: true } : {}) } : null;
    },
    async lastEntry() {
      return last;
    },
    async request(url, init) {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    },
  });
});

const question = { title: "Format", ask: "Which format?", options: [{ label: "CSV" }, { label: "Parquet" }], recommendation: { option: "b", why: "Smaller." } };
const buttons = (does: unknown = { kind: "answer" }) => ({ title: "Deploy now?", buttons: [{ label: "Deploy", does }, { label: "Wait", does: { kind: "answer" } }] });
const fresh = () => {
  const id = sid();
  return { id, path: pathOf(id) };
};

describe("card folders (§chat.transcript-cards/files)", () => {
  test("each folder is its type or what is wrong; one broken folder hides no other", () => {
    const dir = join(root, "folders");
    writeCard("good", { ...base, title: "Good", draws: "table" }, dir);
    writeCard("Bad_Name", { ...base, title: "x", draws: "table" }, dir);
    writeCard("nojson", "{", dir);
    writeCard("extra", { ...base, title: "x", draws: "table", colour: "red" }, dir);
    writeCard("view", { ...base, title: "x", draws: "view", data: { type: "object" } }, dir);
    writeCard("status-answer", { ...base, title: "x", draws: "status", answer: "at-once" }, dir);
    mkdirSync(join(dir, ".sova", "cards", "empty"), { recursive: true });
    const got = Object.fromEntries(cards.readCardFolders(dir).map((f) => [f.name, f.ok ? f.decl.type : f.error]));
    assert.equal(got.good, "project.good");
    assert.match(String(got.Bad_Name), /lowercase letters/);
    assert.match(String(got.nojson), /isn't JSON/);
    assert.match(String(got.extra), /"colour" is not a key/);
    assert.match(String(got.view), /view\.tsx is missing/);
    assert.match(String(got["status-answer"]), /takes no answer/);
    assert.match(String(got.empty), /card\.json is missing/);
  });

  test("past 16 types, the rest are broken and don't count", () => {
    const dir = join(root, "many");
    for (let i = 0; i < 18; i++) writeCard(`c${String(i).padStart(2, "0")}`, { ...base, title: `C${i}`, draws: "table" }, dir);
    const folders = cards.readCardFolders(dir);
    assert.equal(folders.filter((f) => f.ok).length, 16);
    assert.match((folders.at(-1) as { error: string }).error, /Past the first 16/);
  });

  test("the project page's list: each folder by its path, broken ones with what is wrong, and its cards' trust", async () => {
    const dir = join(root, "listed");
    writeCard("good", { ...base, title: "Good", draws: "table" }, dir);
    writeCard("extra", { ...base, title: "x", draws: "table", colour: "red" }, dir);
    const listed = await cards.projectCards(dir);
    assert.deepEqual(listed.folders, [
      { name: "extra", path: ".sova/cards/extra", ok: false, error: '"colour" is not a key card.json has.' },
      { name: "good", path: ".sova/cards/good", ok: true, type: "project.good", title: "Good" },
    ]);
    assert.deepEqual(listed.trust, { owner: cards.projectOwner(dir), name: "listed", trusted: false });
    cards.setCardsTrusted(cards.projectOwner(dir), true);
    assert.equal((await cards.projectCards(dir)).trust.trusted, true);
    cards.setCardsTrusted(cards.projectOwner(dir), false);
    assert.equal((await cards.projectCards(dir)).trust.trusted, false, "Stop Trusting Cards takes effect at once");
  });
});

describe("the snapshot and the tool (§chat.transcript-cards/files, /card-tool)", () => {
  test("taken at the first build and kept: a later edit changes no running chat", async () => {
    const s = fresh();
    const tools = await sessionCardTools(s.id, s.path, project);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, CARD_TOOL);
    const enumOf = () => ((tools[0]!.parameters as { properties: { type: { enum: string[] } } }).properties.type.enum);
    assert.deepEqual(enumOf(), ["project.go", "project.pick", "project.plan"], "only types with a when, never build");
    writeCard("late", { ...base, title: "Late", when: "Never seen.", draws: "status" });
    const again = await sessionCardTools(s.id, s.path, project);
    assert.equal(again[0]!.description, tools[0]!.description);
    rmSync(join(project, ".sova", "cards", "late"), { recursive: true });
  });

  test("a session that already talked with no snapshot records none; a fork takes its parent's", async () => {
    const old = fresh();
    summaries.set(old.path, { started: true });
    assert.deepEqual(await sessionCardTools(old.id, old.path, project), []);
    const parent = fresh();
    await sessionCardTools(parent.id, parent.path, project);
    const fork = fresh();
    summaries.set(fork.path, { parent: parent.path, started: true });
    assert.equal((await sessionCardTools(fork.id, fork.path, project)).length, 1);
  });

  test("a chat whose snapshot has no type with a when gets no tool", async () => {
    const dir = join(root, "outside-only");
    writeCard("build", { ...base, title: "Build", draws: "status" }, dir);
    const s = fresh();
    assert.deepEqual(await sessionCardTools(s.id, s.path, dir), []);
    assert.equal((await cards.cardSnapshotFor(s.id, s.path, dir))?.types.length, 1, "the snapshot still holds it for a script");
  });
});

describe("raising (§chat.transcript-cards/card-tool, /raise-command)", () => {
  test("an agent's card stands at its call; one from outside after the transcript's last entry", async () => {
    const s = fresh();
    const a = await cards.raiseCard({ path: s.path, type: "project.pick", data: question, by: { kind: "agent" }, toolCallId: "call1" });
    assert.equal(a.id, "cd_1");
    assert.equal(a.toolCallId, "call1");
    assert.equal(a.after, undefined);
    assert.equal(a.state, "open");
    const b = await cards.raiseCard({ path: s.path, type: "project.build", data: { title: "Build", tone: "ok", line: "Green." }, by: { kind: "script" } });
    assert.equal(b.id, "cd_2");
    assert.equal(b.after, "e9");
    assert.equal(b.state, "done", "a card that takes no answer is never waiting");
  });

  test("every refusal says why and raises nothing", async () => {
    const s = fresh();
    const no = (input: Partial<Parameters<typeof cards.raiseCard>[0]>, re: RegExp) =>
      assert.rejects(cards.raiseCard({ path: s.path, by: { kind: "script" }, type: "project.pick", data: question, ...input }), re);
    await no({ data: { ...question, options: [{ label: "x".repeat(121) }, { label: "y" }] } }, /^Error: Nothing was raised: options\[0\]\.label is longer than 120 characters\.$/);
    await no({ type: "project.nope" }, /not a card type this session may raise/);
    await no({ type: "project.build", by: { kind: "agent" }, data: { title: "B", tone: "ok", line: "x" } }, /raised only from outside/);
    await no({ type: "project.plan", data: { title: "P", items: [{ text: "a", done: false }] } }, /needs a key/);
    await no({ key: "k" }, /takes no key/);
    summaries.set(s.path, { align: { openQuestions: 1 } as never });
    await no({}, /Nothing was raised: an alignment question is open\./);
    summaries.set(s.path, { workerSession: true } as never);
    await no({}, /only in ordinary chats/);
    summaries.delete(s.path);
    assert.deepEqual((await cards.sessionCardsAt(s.path)).cards, []);
  });

  test("a follow card's key raises revisions; only the newest is waiting", async () => {
    const s = fresh();
    const data = (done: boolean) => ({ title: "Plan", items: [{ text: "Write it", done }] });
    const r1 = await cards.raiseCard({ path: s.path, type: "project.plan", key: "p", data: data(false), by: { kind: "agent" }, toolCallId: "c1" });
    const r2 = await cards.raiseCard({ path: s.path, type: "project.plan", key: "p", data: data(true), by: { kind: "agent" }, toolCallId: "c2" });
    assert.equal(r1.revision, 1);
    assert.equal(r2.revision, 2);
    const all = (await cards.sessionCardsAt(s.path)).cards;
    assert.deepEqual(all.map((c) => c.state), ["superseded", "open"]);
    assert.deepEqual(cards.openCardsOf(s.id).map((c) => c.id), ["cd_2"]);
  });

  test("session.card.post with card: new data in place, keeping its answer, or done", async () => {
    const s = fresh();
    await cards.raiseCard({ path: s.path, type: "project.pick", data: question, by: { kind: "script" } });
    const revised = await cards.raiseCard({ path: s.path, card: "cd_1", data: { ...question, ask: "Which one now?" }, type: undefined, by: { kind: "script" } });
    assert.equal((revised.data as { ask: string }).ask, "Which one now?");
    const done = await cards.raiseCard({ path: s.path, card: "cd_1", done: true, type: undefined, by: { kind: "script" } });
    assert.equal(done.state, "done");
    assert.deepEqual(cards.openCardsOf(s.id), []);
  });
});

describe("answering (§chat.transcript-cards/answering)", () => {
  test("at once: recorded with who and when; the first answer claims the card", async () => {
    const s = fresh();
    await cards.raiseCard({ path: s.path, type: "project.go", data: buttons(), by: { kind: "agent" }, toolCallId: "c" });
    assert.deepEqual(cards.openCardsOf(s.id).map((c) => c.title), ["Deploy now?"]);
    const c = await cards.answerCard({ path: s.path, card: "cd_1", answer: { button: 0 }, by: "you", via: "at-once" });
    assert.equal(c.state, "answered");
    assert.equal(c.answer?.text, "Deploy");
    assert.equal(c.answer?.by, "you");
    await assert.rejects(cards.answerCard({ path: s.path, card: "cd_1", answer: { button: 1 }, by: "you", via: "at-once" }), /already answered: Deploy/);
    assert.deepEqual(cards.openCardsOf(s.id), []);
    assert.equal(requests.length, 0, "an answer button runs nothing");
  });

  test("a gathering card takes no press at once; its pick is recorded once the message went out", async () => {
    const s = fresh();
    await cards.raiseCard({ path: s.path, type: "project.pick", data: question, by: { kind: "agent" }, toolCallId: "c" });
    await assert.rejects(cards.answerCard({ path: s.path, card: "cd_1", answer: { option: 1 }, by: "you", via: "at-once" }), /goes with the next message/);
    const c = await cards.answerCard({ path: s.path, card: "cd_1", answer: { option: 1 }, by: "you", via: "send" });
    assert.equal(c.answer?.text, "b: Parquet");
    assert.equal(cards.cardNoteFor(s.id), null, "a gathered answer is in the message itself, never a note");
  });

  test("a button that acts needs its project trusted; then it runs, and its outcome is in the note", async () => {
    const s = fresh();
    await cards.raiseCard({ path: s.path, type: "project.go", data: buttons({ kind: "send", text: "deploy it" }), by: { kind: "agent" }, toolCallId: "c" });
    await assert.rejects(
      cards.answerCard({ path: s.path, card: "cd_1", answer: { button: 0 }, by: "you", via: "at-once" }),
      (err: unknown) => err instanceof cards.CardRefusal && !!err.needsTrust && /isn't trusted/.test(err.message),
    );
    assert.equal((await cards.sessionCardsAt(s.path)).cards[0]!.state, "open", "nothing recorded, nothing sent");
    const owner = (await cards.sessionCardsAt(s.path)).trust!.owner;
    cards.setCardsTrusted(owner, true);
    const c = await cards.answerCard({ path: s.path, card: "cd_1", answer: { button: 0 }, by: "you", via: "at-once" });
    assert.equal(c.answer?.outcome?.state, "done");
    assert.equal(requests[0]!.url, "/api/sessions/prompt");
    assert.equal((requests[0]!.body as { text: string }).text, "deploy it");
    const note = cards.cardNoteFor(s.id);
    assert.match(String(note), /^Card cd_1 \(project\.go, "Go ahead\?"\): The user chose Deploy\. It went through: Sent\.$/);
    assert.equal(cards.cardNoteFor(s.id, c.answer!.at), null, "a note already given isn't given again");
    cards.setCardsTrusted(owner, false);
    assert.equal((await cards.sessionCardsAt(s.path)).trust?.trusted, false);
  });

  test("a command that only looks runs untrusted", async () => {
    const s = fresh();
    await cards.raiseCard({ path: s.path, type: "project.go", data: buttons({ kind: "run", command: "session.card.get" }), by: { kind: "agent" }, toolCallId: "c" });
    const c = await cards.answerCard({ path: s.path, card: "cd_1", answer: { button: 0 }, by: "a script", via: "at-once" });
    assert.equal(c.answer?.outcome?.state, "done");
    assert.match(requests[0]!.url, /^\/api\/session-cards\?path=/);
    assert.match(String(cards.cardNoteFor(s.id)), /a script chose Deploy/);
  });
});
