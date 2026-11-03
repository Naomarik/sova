// Run: pnpm test -- server/chat-handle.test.ts. Uses a throwaway PI_CODING_AGENT_DIR and cwd in the
// OS temp dir; ~/.pi is never read or written, and with no credentials no model is ever called.
//
// The seam the server talks to a chat through (server/chat-handle.ts): a command's refusal reaches
// the caller as the class the chat threw, an answer is the chat's own, the mirror reads the chat as
// it is, and lifecycle events carry increasing seqs a consumer can ask again for.
import assert from "node:assert/strict";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatLifecycleEvent, ServerToolCall } from "../shared/chat-runtime";
import type { ToolSpec } from "../shared/harness";

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-handle-test-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-chathandle--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { installInProcessChats } = await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const {
  acquireChatHandle,
  BusyError,
  chatEventsSince,
  chatHandle,
  closeChat,
  ConfigError,
  deliverServerToolCall,
  disposeAllChats,
  errorOfRefusal,
  failureReply,
  isSessionBusy,
  ModeRefusedError,
  onChatEvent,
  RefusedError,
  refusalOf,
  serverToolCall,
  serveTools,
  servedToolsFor,
  chatsReady,
  expectChatRouter,
  setChatRouter,
} = await import("./chat-handle");
const { canonicalPath } = await import("./paths");

after(async () => {
  await disposeAllChats();
});

let n = 0;
/** A one-turn session on disk: u1 → a1. */
function session(): string {
  const path = join(sessionsDir, `2026-10-12T00-00-0${n}-000Z_01a0-ch${n++}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: `01a0-ch${n}`, timestamp: "2026-10-12T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-12T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "zai", model: "glm-5.3", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}

test("a refusal crosses as its kind and comes back as the class the chat threw", () => {
  const cases: [Error, (e: Error) => boolean][] = [
    [new BusyError("a TUI has it", "busy"), (e) => e instanceof BusyError && e.code === "busy"],
    [new BusyError("someone wrote", "recent"), (e) => e instanceof BusyError && e.code === "recent"],
    [new ModeRefusedError("no mode here"), (e) => e instanceof ModeRefusedError],
    [new RefusedError("not yours"), (e) => e instanceof RefusedError && !(e instanceof ModeRefusedError)],
    [new ConfigError("gone", "/nowhere"), (e) => e instanceof ConfigError && e.cwd === "/nowhere"],
  ];
  for (const [err, same] of cases) {
    const refusal = refusalOf(err);
    assert.ok(refusal, err.message);
    assert.deepEqual(JSON.parse(JSON.stringify(refusal)), refusal, "a refusal is plain data");
    const back = errorOfRefusal(refusal);
    assert.ok(same(back), `${err.message} came back as ${back.constructor.name}`);
    assert.equal(back.message, err.message);
  }
  assert.equal(refusalOf(new Error("anything else")), null);
  assert.deepEqual(failureReply("c1", new BusyError("a TUI has it", "busy")), { id: "c1", ok: false, refusal: { kind: "busy", code: "busy", message: "a TUI has it" } });
  assert.deepEqual(failureReply("c2", new Error("boom")), { id: "c2", ok: false, error: { message: "boom" } });
});

test("commands answer with the chat's own results, and a failed one throws the chat's own error", async () => {
  const path = session();
  const h = await acquireChatHandle(path, true);
  assert.equal(chatHandle(path), h, "one handle per chat");
  assert.equal(h.mirror.chatId, path);
  assert.equal(h.mirror.sessionId, `01a0-ch${n}`);
  assert.equal(h.mirror.cwd, cwd);
  assert.equal(h.mirror.closed, false);
  assert.equal(h.mirror.running, false);
  assert.equal(h.mirror.pristine, false);
  assert.equal(h.mirror.leafId, "a1");
  assert.deepEqual(h.mirror.queue, { web: 0, agent: false });
  assert.equal(isSessionBusy(path), false);
  assert.deepEqual(
    (await h.branch()).map((e) => e.id),
    ["u1", "a1"],
  );
  assert.equal(await h.checkWrites(), false);
  await assert.rejects(h.setThinking("loudly"), /Unknown thinking level: loudly/);
  await assert.rejects(h.call("appendState", { kind: "no-such-kind", data: {} }), /Unknown state kind: no-such-kind/);
  // A blank message is no message: accepted, nothing queued, its "turn" ended at once; asked once.
  const receipt = await h.send({ text: "   ", track: true });
  assert.equal(receipt.queued, false);
  assert.deepEqual(await h.turnEnd(receipt), { ok: true });
  await assert.rejects(h.turnEnd(receipt), /That turn is not tracked/);
});

test("closing a chat is an event with a higher seq than any before, kept for a late reader", async () => {
  const path = session();
  const h = await acquireChatHandle(path, true);
  const seen: ChatLifecycleEvent[] = [];
  const off = onChatEvent((e) => seen.push(e));
  const before = chatEventsSince(0).at(-1)?.seq ?? 0;
  assert.equal(await closeChat(path, "test close"), true);
  off();
  assert.equal(h.closed, true);
  assert.equal(h.mirror.closed, true);
  assert.equal(chatHandle(path), undefined);
  const closed = seen.filter((e) => e.chatId === path && e.type === "closed");
  assert.equal(closed.length, 1);
  assert.ok(closed[0]!.seq > before);
  assert.deepEqual(
    chatEventsSince(before).filter((e) => e.chatId === path),
    closed,
  );
});

test("a server-hosted tool: the chat gets its declaration as data; each run is a call the server runs once per effect id", async () => {
  const path = session();
  await acquireChatHandle(path, true);
  const runs: { params: unknown; call: ServerToolCall | undefined }[] = [];
  const spec: ToolSpec = {
    name: "sova_probe",
    label: "Probe",
    description: "A tool whose state lives in the server.",
    parameters: { type: "object", properties: { n: { type: "number" }, ownerArea: { type: "string", enum: ["Finance", "none"] } } },
    prepareRule: "owner-area",
    prepareArguments: (args) => args,
    async execute(_id, params) {
      runs.push({ params, call: serverToolCall()?.call });
      await new Promise((r) => setTimeout(r, 1)); // the run's context survives its awaits
      if ((params as { n?: number }).n === 0) throw new RefusedError("zero is refused");
      return { content: [{ type: "text", text: `ran ${runs.length}` }], details: { seen: serverToolCall()?.call.toolCallId } };
    },
  };
  const [tool] = serveTools(path, [spec]);
  assert.deepEqual(JSON.parse(JSON.stringify(tool)), {
    name: "sova_probe",
    label: "Probe",
    description: "A tool whose state lives in the server.",
    parameters: { type: "object", properties: { n: { type: "number" }, ownerArea: { type: "string", enum: ["Finance", "none"] } } },
  }, "the chat holds the declaration; what runs it stays here");
  assert.deepEqual(tool!.prepareArguments!({ n: 1, ownerArea: " finance" }), { n: 1, ownerArea: "Finance" }, "the chat prepares the arguments by the rule the declaration names");
  assert.throws(() => serveTools(path, [{ ...spec, prepareRule: undefined }]), /must name its prepare rule/);

  const out = await tool!.execute("tc-1", { n: 1 }, undefined, undefined, undefined);
  assert.deepEqual(out, { content: [{ type: "text", text: "ran 1" }], details: { seen: "tc-1" } });
  const call = runs[0]!.call!;
  assert.equal(call.chatId, path);
  assert.equal(call.toolCallId, "tc-1");
  assert.equal(call.attended, false, "an ordinary chat's turn is nobody's to attend");
  assert.match(call.effectId, /#tc-1#/);
  assert.deepEqual(JSON.parse(JSON.stringify(call)), call, "a call is plain data");

  // The same tool call id again (a model may repeat one) is a new run with an effect id of its own.
  await tool!.execute("tc-1", { n: 2 }, undefined, undefined, undefined);
  assert.equal(runs.length, 2);
  assert.notEqual(runs[1]!.call!.effectId, call.effectId);

  // A call delivered again is answered with its first run's outcome, and never runs twice.
  const local = { signal: undefined, onUpdate: undefined, ctx: undefined, chat: { branch: () => [], entries: () => [], append: async () => "", tool: () => undefined } };
  const again: ServerToolCall = { ...call, effectId: "fx-again", params: { n: 3 } };
  const [first, second] = await Promise.all([deliverServerToolCall(again, { ...local }), deliverServerToolCall(again, { ...local })]);
  assert.deepEqual(first, second);
  assert.equal(runs.length, 3);
  assert.deepEqual(await deliverServerToolCall(again, { ...local }), first, "and after it ended");
  assert.equal(runs.length, 3);

  // A refusal reaches the chat as the error the tool threw; across a socket, its message.
  await assert.rejects(tool!.execute("tc-2", { n: 0 }, undefined, undefined, undefined), (e) => e instanceof RefusedError && e.message === "zero is refused");
  assert.deepEqual(await deliverServerToolCall({ ...call, effectId: "fx-zero", params: { n: 0 } }, { ...local }), { ok: false, error: { message: "zero is refused" } });
  assert.equal(serverToolCall(), undefined, "outside a run, no run");
});

test("a chat in a process of its own pushes a note under the title Sova shows for it, never a blank one (§chat.topics/push)", async () => {
  const { setTopicStore, topicStore } = await import("./topics");
  const { TopicStore } = await import("./topic-store");
  const { displayTitleOf } = await import("./sessions-index");
  const { setSessionTitle } = await import("./session-titles");
  setTopicStore(new TopicStore(join(agentDir, "topics-served")));
  const idOf = (p: string): string => JSON.parse(readFileSync(p, "utf8").split("\n")[0]!).id;
  const receiver = session();
  const local = { signal: undefined, onUpdate: undefined, ctx: undefined, chat: { branch: () => [], entries: () => [], append: async () => "", tool: () => undefined } };
  let k = 0;
  /** One push by `pusher` through its served queue_push, the chat reporting `known` as its title; the note's stored title. */
  const push = async (pusher: string, known: string | undefined): Promise<string> => {
    const s = topicStore();
    const { name } = s.open({ sessionId: idOf(receiver), path: receiver }, `sender check ${k}`);
    s.invite(name, idOf(pusher));
    // What the chat host serves an ordinary chat at its open, its take-back and its reopen.
    const decls = servedToolsFor(pusher, idOf(pusher), () => known, false);
    assert.ok(decls.some((d) => d.name === "queue_push"));
    const out = await deliverServerToolCall({ effectId: `fx-sender-${k}`, chatId: pusher, toolCallId: `tc-sender-${k++}`, name: "queue_push", params: { topic: name, text: "a note" }, attended: false, card: null }, { ...local });
    assert.equal(out.ok, true, JSON.stringify(out));
    return s.pending(name).at(-1)!.from.title;
  };

  // No pi session name (the chat reports none, or a blank one): its first message, as the list shows it.
  const unnamed = session();
  const shown = await displayTitleOf(unnamed);
  assert.equal(shown, "first ask");
  assert.equal(await push(unnamed, undefined), shown);
  assert.equal(await push(unnamed, ""), shown);
  // A title the user gave the session is what the list shows, so it is the sender's title too.
  const titled = session();
  setSessionTitle(idOf(titled), "Billing fixer");
  assert.equal(await displayTitleOf(titled), "Billing fixer");
  assert.equal(await push(titled, undefined), "Billing fixer");
  // A file the list can't read: the title the chat reports, else "Untitled"; never blank.
  const gone = join(sessionsDir, "not-a-session.jsonl");
  writeFileSync(gone, "not json\n");
  const pushed = (t: string | undefined) => {
    const s = topicStore();
    const { name } = s.open({ sessionId: idOf(receiver), path: receiver }, `sender check ${k}`);
    s.invite(name, "gone-id");
    servedToolsFor(gone, "gone-id", () => t, false);
    return deliverServerToolCall({ effectId: `fx-sender-${k}`, chatId: gone, toolCallId: `tc-sender-${k++}`, name: "queue_push", params: { topic: name, text: "a note" }, attended: false, card: null }, { ...local }).then(() => s.pending(name).at(-1)!.from.title);
  };
  assert.equal(await pushed("pi name"), "pi name");
  assert.equal(await pushed("  "), "Untitled");
});

test("server code reaches a chat only through its handle: nothing outside the chat's host imports chat-manager", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // The chat's host: the handle itself, the commands and mirror it shares with a chat process's host
  // (server/chat-runtime/), a special loadout's chat side (its port's type), and the pi adapter the chat runs on.
  const allowed = new Set(["server/chat-handle.ts", "server/chat-runtime/host.ts", "server/chat-runtime/methods.ts", "server/chat-runtime/mirror.ts", "server/chat-special.ts"]);
  const importers = globSync("{server,shared,src}/**/*.{ts,tsx}", { cwd: root })
    .map((f) => relative(root, join(root, f)))
    // server/testing/: test-only (a chat in the test's own process), never product.
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith("server/harness/") && !f.startsWith("server/testing/") && f !== "server/chat-manager.ts")
    .filter((f) => /from "(?:\.\.?\/)+(?:[\w-]+\/)*chat-manager(?:\.ts)?"/.test(readFileSync(join(root, f), "utf8")));
  assert.deepEqual(importers.filter((f) => !allowed.has(f)), []);
  assert.deepEqual([...allowed].filter((f) => !importers.includes(f)), [], "an allowed file that no longer imports it leaves the list");
});

/** The chat's host: what runs the chat itself, in the server's process or a chat process. */
const CHAT_HOST = new Set(["server/chat-handle.ts", "server/chat-runtime/host.ts", "server/chat-runtime/methods.ts", "server/chat-runtime/mirror.ts"]);

test("nothing outside the chat's host is handed a chat or its driving session", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // The code, its comments left out (prose may name what it explains).
  const code = (f: string) =>
    readFileSync(join(root, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  const files = globSync("{server,shared,src}/**/*.{ts,tsx}", { cwd: root })
    .map((f) => relative(root, join(root, f)))
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith("server/harness/") && !f.startsWith("server/testing/") && !f.startsWith("shared/harness") && f !== "server/chat-manager.ts" && !CHAT_HOST.has(f));
  // The handle hands out no chat: no ChatSession, no hook that gets one, no way back to one.
  const handle = code("server/chat-handle.ts");
  assert.doesNotMatch(handle, /export (type )?\{[^}]*\bChatSession\b/, "chat-handle re-exports no ChatSession");
  assert.doesNotMatch(handle, /export const chatHandleOf/, "no handle is made from a chat outside the host");
  assert.deepEqual(files.filter((f) => /\bChatSession\b/.test(code(f))), [], "no server module names the chat itself");
  // A driving session reaches only the chat's own helpers, which the chat hands it (its stream guard,
  // its person's turns); loadout policy hears its runs as data (ChatRunEvent). The list only shrinks.
  const helpers = new Set(["server/stream-guard.ts", "server/user-turns.ts"]);
  const reach = files.filter((f) => /\bHarnessSession\b/.test(code(f)));
  assert.deepEqual(reach.filter((f) => !helpers.has(f)), [], "a driving session outside the chat's own helpers");
  assert.deepEqual([...helpers].filter((f) => !reach.includes(f)), [], "a helper that no longer takes one leaves the list");
});

test("a server that will install a router makes boot readers wait for it: chats a previous server left running are taken back first", async () => {
  setChatRouter(null); // the in-process router these tests run on, out of the way
  expectChatRouter();
  let ready = false;
  const waiting = chatsReady().then(() => (ready = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ready, false, "no router yet: not \"none\", just not yet");
  let release!: () => void;
  const taken = new Promise<void>((r) => (release = r));
  setChatRouter({ ready: () => taken, get: () => undefined, all: () => [], acquire: async () => assert.fail("not opened here"), close: async () => false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ready, false, "the router is there, taking chats back");
  release();
  await waiting;
  assert.equal(ready, true);
  setChatRouter(null);
  await chatsReady(); // with none expected and none installed: at once
  installInProcessChats();
});

test("an ordinary chat is served its offer tool last, from its snapshot; a chat without offers or a special kind is served exactly what it was", async () => {
  const { servedToolsForChat } = await import("./chat-handle");
  const project = join(agentDir, "offers-project");
  mkdirSync(join(project, ".sova"), { recursive: true });
  const write = (names: string[]) =>
    writeFileSync(join(project, ".sova", "offers.json"), JSON.stringify({ version: 1, offers: Object.fromEntries(names.map((n) => [n, { when: `When ${n}.`, title: n, buttons: [{ label: "Go", about: "Goes.", send: "go" }] }])) }));
  const at = (id: string, dir: string): string => {
    const path = join(sessionsDir, `2026-10-23T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-23T00:00:00.000Z", cwd: dir })}\n`);
    return canonicalPath(path);
  };
  const names = (decls: { name: string }[]) => decls.map((d) => d.name);
  // No offers file: what servedToolsFor serves, and nothing more.
  const plain = at("01a0-offers-plain", cwd);
  assert.deepEqual(names(await servedToolsForChat(plain, "01a0-offers-plain", () => undefined, null)), names(servedToolsFor(plain, "01a0-offers-plain", () => undefined, false)));
  write(["alpha"]);
  const withOffers = at("01a0-offers-yes", project);
  const decls = await servedToolsForChat(withOffers, "01a0-offers-yes", () => undefined, null);
  assert.equal(decls.at(-1)!.name, "offer", "last, after every tool a chat had before");
  assert.deepEqual(names(decls).slice(0, -1), names(servedToolsFor(withOffers, "01a0-offers-yes", () => undefined, false)));
  // Its reopen reads the snapshot, whatever the file says now.
  write(["alpha", "charlie"]);
  const again = await servedToolsForChat(withOffers, "01a0-offers-yes", () => undefined, null);
  assert.deepEqual(JSON.stringify(again.at(-1)), JSON.stringify(decls.at(-1)), "the declaration is byte-identical");
  // A special chat (the Overseer, a project overseer) never gets it; a powers profile's chat does.
  const special = at("01a0-offers-special", project);
  assert.ok(!names(await servedToolsForChat(special, "01a0-offers-special", () => undefined, "overseer")).includes("offer"));
  const powers = at("01a0-offers-powers", project);
  assert.ok(names(await servedToolsForChat(powers, "01a0-offers-powers", () => undefined, "powers")).includes("offer"));
});
