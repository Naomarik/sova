// Run: pnpm test -- server/overseer-pair-tools.test.ts. A throwaway PI_CODING_AGENT_DIR (the action
// log and the topic store land there); ~/.pi is never touched.
//
// §app.overseer/pairs, §app.overseer/tools and /approvals: sova_pair over a fake server. Pairing
// sends each chat one introduction through the prompt route (the Overseer's own path), refuses
// what can't be paired before anything changes, and is an act: refused in a run the user did not
// start unless an approval or rule covers both chats.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";
const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-pair-tools-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { overseerTools, TurnLimits, UNATTENDED_REFUSAL, actTargets } = await import("./overseer-tools");
const { DEFAULT_CAPS } = await import("./overseer-store");
const { setTopicStore, topicStore } = await import("./topics");
const { TopicStore, TOPICS_PER_SESSION } = await import("./topic-store");
const { disposeAllChats } = await import("./chat-manager");
after(async () => {
  setTopicStore(null);
  await disposeAllChats();
});
let d = 0;
beforeEach(() => setTopicStore(new TopicStore(join(agentDir, `topics-${++d}`))));

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, path: `/s/${id}.jsonl`, cwd: "/w", title: `Chat ${id}`, createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false, ...extra }) as SessionSummary;
const SESSIONS: Record<string, SessionSummary> = {
  a: summary("a"),
  b: summary("b"),
  c: summary("c"),
  tui: summary("tui", { live: { pid: 9 } as never }),
  arch: summary("arch", { archived: true }),
  ov: summary("ov", { overseer: true }),
  w: summary("w", { workerSession: true }),
  org: summary("org", { org: { id: "o", kind: "coding" } as never }),
};

function harness(opts: { attended?: boolean; permit?: (tool: string, sessions: string[]) => { id: string; label: string } | null; promptStatus?: number } = {}) {
  const prompts: { path: string; text: string; delivery?: string }[] = [];
  const used: { id: string; tool: string; sessions: string[] }[] = [];
  const host = {
    request: async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && path === "/api/sessions/prompt") {
        const body = JSON.parse(String(init?.body));
        if (opts.promptStatus && opts.promptStatus !== 200) return Response.json({ error: "Its model is turned off." }, { status: opts.promptStatus });
        prompts.push(body);
        return Response.json({ queued: false, kind: "prompt" });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    overseerId: () => "ov",
    confirmed: () => null,
    caps: () => ({ ...DEFAULT_CAPS }),
    session: async (ref: string) => SESSIONS[ref] ?? null,
    attended: () => opts.attended ?? true,
    started: () => {},
    runningStarted: () => 0,
    counted: () => false,
    permit: opts.permit,
    used: (id: string, tool: string, sessions: string[]) => used.push({ id, tool, sessions }),
    peer: async () => null,
    peerIds: () => [],
  } as unknown as OverseerToolHost;
  const limits = new TurnLimits();
  const tools = overseerTools(host, limits);
  const run = (params: Record<string, unknown>) =>
    tools
      .find((t) => t.name === "sova_pair")!
      .execute("tc", params, undefined, undefined, undefined as never)
      .then(
        (r) => ({ text: r.content.map((c) => (c as { text: string }).text).join("\n"), details: r.details as any }),
        (e: Error) => ({ text: `ERROR: ${e.message}`, details: null as any }),
      );
  return { run, prompts, used, limits };
}
const PAIR = { op: "pair", a: "a", b: "sova://s/b", job_a: "Builds the API", job_b: "Writes the docs." };

describe("sova_pair pair", () => {
  test("opens the pairing and sends each chat one introduction through the prompt route, never a steer", async () => {
    const h = harness();
    const out = await h.run(PAIR);
    assert.match(out.text, /^Paired "Chat a" and "Chat b" as pr_[0-9a-f]{12}\./);
    const p = topicStore().livePairs()[0]!;
    assert.equal(h.prompts.length, 2);
    assert.deepEqual(h.prompts.map((x) => x.path), ["/s/a.jsonl", "/s/b.jsonl"]);
    assert.ok(h.prompts.every((x) => x.delivery === undefined), "followUp by default: never a steer");
    assert.ok(h.prompts[0]!.text.includes(`queue_push with topic ${p.b.topic}`), "a is told b's topic");
    assert.match(h.prompts[0]!.text, /Writes the docs\./, "a is told b's job");
    assert.match(h.prompts[1]!.text, /Builds the API\./, "b is told a's job, given a stop");
    assert.equal(out.details.op, "pair");
    assert.equal(out.details.pair.a.sessionId, "a");
    assert.equal(h.limits.count("prompt"), 2);
    // Again, either order: the existing pairing, no new introduction.
    const again = await h.run({ ...PAIR, a: "b", b: "a" });
    assert.match(again.text, /already paired as/);
    assert.equal(again.details.existing, true);
    assert.equal(h.prompts.length, 2);
    assert.equal(topicStore().livePairs().length, 1);
  });

  test("refuses what can't be paired, naming it, before anything changes", async () => {
    const h = harness();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ b: "a" }, /same chat, "Chat a"/],
      [{ b: "tui" }, /open in a terminal \(pid 9\)/],
      [{ b: "arch" }, /"Chat arch" \(arch\) is archived/],
      [{ b: "ov" }, /Overseer conversation/],
      [{ b: "w" }, /subagent's own session/],
      [{ b: "org" }, /organization's session/],
      [{ b: "elsewhere" }, /No session with id elsewhere on this host/],
      [{ host: "vps" }, /chat on another host can't be paired/],
      [{ job_b: "  " }, /Say each chat's job/],
    ];
    for (const [extra, re] of cases) assert.match((await h.run({ ...PAIR, ...extra })).text, re, JSON.stringify(extra));
    assert.equal(h.prompts.length, 0);
    assert.equal(topicStore().openTopics().length, 0);
    assert.equal(h.limits.count("prompt"), 0, "a refusal takes nothing");
  });

  test("a chat with no room for a topic refuses the whole pairing, and no topic opens on the other", async () => {
    const h = harness();
    for (let i = 0; i < TOPICS_PER_SESSION; i++) topicStore().open({ sessionId: "b", path: "/s/b.jsonl" }, `t${i}`);
    const out = await h.run(PAIR);
    assert.match(out.text, /^ERROR: "Chat b" \(b\) already has 10 topics open/);
    assert.equal(topicStore().openCount("a"), 0);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.limits.count("prompt"), 0);
  });

  test("an introduction that can't be sent ends the pairing: never a half-made one", async () => {
    const h = harness({ promptStatus: 409 });
    const out = await h.run(PAIR);
    assert.match(out.text, /^ERROR: The introduction to "Chat a" was not sent \(Its model is turned off\.\), so the pairing was ended\. Nothing was sent\./);
    assert.equal(topicStore().livePairs().length, 0);
    assert.equal(topicStore().openTopics().length, 0);
  });
});

describe("sova_pair is an act", () => {
  test("in a run the user did not start, pair, unpair and resume refuse without an approval; list still reads", async () => {
    const h = harness({ attended: false });
    assert.equal((await h.run(PAIR)).text, `ERROR: ${UNATTENDED_REFUSAL}`);
    assert.equal(topicStore().livePairs().length, 0);
    assert.equal(h.prompts.length, 0);
    const p = topicStore().openPair({ sessionId: "a", path: "/s/a.jsonl", job: "a." }, { sessionId: "b", path: "/s/b.jsonl", job: "b." }).pair;
    assert.equal((await h.run({ op: "unpair", pairing: p.id })).text, `ERROR: ${UNATTENDED_REFUSAL}`);
    assert.equal((await h.run({ op: "resume", pairing: p.id })).text, `ERROR: ${UNATTENDED_REFUSAL}`);
    assert.equal(topicStore().pair(p.id)!.endedAt, undefined);
    assert.match((await h.run({ op: "list" })).text, /^1 pairing in force\./);
  });

  test("under an approval that covers both chats it runs and says so; one covering only one chat doesn't", async () => {
    const asked: string[][] = [];
    const permit = (tool: string, sessions: string[]) => {
      asked.push([tool, ...sessions]);
      return sessions.includes("c") ? null : { id: "g_2", label: "any act on 2 sessions until 6:00 PM" };
    };
    const h = harness({ attended: false, permit });
    const out = await h.run(PAIR);
    assert.match(out.text, /Done under g_2 \(any act on 2 sessions until 6:00 PM\)\.$/);
    assert.deepEqual(asked[0], ["sova_pair", "a", "b"]);
    assert.deepEqual(h.used, [{ id: "g_2", tool: "sova_pair", sessions: ["a", "b"] }]);
    assert.equal((await h.run({ ...PAIR, b: "c" })).text, `ERROR: ${UNATTENDED_REFUSAL}`);
    const p = topicStore().livePairs()[0]!;
    assert.deepEqual(actTargets("sova_pair", { op: "unpair", pairing: p.id }), ["a", "b"], "unpair names the pairing's two chats");
    assert.equal(actTargets("sova_pair", { op: "list" }), null);
    assert.match((await h.run({ op: "unpair", pairing: p.id })).text, /^Ended pr_.*Done under g_2/s);
  });
});

describe("sova_pair unpair, resume and list", () => {
  test("unpair ends it; a second unpair, an unknown id or a bad id is refused", async () => {
    const h = harness();
    await h.run(PAIR);
    const p = topicStore().livePairs()[0]!;
    const out = await h.run({ op: "unpair", pairing: p.id });
    assert.match(out.text, /^Ended pr_[0-9a-f]{12}: both topics closed/);
    assert.equal(out.details.op, "unpair");
    assert.match((await h.run({ op: "unpair", pairing: p.id })).text, /^ERROR: Pairing pr_\w+ has already ended\./);
    assert.match((await h.run({ op: "unpair", pairing: "pr_000000000000" })).text, /^ERROR: No pairing pr_000000000000\./);
    assert.match((await h.run({ op: "unpair", pairing: "lk_x" })).text, /^ERROR: Name the pairing by its id/);
    assert.match((await h.run({ op: "list" })).text, /^0 pairings in force\./);
  });
  test("resume lifts one direction or both", async () => {
    const h = harness();
    await h.run(PAIR);
    const p = topicStore().livePairs()[0]!;
    for (let i = 0; i < 40; i++) {
      topicStore().countPairNote(p.id, "toA");
      topicStore().countPairNote(p.id, "toB");
    }
    assert.match((await h.run({ op: "list", session: "a" })).text, /40\/40 notes in, PAUSED.*40\/40 notes in, PAUSED/);
    assert.match((await h.run({ op: "resume", pairing: p.id, direction: "a_to_b" })).text, /^Resumed pr_\w+ \(a → b\)/);
    assert.equal(topicStore().pair(p.id)!.notes.toB, 0);
    assert.equal(topicStore().pair(p.id)!.notes.toA, 40);
    await h.run({ op: "resume", pairing: p.id });
    assert.equal(topicStore().pair(p.id)!.notes.toA, 0);
  });
});
