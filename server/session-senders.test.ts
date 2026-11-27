// Who started a chat and who typed each message (§app.extensions/senders), through a real chat on a scripted model:
// recorded only while an active extension's offers name `senders`, never in the model's context, and with nothing
// asking, nothing is written at all. A throwaway PI_CODING_AGENT_DIR and its own extension list (SOVA_EXTENSIONS_FILE
// counts its entries as approved).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { until } from "./test-wait";
import type { ChatClientMessage, ChatServerMessage, TranscriptItem } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-senders-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));
const extFile = join(agentDir, "extensions-list.json");
process.env.SOVA_EXTENSIONS_FILE = extFile;
writeFileSync(extFile, JSON.stringify({ version: 1, extensions: [] }));

await import("./testing/in-process-chats"); // chats open in this process: a REST send reaches the same chat
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { readExtensions, recordsAsked } = await import("./extensions");
const { memberOfSocket, startedByFile } = await import("./session-senders");
const { setFrameMember } = await import("./member-frame");
const { offersOf } = await import("../shared/extension-offers");
const { sendersOf } = await import("../shared/senders");

after(async () => {
  await disposeAllChats();
});

/** The list as it stands: one extension asking for senders, one that doesn't, or nothing. Read once, as the key sync would. */
function installed(list: "asking" | "not asking" | "nothing" | "asking, off"): void {
  const asking = { id: "team-bar", title: "Team bar", records: ["senders"] };
  const other = { id: "plain", title: "Plain", screens: ["row"] };
  const extensions = list === "asking" ? [asking, other] : list === "asking, off" ? [{ ...asking, off: true }, other] : list === "not asking" ? [other] : [];
  writeFileSync(extFile, JSON.stringify({ version: 1, extensions }));
  readExtensions();
}

const PEER = { nodeId: "nPEER1CNTRL", label: "Kim's laptop" };
const WHO = [null, "local", "script", "chat", "extension", "overseer"] as const;

async function session(): Promise<{ path: string; id: string }> {
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()) as { path: string; id: string };
}

/** A chat on the scripted model, with a pane attached. */
async function open(path: string) {
  const chat = await acquireChat(path);
  const model = new ScriptedModel();
  model.attach(piSession(chat));
  const heard: ChatServerMessage[] = [];
  const pane = { send: (m: ChatServerMessage) => void heard.push(m) };
  chat.attach(pane);
  /** A pane's frame, as server/ws.ts hands it on: with the caller its socket names beside it, if any. */
  const send = (msg: ChatClientMessage, who: (typeof WHO)[number], peer?: typeof PEER) => {
    const member = memberOfSocket(who, peer);
    if (member) setFrameMember(msg, member);
    chat.handle(pane, msg);
  };
  const settled = (text: string, calls: number) => until(() => readFileSync(path, "utf8").includes(text) && model.calls.length >= calls && chat.quietForReload, `"${text}" to be answered`);
  return { chat, model, send, settled };
}

const transcript = async (path: string): Promise<TranscriptItem[]> => ((await (await app.request(`/api/transcript?path=${encodeURIComponent(path)}`)).json()) as { items: TranscriptItem[] }).items;
const senders = async (path: string) => (await app.request(`/api/sessions/senders?path=${encodeURIComponent(path)}`)).json() as Promise<{ startedBy: { by: string } | null; messages: { entryId: string; by: string; label?: string }[] }>;

/** The user messages' words, as the model was given them at its last call. */
function userWordsSeen(model: ScriptedModel): string[] {
  const ctx = model.calls.at(-1)!.context as { messages: { role: string; content: unknown }[] };
  return ctx.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).filter((p) => p.type === "text").map((p) => p.text).join("")));
}

test("the offer: `records` names what Sova records, only known names, each dropped alone", () => {
  assert.deepEqual(offersOf("x", { records: ["senders", "everything"] }), { offers: { records: ["senders"] }, dropped: ["1 of its records"] });
  assert.deepEqual(offersOf("x", { records: "senders" }), { offers: null, dropped: ["records is not an array"] });
  assert.deepEqual(offersOf("x", { records: [] }), { offers: null, dropped: [] });
});

test("the gate follows the active list: asked only while an active extension's offers name senders", () => {
  for (const [list, asked] of [["nothing", false], ["not asking", false], ["asking", true], ["asking, off", false], ["asking", true], ["nothing", false]] as const) {
    installed(list);
    assert.equal(recordsAsked("senders"), asked, list);
    // A socket names its caller only while asked: this machine's page, or a linked computer's socket; a program never.
    for (const who of WHO) {
      const want = !asked ? undefined : who === null ? { by: "operator" } : who === "local" ? { by: `peer:${PEER.nodeId}`, label: PEER.label } : undefined;
      assert.deepEqual(memberOfSocket(who, PEER), want, `${list}: ${who}`);
    }
  }
});

test("with nothing asking, no chat is marked and nothing is written beside it", async () => {
  installed("not asking");
  const s = await session();
  const { send, settled } = await open(s.path);
  send({ type: "prompt", text: "from my page", clientId: "a" }, null);
  await settled("from my page", 1);
  send({ type: "prompt", text: "from a linked computer", clientId: "b" }, "local", PEER);
  await settled("from a linked computer", 2);
  const res = await app.request("/api/sessions/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: s.path, text: "by REST" }) });
  assert.equal(res.status, 200, await res.clone().text());
  await until(() => readFileSync(s.path, "utf8").includes("by REST"), "the REST send");
  assert.ok(!readFileSync(s.path, "utf8").includes("sova-member-sent"), "no marker in the chat's file");
  assert.equal(existsSync(startedByFile()), false, "no sidecar");
  assert.deepEqual(await senders(s.path), { startedBy: null, messages: [] });
});

test("while an extension asks: who started it and who typed each message, never in the model's context", async () => {
  installed("asking");
  const s = await session();
  assert.equal((await senders(s.path)).startedBy?.by, "operator", "started here, by the operator");
  assert.equal(readFileSync(startedByFile(), "utf8").split("\n").filter((l) => l.includes(s.id)).length, 1, "one line beside it");
  const { model, send, settled } = await open(s.path);
  send({ type: "prompt", text: "from a linked computer", clientId: "a" }, "local", PEER);
  await settled("from a linked computer", 1);
  // A steer while a reply runs waits in Sova's queue and is marked at its hand-off.
  const release = model.hold();
  send({ type: "prompt", text: "from my page", clientId: "b" }, null);
  await until(() => model.calls.length >= 2, "the second turn");
  send({ type: "steer", text: "steered from the laptop", clientId: "c" }, "local", PEER);
  release();
  await settled("steered from the laptop", 3);
  // A program's socket names no one.
  send({ type: "prompt", text: "from a script", clientId: "d" }, "script");
  await settled("from a script", 4);
  // A REST send by this machine's operator is theirs.
  const res = await app.request("/api/sessions/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: s.path, text: "by REST" }) });
  assert.equal(res.status, 200, await res.clone().text());
  await settled("by REST", 5);

  const items = await transcript(s.path);
  const users = items.filter((i) => i.kind === "user");
  const byText = new Map(users.map((u) => [u.text, u.id]));
  const peer = { by: `peer:${PEER.nodeId}`, label: PEER.label };
  assert.deepEqual(
    (await senders(s.path)).messages,
    [
      { entryId: byText.get("from a linked computer"), ...peer },
      { entryId: byText.get("from my page"), by: "operator" },
      { entryId: byText.get("steered from the laptop"), ...peer },
      { entryId: byText.get("by REST"), by: "operator" },
    ],
  );
  const seen = sendersOf(items);
  assert.deepEqual(seen.get(byText.get("from a linked computer")!), { kind: "member", ...peer });
  assert.equal(seen.get(byText.get("from a script")!), undefined);

  // The model reads the words as typed, nothing about who typed them: no marker, no "[From X]" line, no caller.
  assert.deepEqual(userWordsSeen(model), ["from a linked computer", "from my page", "steered from the laptop", "from a script", "by REST"]);
  for (const call of model.calls) {
    const ctx = JSON.stringify(call.context);
    for (const leak of ["sova-member-sent", PEER.nodeId, PEER.label, "[From"]) assert.ok(!ctx.includes(leak), `call ${call.n} carries ${leak}`);
  }
});

test("the read is this host's: a linked computer's request is refused", async () => {
  installed("asking");
  const s = await session();
  const res = await app.request(`/api/sessions/senders?path=${encodeURIComponent(s.path)}`, {}, { meshPeer: { id: "kim", label: PEER.label, nodeId: PEER.nodeId, dnsName: "kim.example" } });
  assert.equal(res.status, 404);
  assert.equal((await app.request("/api/sessions/senders?path=nope")).status, 400);
});
