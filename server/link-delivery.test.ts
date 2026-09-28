// Run: npx tsx --test server/link-delivery.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR and cwd in the OS temp dir; ~/.pi is never read or written, and with no
// credentials in that dir no model is ever called (prompt/steer are stubbed where a turn would run).
//
// §mesh.links/delivery (the receiving runtime) and §mesh.links/transcript: a link message goes
// straight to the agent — never Sova's web queue — and it is the model's, never the user's: its
// own transcript kind, never a title, never tag evidence, never "asks you", never regenerated, and
// Stop never hands it to the composer.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { formatLinkMessage, parseLinkMessage } from "../shared/link-message";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-link-delivery-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-linkdelivery--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats, resolveRegenerate } = await import("./chat-manager");
const { deliverLinkMessage, heldSessionPath } = await import("./link-delivery");
const { canonicalPath } = await import("./paths");
const { normalizeEntry } = await import("./transcript");
const { getSessionSummary, onSessionArchived, archiveSession, cleanupSessions, idOf, isZeroInput, listSessions } = await import("./sessions-index");
const { readTailTurn } = await import("./session-tags");
const { turnQuestions, turnFacts } = await import("./attention-signals");
const { setArchived } = await import("./archived-sessions");
const { addWebSession } = await import("./web-sessions");
const orgs = await import("./orgs");
const poStore = await import("./project-overseer-store");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(agentDir, "org-ws"));
  rmSync(agentDir, { recursive: true, force: true });
});

let seq = 0;
const hex = () => (seq++).toString(16).padStart(16, "0");
/** A real tagged message, by the shared formatter: a made-up tag would prove the opposite. */
const linkText = (text = "Can you run the migration on your side?") =>
  formatLinkMessage({ linkId: `lk_${hex()}`, messageId: `lm_${hex()}`, fromTitle: "API refactor", fromHost: "desk", fromSessionId: "0199-partner", text });

const msg = (id: string, parentId: string | null, role: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  id,
  parentId,
  timestamp: `2026-09-22T00:00:0${id.length % 10}.000Z`,
  message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { provider: "anthropic", model: "claude-opus-5", stopReason: "stop" } : {}), ...extra },
});

let n = 0;
function sessionFile(entries: Array<Record<string, unknown>>, id = `01a0-ld${n}`): string {
  const path = join(sessionsDir, `2026-09-22T00-00-0${n}-000Z_${id}-${n++}.jsonl`);
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-09-22T00:00:00.000Z", cwd }, ...entries];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}
/** u1 → a1: an ordinary finished session. */
const plainSession = () => sessionFile([msg("u1", null, "user", "first ask"), msg("a1", "u1", "assistant", "first answer")], `01a0-ld${n}`);

const until = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ready(), "condition never became true");
};

describe("§mesh.links/transcript: the tag and its classification", () => {
  test("a link message is its own kind, carrying the parsed tag; the text stays whole", () => {
    const text = linkText();
    const [it] = normalizeEntry(msg("l1", null, "user", text));
    assert.equal(it?.kind, "link");
    assert.equal(it?.text, text);
    assert.deepEqual(it?.link, parseLinkMessage(text));
    assert.equal(it?.link?.text, "Can you run the migration on your side?");
  });

  test("a message that merely quotes a tag on a later line stays the user's", () => {
    const [it] = normalizeEntry(msg("u9", null, "user", `look at this:\n${linkText()}`));
    assert.equal(it?.kind, "user");
  });

  test("a tag with made-up (non-hex) ids is not a link message", () => {
    const [it] = normalizeEntry(msg("u8", null, "user", '[link_msg lk_nothexatall12345 lm_0000000000000000] from x (h/s)\nhi\n\nReply with link_send (to: "s").'));
    assert.equal(it?.kind, "user");
  });
});

describe("§mesh.links/transcript: exclusions", () => {
  test("never titles a session: the first message the user wrote does", async () => {
    const path = sessionFile([
      msg("l1", null, "user", linkText("partner words that must not become the title")),
      msg("a1", "l1", "assistant", "on it"),
      msg("u2", "a1", "user", "my own first words"),
      msg("a2", "u2", "assistant", "ok"),
    ]);
    const s = await getSessionSummary(path);
    assert.equal(s?.title, "my own first words");
  });

  test("session tags never read a partner's words as the last user message", async () => {
    const path = sessionFile([msg("u1", null, "user", "own ask"), msg("a1", "u1", "assistant", "done"), msg("l1", "a1", "user", linkText()), msg("a2", "l1", "assistant", "replied to partner")]);
    const { size } = await import("node:fs/promises").then((fs) => fs.stat(path));
    const turn = await readTailTurn(path, size);
    assert.equal(turn?.assistant, "replied to partner");
    assert.equal(turn?.user, null);
    // The control: an ordinary turn still carries its user text, so the null above is the tag's doing.
    const own = sessionFile([msg("u1", null, "user", "own ask"), msg("a1", "u1", "assistant", "done")]);
    const st = await import("node:fs/promises").then((fs) => fs.stat(own));
    assert.equal((await readTailTurn(own, st.size))?.user, "own ask");
  });

  test("attention signals never ask whether any turn asks something; a long link-opened turn is still checked for stuck", () => {
    const facts = (lastUser: string, tools = 0) => ({ turnId: "a", replyAt: 2, lastUser, assistantLast: "Should I merge it?", tools: Array.from({ length: tools }, () => ({ name: "bash", args: "{}", result: "" })), stopReason: "stop", durationMs: 1000 });
    assert.deepEqual(Object.keys(turnQuestions(facts(linkText()))), []);
    assert.deepEqual(Object.keys(turnQuestions(facts(linkText(), 50))), ["stuck"]);
    assert.deepEqual(Object.keys(turnQuestions(facts("please fix the build"))), [], "nor is the user's own: a question to the user is no model's call (§chat.alignment/session-mark)");
    // turnFacts reads the tagged message as the turn's opener, as the classifier needs.
    const branch = [msg("l1", null, "user", linkText()), msg("a1", "l1", "assistant", "Should I merge it?")];
    assert.ok(turnFacts(branch as never)!.lastUser.startsWith("[link_msg "));
  });

  test("Regenerate refuses a reply to a link message, with its own reason", () => {
    const branch = [msg("u1", null, "user", "hello"), msg("a1", "u1", "assistant", "hi"), msg("l1", "a1", "user", linkText()), msg("a2", "l1", "assistant", "done")];
    const r = resolveRegenerate(branch, "a2:0");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "link");
    assert.equal(resolveRegenerate(branch, "a1").ok, true, "the user's own turn still regenerates");
  });
});

describe("§mesh.links/delivery: ChatSession.deliverToAgent", () => {
  async function held() {
    const path = plainSession();
    const chat = await acquireChat(path, true);
    const log: ChatServerMessage[] = [];
    chat.attach({ send: (m) => void log.push(m) });
    return { chat, path, log, session: chat.session as any };
  }

  test("idle: starts a turn with the text verbatim, as an extension's input, never queued", async () => {
    const { chat, session, log } = await held();
    const prompts: Array<{ text: string; opts: any }> = [];
    session.prompt = async (text: string, opts: any) => {
      prompts.push({ text, opts });
      opts?.preflightResult?.(true);
    };
    const text = linkText();
    log.length = 0;
    assert.equal(chat.deliverToAgent(text), "started");
    await until(() => prompts.length === 1);
    assert.equal(prompts[0]!.text, text);
    assert.equal(prompts[0]!.opts.source, "extension");
    assert.equal(prompts[0]!.opts.expandPromptTemplates, false);
    assert.equal(chat.queue.size, 0);
    assert.ok(!log.some((m) => m.type === "queue"), "no queue row was ever broadcast");
  });

  test("busy: goes in through the SDK's own steering, the web queue untouched", async () => {
    const { chat, session, log } = await held();
    Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
    const steers: string[] = [];
    session.steer = async (text: string, _images: unknown, opts: any) => {
      assert.equal(opts?.source, "extension");
      steers.push(text);
    };
    session.prompt = async () => assert.fail("a busy member is steered, never prompted");
    const text = linkText();
    log.length = 0;
    assert.equal(chat.deliverToAgent(text), "delivered");
    await until(() => steers.length === 1);
    assert.equal(steers[0], text);
    assert.equal(chat.queue.size, 0);
    assert.ok(!log.some((m) => m.type === "queue"));
  });

  test("two at once into an idle member: the first starts the turn, the second steers into it", async () => {
    const { chat, session } = await held();
    let streaming = false;
    Object.defineProperty(session, "isStreaming", { get: () => streaming, configurable: true });
    const calls: string[] = [];
    session.prompt = async (text: string, opts: any) => {
      calls.push(`prompt ${text.slice(0, 32)}`);
      opts?.preflightResult?.(true);
      streaming = true;
    };
    session.steer = async (text: string) => void calls.push(`steer ${text.slice(0, 32)}`);
    const a = linkText("first");
    const b = linkText("second");
    assert.equal(chat.deliverToAgent(a), "started");
    assert.equal(chat.deliverToAgent(b), "delivered");
    await until(() => calls.length === 2);
    assert.deepEqual(calls, [`prompt ${a.slice(0, 32)}`, `steer ${b.slice(0, 32)}`]);
  });

  test("a user's send while a link-opened turn is starting queues, never refused by pi", async () => {
    const { chat, session } = await held();
    let streaming = false;
    Object.defineProperty(session, "isStreaming", { get: () => streaming, configurable: true });
    const prompts: string[] = [];
    let settle!: () => void;
    session.prompt = (text: string, opts: any) => {
      prompts.push(text);
      if (prompts.length > 1) return Promise.reject(new Error("Agent is already processing."));
      opts?.preflightResult?.(true);
      return new Promise<void>((r) => (settle = r));
    };
    const link = linkText();
    assert.equal(chat.deliverToAgent(link), "started");
    await until(() => prompts.length === 1);
    assert.equal(chat.turnStarting, true, "the link's turn is starting, not yet streaming");
    assert.equal(chat.acceptPrompt("mine", undefined, "client").queued, true);
    assert.deepEqual(prompts, [link], "the user's text never reached pi in the gap");
    streaming = true;
    session._emit({ type: "agent_start" });
    assert.equal(chat.turnStarting, false);
    streaming = false;
    settle();
  });

  test("a link message while a user's turn is starting waits for its run, then steers into it", async () => {
    const { chat, session } = await held();
    let streaming = false;
    Object.defineProperty(session, "isStreaming", { get: () => streaming, configurable: true });
    const calls: string[] = [];
    let settle!: () => void;
    session.prompt = (text: string) => {
      calls.push(`prompt ${text}`);
      return calls.length > 1 ? Promise.reject(new Error("Agent is already processing.")) : new Promise<void>((r) => (settle = r));
    };
    session.steer = async (text: string) => void calls.push(`steer ${text.slice(0, 10)}`);
    assert.equal(chat.acceptPrompt("mine", undefined, "client").queued, false);
    const link = linkText();
    assert.equal(chat.deliverToAgent(link), "delivered", "a turn is starting: this one joins it");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, ["prompt mine"], "held until the run begins");
    streaming = true;
    session._emit({ type: "agent_start" });
    await until(() => calls.length === 2);
    assert.deepEqual(calls, ["prompt mine", `steer ${link.slice(0, 10)}`]);
    streaming = false;
    settle();
  });

  test("compacting: held, then handed over once the compaction ends", async () => {
    const { chat, session } = await held();
    let compacting = true;
    Object.defineProperty(session, "isCompacting", { get: () => compacting, configurable: true });
    const prompts: string[] = [];
    session.prompt = async (text: string, opts: any) => {
      prompts.push(text);
      opts?.preflightResult?.(true);
    };
    const text = linkText();
    assert.equal(chat.deliverToAgent(text), "delivered");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(prompts, [], "nothing reaches pi while it compacts");
    compacting = false;
    session._emit({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
    await until(() => prompts.length === 1);
    assert.equal(prompts[0], text);
    assert.equal(chat.queue.size, 0);
  });

  test("model off: refused before anything reaches pi (its input handler would swallow it)", async () => {
    const { chat, session } = await held();
    (chat as any).assertModelAllowed = () => {
      throw new Error("anthropic/claude-opus-5 is turned off in Settings → Models.");
    };
    session.prompt = async () => assert.fail("never handed to pi");
    assert.throws(() => chat.deliverToAgent(linkText()), /turned off/);
    const r = await deliverLinkMessage(chat.path, linkText());
    assert.equal(r.state, "refused");
    assert.equal(r.state === "refused" && r.reason, "model-off");
  });

  test("a foreign writer: refused as busy, nothing written", async () => {
    const { chat, session } = await held();
    chat.foreignWrite = "another process appended to it";
    session.prompt = async () => assert.fail("never handed to pi");
    const r = await deliverLinkMessage(chat.path, linkText());
    assert.equal(r.state === "refused" && r.reason, "busy");
  });
});

describe("§mesh.links/delivery: Stop takes back only the user's own messages", () => {
  test("a link steer still waiting is kept from queue_cleared and goes in at the next turn", async () => {
    const path = plainSession();
    const chat = await acquireChat(path, true);
    const log: ChatServerMessage[] = [];
    const client = { send: (m: ChatServerMessage) => void log.push(m) };
    chat.attach(client);
    const session = chat.session as any;
    Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
    session.abort = async () => {};
    // The REAL steer, into the REAL SDK queue: the Stop split must work against what pi hands back.
    const link = linkText();
    assert.equal(chat.deliverToAgent(link), "delivered");
    await until(() => session.getSteeringMessages().includes(link));
    // A steer the user typed, sitting in the SDK beside it (an extension's would be the same).
    await session.steer("my own steer");
    log.length = 0;
    chat.handle(client, { type: "abort" } as never);
    await until(() => log.some((m) => m.type === "queue_cleared"));
    const cleared = log.find((m) => m.type === "queue_cleared") as Extract<ChatServerMessage, { type: "queue_cleared" }>;
    assert.deepEqual(cleared.steering, ["my own steer"], "the user's text comes back; the link message never does");
    assert.equal(session.agent.hasQueuedMessages(), false, "Stop still emptied the SDK");
    // The next turn starts: the kept link message steers into it.
    const steers: string[] = [];
    session.steer = async (text: string) => void steers.push(text);
    session._emit({ type: "agent_start" });
    await until(() => steers.length === 1);
    assert.equal(steers[0], link);
  });

  test("a kept link message already on the branch is not sent twice", async () => {
    const link = linkText();
    const path = sessionFile([msg("u1", null, "user", "hi"), msg("a1", "u1", "assistant", "hello"), msg("l1", "a1", "user", link)]);
    const chat = await acquireChat(path, true);
    const session = chat.session as any;
    (chat as any).linkStopped.push(link);
    Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
    const steers: string[] = [];
    session.steer = async (text: string) => void steers.push(text);
    session._emit({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(steers, []);
  });
});

describe("deliverLinkMessage: the refusals, before any runtime opens", () => {
  test("a TUI-live member", async () => {
    const path = plainSession();
    writeFileSync(join(liveDir, `p${process.ppid}-link.json`), JSON.stringify({ heartbeat: Date.now(), session: { sessionFile: path, pid: process.ppid, mode: "tui", status: "idle" }, presence: { status: "idle" } }));
    try {
      const r = await deliverLinkMessage(path, linkText());
      assert.equal(r.state === "refused" && r.reason, "tui-live");
      assert.equal(heldSessionPath((await getSessionSummary(path))!.id), null, "never opened");
    } finally {
      rmSync(join(liveDir, `p${process.ppid}-link.json`), { force: true });
    }
  });

  test("an archived member, a special session, a missing file", async () => {
    const archived = plainSession();
    setArchived((await getSessionSummary(archived))!.id, true);
    assert.equal(((await deliverLinkMessage(archived, linkText())) as any).reason, "archived");
    // A special runtime (the file's own marker, as openSession reads it): refused, nothing handed over.
    const special = plainSession();
    const chat = await acquireChat(special, true);
    chat.special = "baton";
    (chat.session as any).prompt = async () => assert.fail("never handed to pi");
    assert.equal(((await deliverLinkMessage(special, linkText())) as any).reason, "special");
    assert.equal(((await deliverLinkMessage(join(sessionsDir, "gone.jsonl"), linkText())) as any).reason, "no-session");
  });

  test("an organization's session: one of a project's coding sessions, by its started.json row", async () => {
    const org = await orgs.createOrg({ name: "Link Org", dir: join(agentDir, "org-ws") });
    mkdirSync(join(agentDir, "proj"), { recursive: true });
    const project = orgs.addProject(org.id, { name: "Proj", root: join(agentDir, "proj") });
    const path = plainSession();
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(path, hourAgo, hourAgo);
    const s = (await getSessionSummary(path))!;
    poStore.noteStarted(poStore.projectOverseerPaths(org.id, project.id), s.id, "coding", new Date(), path);
    const org_ = (await getSessionSummary(path))?.org;
    assert.equal(org_?.kind, "coding", "the summary now calls it organizational");
    const r = await deliverLinkMessage(path, linkText());
    assert.equal(r.state === "refused" && r.reason, "special");
    assert.match(r.state === "refused" ? r.message : "", /organization/);
    assert.equal(heldSessionPath(s.id), null, "never opened");
  });

  test("an unloaded member is reopened, and heldSessionPath then knows it", async () => {
    const path = plainSession();
    // Written an hour ago: a file written seconds ago by a process nobody knows is the busy rule.
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(path, hourAgo, hourAgo);
    const id = (await getSessionSummary(path))!.id;
    assert.equal(heldSessionPath(id), null);
    // No credentials here, so the turn itself fails inside the runtime; acceptance is what's tested.
    const r = await deliverLinkMessage(path, linkText());
    assert.equal(r.state, "started");
    assert.equal(heldSessionPath(id), path);
  });
});

describe("onSessionArchived", () => {
  test("archiving a session tells the listeners its id", async () => {
    const path = plainSession();
    const id = (await getSessionSummary(path))!.id;
    addWebSession(id);
    const seen: string[] = [];
    const off = onSessionArchived((sid) => void seen.push(sid));
    try {
      const r = await archiveSession(path, true);
      assert.equal(r.ok, true);
      assert.deepEqual(seen, [id]);
    } finally {
      off();
    }
  });
});

describe("a session whose only user messages are link messages is never an empty husk", () => {
  /** Header, two partner messages and the member's replies: real work, and no title of its own.
      Written an hour ago, so neither the list's nor cleanup's "just written" rule is what keeps it. */
  function linkOnly(): string {
    const path = sessionFile([
      msg("l1", null, "user", linkText("first partner note")),
      msg("a1", "l1", "assistant", "answered the partner"),
      msg("l2", "a1", "user", linkText("second partner note")),
      msg("a2", "l2", "assistant", "answered again"),
    ]);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path, old, old);
    return path;
  }
  /** The control: a header-only file IS a husk, so each test below can tell the two apart. */
  function husk(): string {
    const path = sessionFile([]);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path, old, old);
    return path;
  }

  test("isZeroInput: false for it, true for a header-only file", async () => {
    const l = linkOnly();
    const h = husk();
    assert.equal(await isZeroInput(l, statSync(l).size), false);
    assert.equal(await isZeroInput(h, statSync(h).size), true);
    assert.equal((await getSessionSummary(l))?.title, "Untitled", "still never titled by a partner");
  });

  test("the session list shows it; a husk stays hidden", async () => {
    const l = linkOnly();
    const h = husk();
    const listed = new Set((await listSessions()).map((s) => s.path));
    assert.ok(listed.has(l), "the link-only session is listed on its own host");
    assert.ok(!listed.has(h), "an empty husk is still hidden");
  });

  test("archiving it keeps the file (a husk's archive deletes it)", async () => {
    const l = linkOnly();
    const h = husk();
    for (const p of [l, h]) addWebSession((await getSessionSummary(p))!.id);
    const r = await archiveSession(l, true);
    assert.equal(r.ok, true);
    assert.equal(existsSync(l), true, "the file survives archiving");
    assert.equal(r.ok && r.summary.archived, true);
    const rh = await archiveSession(h, true);
    assert.equal(rh.ok, true);
    assert.equal(existsSync(h), false, "the control: a husk is deleted outright");
  });

  test("husk cleanup never picks it; it picks a husk", async () => {
    const l = linkOnly();
    const h = husk();
    // Cleanup names a file by its filename's id (idOf), which these fixtures don't share with the header.
    const lid = idOf(l);
    const hid = idOf(h);
    const r = await cleanupSessions({ mode: "husks", dryRun: true });
    assert.ok(!r.deletedIds.includes(lid), "the link-only session is not a husk candidate");
    assert.ok(r.deletedIds.includes(hid), "the control husk is");
  });
});
