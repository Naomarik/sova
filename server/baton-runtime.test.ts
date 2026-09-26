// Run: pnpm exec tsx --test server/baton-runtime.test.ts. A throwaway PI_CODING_AGENT_DIR (with this
// tree's pi-config extensions linked in, so "no pi-config extension loads" is a real claim) and a
// workspace in the OS temp dir; ~/.pi is never read or written. No model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_DECISION_ENTRY, BATON_DONE_ENTRY, BATON_HANDOFF_ENTRY, BATON_SENT_ENTRY } from "../shared/baton";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-rt-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const { BATON_TOOLS, LOADOUT_TOOLS } = await import("./baton-loadout");
const { acquireChat, disposeAllChats, ModeRefusedError } = await import("./chat-manager");
const { normalizeEntry } = await import("./transcript");
const { canonicalPath } = await import("./paths");
const { sessionItems } = await import("./attention");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

describe("a baton session's runtime", async () => {
  const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const tony = orgs.addPerson(org.id, { name: "Tony", role: "IT", voice: "Direct and technical, short lists." });
  const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Hosting", goal: "Find the server" });

  test("opens as a baton session: exactly its tools, the wrap-up's inactive, only Sova's inline extension", async () => {
    const chat = await acquireChat(c.path);
    assert.equal(chat.special, "baton");
    assert.equal(chat.overseer, false);
    assert.deepEqual([...chat.session.getActiveToolNames()].sort(), ["goal_done", "hand_to", "propose_roster_edit", "record_decision"]);
    assert.deepEqual([...BATON_TOOLS].sort(), ["goal_done", "hand_to", "propose_roster_edit", "record_decision"]);
    assert.deepEqual(chat.session.getAllTools().map((t) => t.name).sort(), [...LOADOUT_TOOLS].sort(), "no built-in, no extension tool");
    assert.ok(!chat.session.getActiveToolNames().includes("write_profile_updates"), "the wrap-up tool is never active in the conversation");
    const loaded = chat.runtime.services.resourceLoader.getExtensions().extensions.map((e) => e.path);
    assert.deepEqual(loaded, ["<inline:sova-baton>"], "no pi-config extension loads");
  });

  test("control: an ordinary session in the same agent dir does load the pi-config extensions", async () => {
    const cwd = join(root, "proj");
    const dir = join(agentDir, "sessions", "--ordinary--");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "2026-09-26T00-00-00-000Z_01a0dd00-0000-7000-8000-000000000001.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "01a0dd00-0000-7000-8000-000000000001", timestamp: "2026-09-26T00:00:00.000Z", cwd })}\n`);
    const chat = await acquireChat(canonicalPath(file), true);
    assert.equal(chat.special, null);
    const loaded = chat.runtime.services.resourceLoader.getExtensions().extensions.map((e) => e.path);
    assert.ok(loaded.some((p) => p.includes("vision-delegate")), `pi-config extensions load for an ordinary session (got ${loaded.length})`);
  });

  test("the operator's composer writes only while holding the baton; no mode, no rewind", async () => {
    const chat = await acquireChat(c.path);
    assert.throws(() => chat.specialEntry!.clientSend!(c.path), /Tony holds the baton/);
    await assert.rejects(() => chat.switchMode({ mode: "delegate" } as never), ModeRefusedError);
    assert.match(chat.specialEntry!.refuses!("rewind") ?? "", /can't be rewound/);
  });

  test("/ws/chat: a composer send while someone else holds the baton is a refusal (code refused), not an internal error", async () => {
    const chat = await acquireChat(c.path);
    const got: { type: string; code?: string; message?: string; clientId?: string }[] = [];
    chat.handle({ send: (m: never) => got.push(m) } as never, { type: "prompt", text: "hello", clientId: "c1" } as never);
    await new Promise((r) => setTimeout(r, 20));
    const err = got.find((m) => m.type === "error");
    assert.equal(err?.code, "refused");
    assert.match(err?.message ?? "", /Tony holds the baton/);
    assert.equal(err?.clientId, "c1", "the composer gets its draft back");
  });
});

describe("transcript rows and the digest", () => {
  test("baton markers normalize to batonMark rows; the sent one renders nothing itself", () => {
    const row = (customType: string, data: unknown) => normalizeEntry({ type: "custom", id: "e1", customType, data })[0];
    assert.deepEqual(row(BATON_SENT_ENTRY, { v: 1, targetId: "u1", by: "p_t" })?.batonMark, { kind: "sent", targetId: "u1", by: "p_t" });
    assert.equal(row(BATON_SENT_ENTRY, { v: 1, targetId: "u1", by: "p_t" })?.text, undefined);
    assert.deepEqual(row(BATON_HANDOFF_ENTRY, { v: 1, n: 2, from: "p_t", to: "operator", question: "q", briefing: "b" })?.batonMark, {
      kind: "handoff",
      n: 2,
      from: "p_t",
      to: "operator",
      question: "q",
      briefing: "b",
    });
    assert.equal(row(BATON_DECISION_ENTRY, { v: 1, area: "a", statement: "s", quote: "q", by: "p_t" })?.batonMark?.kind, "decision");
    assert.equal(row(BATON_DONE_ENTRY, { v: 1, summary: "x" })?.batonMark?.kind, "done");
    assert.deepEqual(normalizeEntry({ type: "custom", id: "e2", customType: BATON_HANDOFF_ENTRY, data: null }), []);
  });

  test("Needs you: the baton with the operator, or a person without a link — act tier", () => {
    const s = (baton: SessionSummary["baton"]): SessionSummary =>
      ({ id: "s", path: "/p.jsonl", cwd: "/w", title: "T", createdAt: "", lastActiveAt: "2026-09-26T00:00:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false, baton }) as SessionSummary;
    const items = (b: SessionSummary["baton"]) => sessionItems({ summary: s(b), dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0 }, Date.now());
    assert.deepEqual(
      items({ holder: "Omar", state: "needs-you", needsYou: { from: "Maria", question: "Bonuses?", since: 5 } }).map((i) => [i.tier, i.kind, i.detail, i.since]),
      [["act", "baton-needs-you", "Maria → you: Bonuses?", 5]],
    );
    assert.deepEqual(
      items({ holder: "Tony", state: "open", sendLink: { to: "Tony", question: "Where?", since: 7 } }).map((i) => [i.tier, i.kind, i.detail]),
      [["act", "baton-needs-you", "Send Tony their link: Where?"]],
    );
    assert.deepEqual(items({ holder: "Tony", state: "open" }).filter((i) => i.kind === "baton-needs-you"), []);
  });
});
