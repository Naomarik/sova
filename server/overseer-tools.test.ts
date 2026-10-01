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
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
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
    assert.match(refused ?? "", /sova_card/);
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
    assert.equal(DEFAULT_CAPS.concurrentSessions, 10, "the default was raised from 5 (§app.overseer/caps)");
    assert.equal(concurrencyRefusal(9, DEFAULT_CAPS), null);
    assert.match(concurrencyRefusal(10, DEFAULT_CAPS) ?? "", /10 sessions you started are running.*the limit is 10 at once \(Settings → Overseer → Limits\)/);
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

  test("sova_card never ends the turn; its details are the card, and a later call sees it", async () => {
    const card = buildOverseerTools().find((t) => t.name === "sova_card")!;
    const branch: unknown[] = [];
    const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "sess-1" } };
    const out = await card.execute("k1", { ops: [{ op: "create", title: "Archive 12 sessions?", options: [{ label: "Archive", tone: "danger" }, { label: "Cancel", reply: "no" }] }] }, undefined, undefined, ctx as never);
    assert.equal(out.terminate, undefined);
    assert.equal(out.details.card.id, "c_1");
    assert.deepEqual(out.details.card.options, [{ label: "Archive", tone: "danger" }, { label: "Cancel", reply: "no" }]);
    assert.match((out.content[0] as { text: string }).text, /^c_1 "Archive 12 sessions\?" · open · v1 · created/);
    // The same batch: the branch doesn't hold the first result yet, and the second call still sees c_1.
    const answered = await card.execute("k2", { card: "c_1", ops: [{ op: "answer", text: "c_1 b: no", option: "b" }] }, undefined, undefined, ctx as never);
    assert.equal(answered.details.card.phase, "answered");
    // Once the branch holds both, the pending copies are dropped and the branch is the state.
    branch.push(
      { type: "message", message: { role: "toolResult", toolName: "sova_card", toolCallId: "k1", details: out.details } },
      { type: "message", message: { role: "toolResult", toolName: "sova_card", toolCallId: "k2", details: answered.details } },
    );
    const next = await card.execute("k3", { ops: [{ op: "create", title: "Next?", options: [{ label: "Go" }] }] }, undefined, undefined, ctx as never);
    assert.equal(next.details.card.id, "c_2");
    await assert.rejects(card.execute("k4", { card: "c_1", ops: [{ op: "drop", reason: "x" }] }, undefined, undefined, ctx as never), /c_1 is already answered\. Nothing was changed\./);
  });

  test("sova_card resolves its items against the ideas and todos on disk, and refuses an unknown session id", async () => {
    const { addIdea } = await import("./overseer-ideas");
    const { addTodo } = await import("./overseer-todos");
    addIdea({ id: "§sova/confirm-rows", title: "Cards list their subject" });
    const todo = addTodo({ text: "Tick the done ones" });
    const card = buildOverseerTools().find((t) => t.name === "sova_card")!;
    const out = await card.execute("c2", { ops: [{ op: "create", title: "Tick?", options: [{ label: "Tick" }], items: { ideas: ["sova/confirm-rows"], todos: [todo.id] } }] }, undefined, undefined, {} as never);
    assert.deepEqual(out.details.card.items, [
      { kind: "idea", id: "§sova/confirm-rows", title: "Cards list their subject", n: 1 },
      { kind: "todo", id: todo.id, text: "Tick the done ones", n: 2 },
    ]);
    assert.match((out.content[0] as { text: string }).text, /1\. §sova\/confirm-rows — Cards list their subject/);
    await assert.rejects(
      card.execute("c3", { ops: [{ op: "create", title: "Archive?", options: [{ label: "Archive" }], items: { sessions: ["sova://s/nope-1"], todos: [todo.id, "td_missing0"] } }] }, undefined, undefined, {} as never),
      /No card was shown\. These ids match nothing \(sessions: sova:\/\/s\/nope-1; todos: td_missing0\)/,
    );
  });

  test("sova_card: per-row choices with no answer option, a long note cut and named in the echo, and card on a create read as replaces", async () => {
    const { addTodo } = await import("./overseer-todos");
    const a = addTodo({ text: "Clean the worktree" });
    const b = addTodo({ text: "Just file it" });
    const card = buildOverseerTools().find((t) => t.name === "sova_card")!;
    const branch: unknown[] = [];
    const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "sess-rows" } };
    const long = `${"Long note. ".repeat(25)}End.`;
    const out = await card.execute(
      "r1",
      {
        ops: [
          {
            op: "create",
            title: "Tidy?",
            choices: ["Do It", "Skip"],
            items: { todos: [{ id: a.id, note: long, default: "a", choices: ["Clean Up & Tick", "Tick Only", "Skip"] }, { id: b.id, note: "Short.", default: "b" }] },
          },
        ],
      },
      undefined,
      undefined,
      ctx as never,
    );
    const c = out.details.card;
    assert.deepEqual(c.options, [], "no fake Apply option");
    assert.deepEqual(c.items.map((it: { choices?: { label: string }[] }) => it.choices?.length), [3, undefined]);
    assert.equal(c.items[0].note.length, 220);
    const text = (out.content[0] as { text: string }).text;
    assert.match(text, new RegExp(`Notes over 220 characters were cut with "…" \\(item, length\\): ${a.id} \\(${long.length}\\)`));
    assert.match(text, /\[choices a\. Clean Up & Tick · b\. Tick Only · c\. Skip\] \[default a\]/);
    const again = await card.execute("r2", { card: c.id, ops: [{ op: "create", title: "Tidy fewer?", options: [{ label: "Go" }] }] }, undefined, undefined, ctx as never);
    assert.equal(again.details.card.replaces, c.id);
    assert.equal(again.details.closed.phase, "superseded");
  });

  test("sova_card link options resolve like sova_navigate, plus https; anything else refuses the card", async () => {
    const card = buildOverseerTools().find((t) => t.name === "sova_card")!;
    const out = await card.execute(
      "l1",
      { ops: [{ op: "create", title: "Where next?", options: [{ label: "Done" }, { label: "Usage", link: { page: "usage" } }, { label: "PR", link: { url: "https://github.com/x/y/pull/1" } }, { label: "Settings", link: { page: "settings", settings_tab: "overseer" } }] }] },
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(out.details.card.options.map((o: { href?: string }) => o.href), [undefined, "#/usage", "https://github.com/x/y/pull/1", "settings:overseer"]);
    await assert.rejects(
      card.execute("l2", { ops: [{ op: "create", title: "?", options: [{ label: "Go" }, { label: "Bad", link: { url: "http://x.test" } }, { label: "Creds", link: { url: "https://u:p@x.test" } }] }] }, undefined, undefined, {} as never),
      /No card was shown\. options\[1\]\.link: url must be an https URL without credentials\. options\[2\]\.link: url must be/,
    );
  });

  test("sova_navigate validates settings targets and returns the href", async () => {
    const nav = buildOverseerTools().find((t) => t.name === "sova_navigate")!;
    const out = await nav.execute("n1", { page: "settings", settings_tab: "overseer" }, undefined, undefined, {} as never);
    assert.deepEqual(out.details, { href: "settings:overseer", label: "Open Settings → Overseer" });
    await assert.rejects(nav.execute("n2", { page: "settings", settings_tab: "nope" }, undefined, undefined, {} as never));
    await assert.rejects(nav.execute("n3", {}, undefined, undefined, {} as never), /Give a session, a group, a page, an org, or a url/);
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
      confirmed: () => null, // no confirm card opened this turn
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

describe("sova_session's Topics line", () => {
  test("lists topics newest first by last update, each with its age; a tie keeps the later topic first", async () => {
    const { topicsLine } = await import("./overseer-tools");
    const now = Date.parse("2026-09-27T12:00:00Z");
    const line = topicsLine(
      [
        { heading: "Sandbox menu", at: now - 2 * 3_600_000 },
        { heading: "Merge", at: now - 60_000 },
        { heading: "Model names", at: now - 60_000 },
        { heading: "Invented by the overlay", at: 0 },
      ],
      now,
    );
    assert.equal(line, "Topics (newest first): Model names (1m ago); Merge (1m ago); Sandbox menu (2h ago); Invented by the overlay");
  });

  test("topics one summarizer run updated each show their own section's age, not the run's", async () => {
    const { topicsLine } = await import("./overseer-tools");
    const now = Date.parse("2026-09-27T12:41:35Z");
    const run = now;
    const line = topicsLine(
      [
        { heading: "Rerun", at: run, sectionAt: now - 3 * 60_000 },
        { heading: "Restart", at: run, sectionAt: now - 60_000 },
        { heading: "Cleanup", at: now - 60 * 60_000 },
      ],
      now,
    );
    assert.equal(line, "Topics (newest first): Restart (1m ago); Rerun (3m ago); Cleanup (1h ago)");
  });
});

describe("card items", async () => {
  const { resolveConfirmItems, CONFIRM_ITEMS_MAX } = await import("./overseer-confirm");
  const { cardLines, displayOrder } = await import("../shared/overseer-card");
  /** The card echo's item lines, as the model reads them (items numbered in display order). */
  const echo = (items: Awaited<ReturnType<typeof resolveConfirmItems>>) =>
    cardLines({ id: "c_1", title: "t", options: [{ label: "Go" }], items: displayOrder(items).map(({ choices: _own, ...it }, i) => ({ ...it, n: i + 1 })), phase: "open", rev: 1, createdAt: now, updatedAt: now }, "").join("\n");
  const { CONFIRM_NOTE_MAX } = await import("../shared/protocol");
  const now = "2026-09-20T10:00:00.000Z";
  const sessions: Record<string, SessionSummary> = {
    s1: { id: "s1", title: "Fix [the] parser", cwd: "/home/u/code/sova", lastActiveAt: now, outlineGist: "Parser  fixed,\n tests green", workers: { working: 2, total: 3 } } as SessionSummary,
    s2: { id: "s2", title: "Remote job", cwd: "/placeholder", remoteCwd: "/srv/app", lastActiveAt: now } as SessionSummary,
    me: { id: "me", title: "Overseer", cwd: "/state/overseer", lastActiveAt: now, overseer: true } as SessionSummary,
  };
  const lookup = {
    // Stands in for the tools' resolve(): the id from any printed form.
    session: async (ref: string) => sessions[ref.replace(/^\[[^\]]*\]\((.*)\)$/, "$1").replace(/^sova:\/\/s\//, "").replace(/^s\//, "")] ?? null,
    idea: (ref: string) => (ref.replace(/^§/, "") === "sova/x" ? { id: "§sova/x", title: "X" } : null),
    todo: (ref: string) => (ref === "td_aaaaaaaa" ? { id: ref, text: "Do it" } : null),
    isSelf: (s: SessionSummary) => s.id === "me",
  };
  const refusal = (m: string) => new Error(m);

  test("sessions resolve from every printed form, once each, as snapshot rows", async () => {
    const items = await resolveConfirmItems({ sessions: ["s1", "sova://s/s1", "[Remote job](sova://s/s2)", " s/s2 "] }, lookup, refusal);
    assert.deepEqual(items, [
      { kind: "session", id: "s1", title: "Fix [the] parser", project: "sova", lastActiveAt: now, summary: "Parser fixed, tests green", workers: 2 },
      { kind: "session", id: "s2", title: "Remote job", project: "app", lastActiveAt: now },
    ]);
  });

  test("unknown ids refuse the whole card, every one named by kind", async () => {
    await assert.rejects(
      resolveConfirmItems({ sessions: ["s1", "zz"], ideas: ["sova/x", "sova/y"], todos: ["td_aaaaaaaa"] }, lookup, refusal),
      (err: Error) => /sessions: zz; ideas: sova\/y\)/.test(err.message) && !err.message.includes("s1,") && !err.message.includes("todos:"),
    );
  });

  test(`at most ${CONFIRM_ITEMS_MAX} items, counted before anything resolves; items must be an object`, async () => {
    const many = Array.from({ length: CONFIRM_ITEMS_MAX }, (_, i) => `x${i}`);
    await assert.rejects(resolveConfirmItems({ sessions: many, todos: ["td_aaaaaaaa"] }, lookup, refusal), new RegExp(`at most ${CONFIRM_ITEMS_MAX} items; this one has ${CONFIRM_ITEMS_MAX + 1}`));
    await assert.rejects(resolveConfirmItems(["s1"], lookup, refusal), /items is an object/);
    // glm-5.3 sent one entry as items itself; the refusal says where it goes.
    await assert.rejects(resolveConfirmItems({ id: "s1", note: "n" }, lookup, refusal), /items takes only sessions, ideas and todos, each a list; this one has id, note\. Put each entry in its list, e\.g\. \{"sessions": \[\{"id"/);
    assert.deepEqual(await resolveConfirmItems(undefined, lookup, refusal), []);
  });

  test("the echo repeats the items, numbered, with exact ids and links", async () => {
    const items = await resolveConfirmItems({ sessions: ["s1"], ideas: ["§sova/x"], todos: ["td_aaaaaaaa"] }, lookup, refusal);
    const out = echo(items);
    assert.ok(out.includes("  1. §sova/x — X"), out);
    assert.ok(out.includes("  2. td_aaaaaaaa · Do it"), out);
    assert.ok(out.includes("  3. [Parser fixed, tests green](sova://s/s1) (s1)"), out); // named summary-first (§app.overseer/session-names)
  });

  test("an entry's default rides along to the card, lowercased", async () => {
    const items = await resolveConfirmItems({ sessions: [{ id: "s1", default: "B" }, "s2"] }, lookup, refusal);
    assert.deepEqual(items.map((i) => i.default), ["b", undefined]);
  });

  test("an entry is a bare id or { id, note }; the note is snapshotted with whitespace collapsed", async () => {
    const items = await resolveConfirmItems(
      { sessions: [{ id: "sova://s/s1", note: "Parser fix.  Merged,\n nothing running." }, "s2"], ideas: [{ id: "sova/x", note: "The sweep itself." }], todos: [{ id: "td_aaaaaaaa" }] },
      lookup,
      refusal,
    );
    assert.deepEqual(
      items.map((i) => [i.id, i.note]),
      [["s1", "Parser fix. Merged, nothing running."], ["s2", undefined], ["§sova/x", "The sweep itself."], ["td_aaaaaaaa", undefined]],
    );
    assert.ok(!("note" in items[1]!), "no note, no key");
  });

  test(`a note over ${CONFIRM_NOTE_MAX} characters is cut with "…", never refused, and each cut note is named with its length`, async () => {
    const long = "x".repeat(CONFIRM_NOTE_MAX + 1);
    const cut: string[] = [];
    const items = await resolveConfirmItems({ sessions: [{ id: "s1", note: "fine" }, { id: "s2", note: long }], todos: [{ id: "td_aaaaaaaa", note: long }] }, lookup, refusal, cut);
    assert.deepEqual(cut, [`s2 (${CONFIRM_NOTE_MAX + 1})`, `td_aaaaaaaa (${CONFIRM_NOTE_MAX + 1})`]);
    const s2 = items.find((i) => i.id === "s2")!.note!;
    assert.equal(s2.length, CONFIRM_NOTE_MAX);
    assert.ok(s2.endsWith("…") && s2.startsWith("x".repeat(CONFIRM_NOTE_MAX - 1)));
    assert.equal(items.find((i) => i.id === "s1")!.note, "fine");
    const exact: string[] = [];
    assert.equal((await resolveConfirmItems({ sessions: [{ id: "s1", note: "y".repeat(CONFIRM_NOTE_MAX) }] }, lookup, refusal, exact))[0]!.note!.length, CONFIRM_NOTE_MAX);
    assert.deepEqual(exact, [], "a note of exactly the limit is not cut");
    // A refused card reports no cut: nothing was shown.
    const refused: string[] = [];
    await assert.rejects(resolveConfirmItems({ sessions: [{ id: "s2", note: long }, "zz"] }, lookup, refusal, refused), /These ids match nothing/);
    assert.deepEqual(refused, []);
  });

  test("an entry's own choices ride along to the card model unchecked; its default is lowercased", async () => {
    const items = await resolveConfirmItems({ sessions: [{ id: "s1", default: "C", choices: ["Clean Up & Archive", "Archive Only", "Keep"] }, "s2"] }, lookup, refusal);
    assert.deepEqual(items.map((i) => [i.id, i.default, i.choices]), [["s1", "c", ["Clean Up & Archive", "Archive Only", "Keep"]], ["s2", undefined, undefined]]);
    assert.ok(!("choices" in items[1]!), "no choices, no key");
  });

  test("the overseer's own conversation is refused by name, whatever form names it", async () => {
    await assert.rejects(resolveConfirmItems({ sessions: ["s1", { id: "sova://s/me", note: "Me." }] }, lookup, refusal), /No card was shown\. sova:\/\/s\/me is your own conversation; a card never lists it/);
  });

  test("the echo carries each note after its item", async () => {
    const items = await resolveConfirmItems(
      { sessions: [{ id: "s1", note: "Parser fix. Merged." }], ideas: [{ id: "sova/x", note: "Done by the sweep." }], todos: [{ id: "td_aaaaaaaa", note: "Covered." }] },
      lookup,
      refusal,
    );
    const out = echo(items);
    assert.ok(out.includes("3. [Parser fixed, tests green](sova://s/s1) (s1) — Parser fix. Merged."), out);
    assert.ok(out.includes("1. §sova/x — X — Done by the sweep."), out);
    assert.ok(out.includes("2. td_aaaaaaaa · Do it — Covered."), out);
  });
});

describe("the confirm card on the Overseer's route calls (§app.overseer/org-people-facing)", () => {
  test("its items' ids by kind; ideas and to-dos are no target of a people-facing act", async () => {
    const { cardHeader, OVERSEER_CARD_HEADER } = await import("./overseer-tools");
    assert.equal(OVERSEER_CARD_HEADER, "x-sova-overseer-card");
    const header = cardHeader([
      { kind: "person", id: "p_1", orgId: "o", name: "Ana", orgName: "O", status: "active" },
      { kind: "project", id: "prj_1", orgId: "o", name: "P", orgName: "O" },
      { kind: "session", id: "s1", title: "S" },
      { kind: "idea", id: "§i", title: "I" },
    ]);
    assert.deepEqual(JSON.parse(header), { people: ["p_1"], projects: ["prj_1"], sessions: ["s1"] });
  });
});
