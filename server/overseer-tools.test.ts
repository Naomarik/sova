// Run: npx tsx --test server/overseer-tools.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { SessionSummary, TranscriptItem } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";

const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-tools-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { concurrencyRefusal, overseerTools, renderTranscript, TurnLimits, BUILTIN_ALLOWED } = await import("./overseer-tools");
const { buildOverseerTools, countRunning, renderOverseerPrompt, briefDecision, BRIEF_MIN_GAP_MS } = await import("./overseer");
const { DEFAULT_CAPS, readOverseerSettings } = await import("./overseer-store");
const { disposeAllChats } = await import("./chat-manager");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

describe("per-turn caps", () => {
  test("each kind is capped on its own, and a refusal consumes nothing", () => {
    const caps = { ...DEFAULT_CAPS, createPerTurn: 2, promptsPerTurn: 1 };
    const l = new TurnLimits();
    assert.equal(l.take("create", caps), null);
    assert.equal(l.take("create", caps), null);
    const refused = l.take("create", caps);
    assert.match(refused ?? "", /at most 2 new sessions per message from the user/);
    assert.match(refused ?? "", /sova_confirm/);
    assert.equal(l.count("create"), 2);
    assert.equal(l.take("prompt", caps), null); // another kind is untouched
    assert.notEqual(l.take("prompt", caps), null);
  });

  test("a batch of archives is refused whole when it would cross the cap", () => {
    const l = new TurnLimits();
    const caps = { ...DEFAULT_CAPS, archivesPerTurn: 50 };
    assert.equal(l.take("archive", caps, 45), null);
    assert.notEqual(l.take("archive", caps, 6), null);
    assert.equal(l.count("archive"), 45);
    assert.equal(l.take("archive", caps, 5), null);
  });

  test("reset starts a new turn", () => {
    const l = new TurnLimits();
    const caps = { ...DEFAULT_CAPS, createPerTurn: 1 };
    l.take("create", caps);
    l.reset();
    assert.equal(l.take("create", caps), null);
  });

  test("the concurrency cap refuses at the limit, not before", () => {
    assert.equal(concurrencyRefusal(4, DEFAULT_CAPS), null);
    assert.match(concurrencyRefusal(5, DEFAULT_CAPS) ?? "", /5 sessions you started are running/);
  });
});

describe("the prompt and the tool set stay in step", () => {
  test("every sova_* tool the prompt names is registered, and every registered tool is in the prompt", () => {
    const tools = buildOverseerTools();
    const registered = new Set(tools.map((t) => t.name));
    const prompt = renderOverseerPrompt(tools, readOverseerSettings());
    const mentioned = new Set([...prompt.matchAll(/`(sova_[a-z_]+)`/g)].map((m) => m[1]!));
    assert.deepEqual([...mentioned].sort(), [...registered].sort());
    assert.ok(!/\{\{[A-Z]+\}\}/.test(prompt), "every placeholder is filled");
  });

  test("the prompt names every entry of the secret list its read/grep/find/ls enforce", async () => {
    const { secretRules } = await import("./overseer-deny");
    const prompt = renderOverseerPrompt(buildOverseerTools(), readOverseerSettings());
    const r = secretRules("/H", "/A");
    const names = [...r.namesUnder.names, ...r.files, ...r.dirs].map((p) => p.split("/").pop()!);
    for (const n of new Set([...names, ...r.names.map((x) => x.name)])) assert.ok(prompt.includes(`\`${n}\``) || prompt.includes(`/${n}\``), n);
    assert.match(prompt, /\[redacted\]/, "the redaction rule");
  });

  test("the allowlist is the sova_* tools plus read-only built-ins and wake_nudge: no bash, edit, write or subagents", () => {
    const names = [...buildOverseerTools().map((t) => t.name), ...BUILTIN_ALLOWED];
    assert.ok(names.every((n) => n.startsWith("sova_") || ["read", "grep", "find", "ls", "wake_nudge"].includes(n)));
    for (const banned of ["bash", "edit", "write", "agent_spawn", "team_create"]) assert.ok(!names.includes(banned));
  });

  test("sova_confirm returns at once and ends the batch; its details are the card", async () => {
    const confirm = buildOverseerTools().find((t) => t.name === "sova_confirm")!;
    const out = await confirm.execute("c1", { title: "Archive 12 sessions?", options: [{ label: "Archive", tone: "danger" }, { label: "Cancel", reply: "no" }] }, undefined, undefined, {} as never);
    assert.equal(out.terminate, true);
    assert.deepEqual(out.details, { title: "Archive 12 sessions?", options: [{ label: "Archive", tone: "danger" }, { label: "Cancel", reply: "no" }] });
  });

  test("sova_navigate validates settings targets and returns the href", async () => {
    const nav = buildOverseerTools().find((t) => t.name === "sova_navigate")!;
    const out = await nav.execute("n1", { page: "settings", settings_tab: "overseer" }, undefined, undefined, {} as never);
    assert.deepEqual(out.details, { href: "settings:overseer", label: "Open Settings → Overseer" });
    await assert.rejects(nav.execute("n2", { page: "settings", settings_tab: "nope" }, undefined, undefined, {} as never));
    await assert.rejects(nav.execute("n3", {}, undefined, undefined, {} as never), /Give a session, a group, or a page/);
  });
});

describe("bounded, untrusted transcript reads", () => {
  const items: TranscriptItem[] = [];
  for (let i = 0; i < 30; i++) {
    items.push({ id: `u${i}`, kind: "user", text: `ask ${i}`, raw: {} });
    items.push({ id: `a${i}`, kind: "assistant-text", text: `answer ${i} ${"z".repeat(2000)}`, raw: {} });
    items.push({ id: `t${i}`, kind: "thinking", text: "secret thoughts", raw: {} });
  }

  test("wrapped as data, thinking dropped, each row ≤1000 chars, total within the budget", () => {
    const out = renderTranscript(items, { from: "tail", items: 40, chars: 5000, title: "T", id: "x" });
    assert.match(out, /^<<untrusted content from another session: "T" \(x\)/);
    assert.match(out, /<<end of untrusted content>>$/);
    assert.ok(!out.includes("secret thoughts"));
    assert.ok(out.length < 5000 + 400);
    assert.ok(out.includes("answer 29"), "a tail read keeps the newest rows");
    for (const line of out.split("\n")) assert.ok(line.length <= 1000, `row of ${line.length}`);
  });

  test("from start keeps the oldest rows; last_user starts at the last user message", () => {
    assert.ok(renderTranscript(items, { from: "start", items: 2, chars: 12000, title: "T", id: "x" }).includes("USER: ask 0"));
    const last = renderTranscript(items, { from: "last_user", items: 40, chars: 12000, title: "T", id: "x" });
    assert.ok(last.includes("USER: ask 29") && !last.includes("ask 28"));
  });
});

describe("Brief me", () => {
  const base = { proactivity: "brief" as const, now: 10 * BRIEF_MIN_GAP_MS, lastBriefAt: 0, unattended: 0, overseerIdle: true };

  test("the first look is a baseline: what is already blocked is not news", () => {
    const d = briefDecision({ ...base, current: ["a:error"], announced: null });
    assert.deepEqual(d.brief, []);
    assert.deepEqual([...d.announced], ["a:error"]);
  });

  test("a new blocker briefs once; a cleared one that recurs is new again", () => {
    let d = briefDecision({ ...base, current: ["a:error", "b:needs-input"], announced: new Set(["a:error"]) });
    assert.deepEqual(d.brief, ["b:needs-input"]);
    d = briefDecision({ ...base, current: ["a:error", "b:needs-input"], announced: d.announced });
    assert.deepEqual(d.brief, []);
    d = briefDecision({ ...base, current: [], announced: d.announced });
    d = briefDecision({ ...base, current: ["b:needs-input"], announced: d.announced });
    assert.deepEqual(d.brief, ["b:needs-input"]);
  });

  test("held back while the Overseer is busy, within 10 minutes of the last brief, after 30 unattended, or when not in brief mode", () => {
    const announced = new Set<string>();
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced, overseerIdle: false }).brief, []);
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced, lastBriefAt: base.now - 60_000 }).brief, []);
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced, unattended: 30 }).brief, []);
    // Held back is not forgotten: it briefs when the gate opens.
    const held = briefDecision({ ...base, current: ["n"], announced, overseerIdle: false });
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced: held.announced }).brief, ["n"]);
    // Badge-only mode keeps the baseline current, so switching to brief later does not dump old blockers.
    const badge = briefDecision({ ...base, proactivity: "badge", current: ["old"], announced });
    assert.deepEqual(briefDecision({ ...base, current: ["old"], announced: badge.announced }).brief, []);
  });
});

describe("sova_send into running sessions", () => {
  /** sova_send over a fake server: sessions `a`, `b`, `c`; `running` says which are mid-turn, and
      the route answers `reply`. The host's counting is overseer.ts's own countRunning. */
  function harness(concurrentSessions: number, reply: Record<string, unknown> = { ok: true, queued: true, kind: "followUp" }) {
    const running = new Set<string>();
    const started = new Set<string>();
    const promptedAt = new Map<string, number>();
    const sent: Record<string, unknown>[] = [];
    const summary = (id: string) => ({ id, path: `/s/${id}.jsonl`, title: `Session ${id}` }) as SessionSummary;
    const isRunning = (p: string) => running.has(p);
    const host = {
      request: async (_path: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json(reply);
      },
      overseerId: () => "ov",
      caps: () => ({ ...DEFAULT_CAPS, concurrentSessions }),
      session: async (ref: string) => (["a", "b", "c"].includes(ref) ? summary(ref) : null),
      started: (p: string, prompted?: boolean) => {
        started.add(p);
        if (prompted) promptedAt.set(p, Date.now());
      },
      runningStarted: () => countRunning(started, isRunning, promptedAt),
      counted: (p: string) => countRunning(started.has(p) ? [p] : [], isRunning, promptedAt) > 0,
      attended: () => true,
    } as unknown as OverseerToolHost;
    const send = overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_send")!;
    const call = (params: Record<string, unknown>) =>
      send.execute("tc", params, undefined, undefined, undefined as never).then(
        (r) => (r.content[0] as { text: string }).text,
        (e: Error) => `ERROR: ${e.message}`,
      );
    return { call, sent, running, started, promptedAt };
  }

  test("a running session is not refused: the message goes to the route with its delivery, and the result says it was queued", async () => {
    const h = harness(5);
    h.running.add("/s/a.jsonl");
    assert.match(await h.call({ session: "a", text: "then run the tests" }), /^Queued in \[Session a\]\(sova:\/\/s\/a\) behind its running turn, as a follow-up/);
    assert.deepEqual(h.sent, [{ path: "/s/a.jsonl", text: "then run the tests" }]);
  });

  test("delivery steer is passed through and reported as a steer; a started turn is reported as sent", async () => {
    const steer = harness(5, { ok: true, queued: true, kind: "steer" });
    assert.match(await steer.call({ session: "a", text: "stop", delivery: "steer" }), /^Queued as a steer in \[Session a\]/);
    assert.deepEqual(steer.sent, [{ path: "/s/a.jsonl", text: "stop", delivery: "steer" }]);
    const idle = harness(5, { ok: true, queued: false, kind: "prompt" });
    assert.equal(await idle.call({ session: "b", text: "go" }), "Sent to [Session b](sova://s/b).");
    assert.match(await idle.call({ session: "b", text: "go", delivery: "now" }), /^ERROR: delivery is "followUp" or "steer"/);
  });

  test("a session counts once: a send into one you started that is running takes no new slot", async () => {
    const h = harness(1);
    h.started.add("/s/a.jsonl");
    h.running.add("/s/a.jsonl");
    assert.match(await h.call({ session: "a", text: "one more thing" }), /^Queued/, "a is already the one running slot");
    assert.match(await h.call({ session: "a", text: "and another" }), /^Queued/);
    assert.equal(h.sent.length, 2);
  });

  test("a send into a running session you did not start makes it count, so it needs a free slot", async () => {
    const h = harness(1);
    h.started.add("/s/a.jsonl");
    h.running.add("/s/a.jsonl");
    h.running.add("/s/b.jsonl");
    assert.match(await h.call({ session: "b", text: "hello" }), /^ERROR: Limit reached: 1 session you started is running/);
    assert.equal(h.sent.length, 0, "nothing sent past the cap");
    // With room for it, it goes, and from then on b counts too.
    const roomy = harness(2);
    roomy.started.add("/s/a.jsonl");
    roomy.running.add("/s/a.jsonl");
    roomy.running.add("/s/b.jsonl");
    assert.match(await roomy.call({ session: "b", text: "hello" }), /^Queued/);
    assert.match(await roomy.call({ session: "c", text: "hi" }), /^ERROR: Limit reached: 2 sessions you started are running/);
  });

  test("a session you started that has since finished takes a slot again", async () => {
    const h = harness(1);
    h.started.add("/s/a.jsonl");
    h.started.add("/s/b.jsonl");
    h.running.add("/s/b.jsonl");
    assert.match(await h.call({ session: "a", text: "next step" }), /^ERROR: Limit reached/, "a is idle: a send would start it, beside b");
  });
});
