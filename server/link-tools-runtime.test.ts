// Run: pnpm test -- server/link-tools-runtime.test.ts. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read.
//
// Which sessions get the link tools (§mesh.links/tools), born or joined, in REAL hosted runtimes: the session is created
// through POST /api/sessions, opened by the chat's own open path (openPiSession, the flags it hands pi),
// and runs real pi turns up to the model call, where a scripted model answers. The link extension is this
// repo's own, loaded by path. Its host is an in-process stand-in for globalThis.fetch (no socket): it
// answers the members read the extension makes at each run start and at a compaction. What the model is
// declared is read twice: the tools each model call carried, and the system messages pi wrote. Whether a
// session is in a live link is a stand-in for the server's `sova:link-live` hook.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { compactFixture } from "./harness/pi/testing/compact-fixture-ext";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const REPO = resolve(import.meta.dirname, "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-link-tools-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultProvider: "scripted",
    defaultModel: "scripted",
    retry: { baseDelayMs: 1 },
    // A two-turn session has something to summarize.
    compaction: { keepRecentTokens: 1 },
    extensions: [join(REPO, "pi-config/extensions/link"), join(REPO, "server/harness/pi/testing/compact-fixture-ext.ts")],
  }),
);

const LINK_TOOLS = ["link_members", "link_send", "link_inbox", "link_offer", "link_accept", "link_decline", "link_offers"];
const ORIGIN = "http://127.0.0.1:4899";

/** The session's host as the link extension sees it: its live links (none until a test makes one). */
const host = { links: [] as unknown[], calls: [] as string[] };
const liveLink = (sid: string) => ({
  link: { id: "lk_0123456789abcdef", createdAt: 1, createdBy: "n-self" },
  members: [
    { nodeId: "n-self", sessionId: sid, path: "/x", self: true, hostLabel: "here", reach: "self", state: "working" },
    { nodeId: "n-b", sessionId: "s-b", path: "/b", self: false, hostLabel: "box", reach: "up", state: "idle", title: "Partner" },
  ],
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(ORIGIN)) return realFetch(input, init);
  host.calls.push(url.slice(ORIGIN.length));
  if (/^\/api\/mesh\/links\?session=/.test(url.slice(ORIGIN.length))) return Response.json({ links: host.links });
  return Response.json({ error: "Not found" }, { status: 404 });
}) as typeof fetch;

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
// The server's live-link hook (app.ts installs MeshLinks.inLiveLink there), replaced by the sessions a
// test links: the mesh is off in this process, so the real one says none.
const { LINK_LIVE } = await import("./mesh/links");
const live = new Set<string>();
(globalThis as Record<symbol, unknown>)[LINK_LIVE] = (id: string) => live.has(id);
const { acquireChat, currentLinkOrigin, disposeAllChats, disposeHeldChat, setLinkOrigin } = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { addWebSession } = await import("./web-sessions");
type Chat = Awaited<ReturnType<typeof acquireChat>>;

after(async () => {
  await disposeAllChats();
  globalThis.fetch = realFetch;
});

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function idle(chat: Chat): Promise<void> {
  const quiet = () => !chat.turnStarting && !piSession(chat).isStreaming && !chat.isCompacting() && chat.queue.size === 0 && !piSession(chat).agent.hasQueuedMessages();
  await until(quiet, "idle");
  await piSession(chat).waitForIdle();
  await new Promise((r) => setTimeout(r, 5));
  await until(quiet, "idle");
}

async function create(body: Record<string, unknown>): Promise<string> {
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, ...body }) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { path: string }).path;
}
const models = new Map<string, ScriptedModel>();
async function open(path: string): Promise<Chat> {
  const chat = await acquireChat(path);
  let model = models.get(path);
  if (!model) models.set(path, (model = new ScriptedModel()));
  model.attach(piSession(chat));
  chat.attach({ send: (_m: ChatServerMessage) => {} } as never);
  return chat;
}
let turn = 0;
async function say(chat: Chat, text: string): Promise<void> {
  chat.handle({ send: () => {} } as never, { type: "prompt", text, clientId: `c${++turn}` });
  await idle(chat);
}

type SystemEntry = { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[]; sections?: Record<string, string | null> };
/** The system messages pi wrote, in file order. */
const systemMessages = (path: string): SystemEntry[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message" && e.message?.role === "system")
    .map((e) => e.message as SystemEntry);
const linkNames = (tools: { name: string }[] | undefined) => (tools ?? []).map((t) => t.name).filter((n) => n.startsWith("link_"));
/** Every tool a model call was declared: its system messages replayed in order, as a provider does. */
const toolsOf = (context: unknown): string[] => {
  const tools = new Set<string>();
  for (const m of (context as { messages: (SystemEntry & { role: string })[] }).messages) {
    if (m.role !== "system") continue;
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of m.toolsAdded ?? []) tools.add(t.name);
  }
  return [...tools];
};
/** The link tools each model call so far was declared. */
const declaredPerCall = (path: string) => models.get(path)!.calls.map((c) => linkNames(toolsOf(c.context).map((name) => ({ name }))).sort());
/** The control: the instrument sees a call's other tools, so an empty list above is a real absence. */
const seesOtherTools = (path: string) => models.get(path)!.calls.every((c) => toolsOf(c.context).includes("read"));
/** Every tool change pi recorded after the first system message: [added, removed] link tools. */
const laterLinkChanges = (path: string) =>
  systemMessages(path)
    .slice(1)
    .map((m) => [linkNames(m.toolsAdded), linkNames(m.toolsRemoved)])
    .filter(([a, r]) => a!.length || r!.length);

// ---- without Sova's origin: a TUI, a worker --------------------------------------------------------------

test("without Sova's link flags (a TUI, a worker) no link tool is registered, even for a marked member", async () => {
  assert.equal(currentLinkOrigin(), null, "this test runs before the listener's origin is known");
  const path = await create({ link: true });
  const chat = await open(path);
  assert.deepEqual(piSession(chat).getAllTools().map((t) => t.name).filter((n) => n.startsWith("link_")), [], "nothing registered at all");
  await say(chat, "hello");
  assert.deepEqual(declaredPerCall(path), [[]]);
  assert.ok(seesOtherTools(path));
  assert.deepEqual(host.calls, [], "nothing fetched");
  await disposeHeldChat(path, "test");
});

// ---- hosted by Sova ----------------------------------------------------------------------------------------

test("an ordinary session in no link declares no link tool, from its first request on", async () => {
  setLinkOrigin(ORIGIN);
  const path = await create({});
  const chat = await open(path);
  await say(chat, "one");
  await say(chat, "two");
  assert.deepEqual(declaredPerCall(path), [[], []]);
  assert.ok(seesOtherTools(path), "the control: each request carried its other tools");
  assert.deepEqual(systemMessages(path).flatMap((m) => linkNames(m.toolsAdded)), []);
  assert.deepEqual(host.calls, [], "and never asks the host about links");
  await disposeHeldChat(path, "test");
});

const ALL = [...LINK_TOOLS].sort();
/** Link session `sid` as the server would: live in the hook, listed by the host. */
function linkNow(sid: string) {
  live.add(sid);
  host.links = [liveLink(sid)];
}

let joinedFile = "";
test("an idle ordinary session that is linked declares all seven at its next request, as exactly one tool change", async () => {
  host.links = [];
  host.calls.length = 0;
  const path = await create({});
  joinedFile = path;
  const chat = await open(path);
  await say(chat, "before the link");
  const sid = piSession(chat).sessionManager.getSessionId();
  linkNow(sid);
  await say(chat, "linked now");
  await say(chat, "and again");
  assert.deepEqual(declaredPerCall(path), [[], ALL, ALL]);
  assert.ok(seesOtherTools(path));
  assert.deepEqual(laterLinkChanges(path), [[[...LINK_TOOLS], []]], "one toolsAdded with all seven, nothing else");
  assert.ok(systemMessages(path).some((m) => /lk_0123456789abcdef/.test(m.sections?.["mesh-link"] ?? "")), "the section comes with the run");
  await disposeHeldChat(path, "test");
});

test("a busy session linked in a tool loop declares the seven in the next request of the same run, beside the steered partner message", async () => {
  host.links = [];
  writeFileSync(join(cwd, "note.txt"), "a note\n");
  const path = await create({});
  const chat = await open(path);
  await say(chat, "warm up");
  const sid = piSession(chat).sessionManager.getSessionId();
  const model = models.get(path)!;
  const before = model.calls.length;
  let delivered = "";
  model.reply(() => {
    // Linked while the model works: the partner's message steers into this run.
    linkNow(sid);
    delivered = chat.deliverToAgent("[link_msg lk_0123456789abcdef lm_00000000000000aa] from Partner (box/s-b)\nneed the files");
    return { toolCall: { name: "read", arguments: { path: "note.txt" } } };
  });
  await say(chat, "read the note");
  assert.equal(delivered, "delivered", "busy: steered, not a new turn");
  const run = model.calls.slice(before);
  assert.equal(run.length, 2, "one run: the tool call, then the next step");
  assert.deepEqual(declaredPerCall(path).slice(before), [[], ALL], "the next request of the same run declares them");
  const texts = JSON.stringify((run[1]!.context as { messages: unknown[] }).messages);
  assert.ok(texts.includes("need the files"), "and carries the steered partner message");
  assert.ok(!JSON.stringify((run[0]!.context as { messages: unknown[] }).messages).includes("need the files"));
  assert.equal(laterLinkChanges(path).length, 1, "one tool change");
  await disposeHeldChat(path, "test");
});

test("a session whose runtime isn't loaded when it is linked declares the seven from its first request after it opens", async () => {
  host.links = [];
  const path = await create({});
  let chat = await open(path);
  await say(chat, "one");
  const sid = piSession(chat).sessionManager.getSessionId();
  await disposeHeldChat(path, "test");
  linkNow(sid);
  chat = await open(path);
  assert.deepEqual(piSession(chat).getAllTools().map((t) => t.name).filter((n) => n.startsWith("link_")).sort(), ALL, "registered at its start");
  await say(chat, "two");
  assert.deepEqual(declaredPerCall(path), [[], ALL]);
  assert.equal(laterLinkChanges(path).length, 1);
  await disposeHeldChat(path, "test");
});

test("a joined session keeps the seven past the link's end and through a compaction while linked, and loses them at one in no live link", async () => {
  assert.ok(joinedFile, "runs after the idle join test");
  const path = joinedFile;
  const chat = await open(path);
  const sid = piSession(chat).sessionManager.getSessionId();
  live.add(sid);
  host.links = [liveLink(sid)];
  await say(chat, "reopened while linked");
  // The link ends: nothing changes until a compaction.
  live.delete(sid);
  await say(chat, "the link ended");
  assert.deepEqual(declaredPerCall(path).at(-1), ALL, "kept when the link ends");
  const compactions = () => readFileSync(path, "utf8").split("\n").filter((l) => l.includes('"type":"compaction"')).length;
  compactFixture().summary = "Earlier talk.";
  // The host still lists a live link at this compaction: kept.
  await say(chat, "/compact");
  assert.equal(compactions(), 1);
  await say(chat, "after the first compaction");
  assert.deepEqual(declaredPerCall(path).at(-1), ALL, "a compaction while linked keeps them");
  host.links = [];
  await say(chat, "/compact");
  assert.equal(compactions(), 2);
  const calls = models.get(path)!.calls.length;
  await say(chat, "after the second compaction");
  assert.deepEqual(declaredPerCall(path).slice(calls), [[]], "gone from the request right after it");
  assert.deepEqual(laterLinkChanges(path), [
    [[...LINK_TOOLS], []],
    [[], [...LINK_TOOLS]],
  ], "one toolsAdded at the join, one toolsRemoved after the compaction in no live link");
  await disposeHeldChat(path, "test");
});

let memberFile = "";
test("a link member declares all seven from its first request, and nothing changes them across link, message, unlink and reopen", async () => {
  host.links = [];
  host.calls.length = 0;
  const path = await create({ link: true });
  memberFile = path;
  let chat = await open(path);
  await say(chat, "one");
  const sid = piSession(chat).sessionManager.getSessionId();
  // Linked: the prompt section appears (a section, never a tool change).
  host.links = [liveLink(sid)];
  await say(chat, "two");
  assert.match(systemMessages(path).at(-1)?.sections?.["mesh-link"] ?? "", /lk_0123456789abcdef/);
  // A partner's message starts a turn.
  assert.equal(chat.deliverToAgent("[link_msg lk_0123456789abcdef lm_0123456789abcdef] from Partner (box/s-b)\nping"), "started");
  await until(() => models.get(path)!.calls.length === 3, "the message's turn");
  await idle(chat);
  // Unlinked, then reopened (a server restart).
  host.links = [];
  await say(chat, "three");
  await disposeHeldChat(path, "test");
  chat = await open(path);
  await say(chat, "four");
  const all = [...LINK_TOOLS].sort();
  assert.deepEqual(declaredPerCall(path), [all, all, all, all, all], "every request carried the same seven");
  assert.deepEqual(linkNames(systemMessages(path)[0]!.toolsAdded).sort(), all, "declared in the first system message");
  assert.deepEqual(laterLinkChanges(path), [], "no later toolsAdded or toolsRemoved for any of them");
  await disposeHeldChat(path, "test");
});

/** A session from an earlier build: the member's own file (its declarations are the extension's, byte
    for byte), without the marker no earlier build wrote. */
function legacyCopy(): string {
  const lines = readFileSync(memberFile, "utf8").trim().split("\n");
  const header = JSON.parse(lines[0]!);
  const id = `0199bbbb-0000-7000-8000-${String(++turn).padStart(12, "0")}`;
  const kept = lines.slice(1).map((l) => JSON.parse(l)).filter((e) => !(e.type === "custom" && e.customType === "sova-link-member"));
  // Re-parent the first entry, whose parent was the marker.
  kept[0].parentId = null;
  const path = join(memberFile, "..", `2026-10-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, [{ ...header, id }, ...kept].map((e) => JSON.stringify(e)).join("\n") + "\n");
  markOwned(path);
  addWebSession(id);
  return path;
}

test("a session from before keeps its link tools, unchanged, until a compaction that finds it in no live link", async () => {
  assert.ok(memberFile, "runs after the member test");
  const path = legacyCopy();
  const chat = await open(path);
  const sid = piSession(chat).sessionManager.getSessionId();
  const before = systemMessages(path).length;
  await say(chat, "still there?");
  assert.deepEqual(declaredPerCall(path), [[...LINK_TOOLS].sort()], "kept, as declared");
  assert.deepEqual(laterLinkChanges(path), [], "no change at reopen or at its first request");
  // A compaction while it is in a live link keeps them.
  host.links = [liveLink(sid)];
  compactFixture().summary = "Earlier talk.";
  const compactions = () => readFileSync(path, "utf8").split("\n").filter((l) => l.includes('"type":"compaction"')).length;
  await say(chat, "/compact");
  assert.equal(compactions(), 1, "the first compaction happened");
  await say(chat, "after the first compaction");
  assert.deepEqual(declaredPerCall(path).at(-1), [...LINK_TOOLS].sort(), "linked at the compaction: kept");
  // A compaction in no live link drops them; the request after it is the first without them.
  host.links = [];
  await say(chat, "/compact");
  assert.equal(compactions(), 2, "the second compaction happened");
  const calls = models.get(path)!.calls.length;
  await say(chat, "after the second compaction");
  assert.deepEqual(declaredPerCall(path).slice(calls), [[]], "gone from the request right after that compaction");
  const changes = laterLinkChanges(path);
  assert.equal(changes.length, 1, "exactly one change, after the compaction");
  assert.deepEqual(changes[0], [[], [...LINK_TOOLS]]);
  const entries = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lastCompaction = entries.map((e) => e.type).lastIndexOf("compaction");
  const removal = entries.findIndex((e) => e.type === "message" && e.message?.role === "system" && linkNames(e.message.toolsRemoved).length);
  assert.ok(removal > lastCompaction, "recorded after the compaction, never before it");
  assert.ok(systemMessages(path).length > before);
  // Reopened (a restart): dropped for good.
  await disposeHeldChat(path, "test");
  const again = await open(path);
  assert.deepEqual(piSession(again).getAllTools().map((t) => t.name).filter((n) => n.startsWith("link_")), []);
  await say(again, "after a restart");
  assert.deepEqual(declaredPerCall(path).at(-1), []);
  assert.equal(laterLinkChanges(path).length, 1, "no further change");
  await disposeHeldChat(path, "test");
});

test("the create route: link: true writes the marker first, with the header; anything but a boolean is refused", async () => {
  const path = await create({ link: true });
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "session");
  assert.deepEqual([lines[1].type, lines[1].customType, lines[1].data], ["custom", "sova-link-member", { v: 1 }]);
  assert.equal(lines.filter((e) => e.customType === "sova-link-member").length, 1);
  const plain = await create({ link: false });
  assert.ok(!readFileSync(plain, "utf8").includes("sova-link-member"), "link: false is an ordinary session");
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, link: "yes" }) });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "link must be true or false" });
});
