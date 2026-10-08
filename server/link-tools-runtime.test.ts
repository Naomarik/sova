// Run: pnpm test -- server/link-tools-runtime.test.ts. A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read.
//
// Which sessions get the link tools (§mesh.links/tools), in REAL hosted runtimes: the session is created
// through POST /api/sessions, opened by the chat's own open path (openPiSession, the flags it hands pi),
// and runs real pi turns up to the model call, where a scripted model answers. The link extension is this
// repo's own, loaded by path. Its host is an in-process stand-in for globalThis.fetch (no socket): it
// answers the members read the extension makes at each run start and at a compaction. What the model is
// declared is read twice: the tools each model call carried, and the system messages pi wrote.
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

test("an ordinary session declares no link tool, from its first request on, linked or not", async () => {
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
