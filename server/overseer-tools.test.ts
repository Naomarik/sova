// Run: npx tsx --test server/overseer-tools.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { SessionSummary, TranscriptItem } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";
import { sourced } from "./transcript";

const agentDir = mkdtempSync(join(tmpdir(), "sova-overseer-tools-"));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { concurrencyRefusal, overseerTools, renderTranscript, TurnLimits, BUILTIN_ALLOWED, SANDBOX_LOWER_REFUSAL, SANDBOX_LOWER_CREATE_REFUSAL } = await import("./overseer-tools");
const { buildOverseerTools, countRunning, renderOverseerPrompt, briefDecision, BRIEF_MIN_GAP_MS, BRIEF_REPEAT_MS } = await import("./overseer");
const { DEFAULT_CAPS, readOverseerSettings } = await import("./overseer-store");
const { disposeAllChats } = await import("./chat-manager");
const { historyOf } = await import("./harness/pi/reader");

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
    await import("./outreach/protected-paths"); // adds the sender's credentials, as the server's startup does
    const prompt = renderOverseerPrompt(buildOverseerTools(), readOverseerSettings());
    const r = secretRules("/H", "/A");
    assert.ok(r.files.some((f) => f.endsWith("/outreach.json")) && r.dirs.some((d) => d.endsWith("/whatsapp")), "the outreach part's secrets are in the list");
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
    const ctx = { sessionId: "sess-1", cwd: "/", leafId: () => null, rawBranch: () => branch, branch: () => historyOf(branch) };
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
    const out = await card.execute("c2", { ops: [{ op: "create", title: "Tick?", options: [{ label: "Tick" }], items: { ideas: ["sova/confirm-rows"], todos: [todo.id] } }] }, undefined, undefined, undefined);
    assert.deepEqual(out.details.card.items, [
      { kind: "idea", id: "§sova/confirm-rows", title: "Cards list their subject", n: 1 },
      { kind: "todo", id: todo.id, text: "Tick the done ones", n: 2 },
    ]);
    assert.match((out.content[0] as { text: string }).text, /1\. §sova\/confirm-rows — Cards list their subject/);
    await assert.rejects(
      card.execute("c3", { ops: [{ op: "create", title: "Archive?", options: [{ label: "Archive" }], items: { sessions: ["sova://s/nope-1"], todos: [todo.id, "td_missing0"] } }] }, undefined, undefined, undefined),
      /No card was shown\. These ids match nothing \(sessions: sova:\/\/s\/nope-1; todos: td_missing0\)/,
    );
  });

  test("sova_card: per-row choices with no answer option, a long note cut and named in the echo, and card on a create read as replaces", async () => {
    const { addTodo } = await import("./overseer-todos");
    const a = addTodo({ text: "Clean the worktree" });
    const b = addTodo({ text: "Just file it" });
    const card = buildOverseerTools().find((t) => t.name === "sova_card")!;
    const branch: unknown[] = [];
    const ctx = { sessionId: "sess-rows", cwd: "/", leafId: () => null, rawBranch: () => branch, branch: () => historyOf(branch) };
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
      undefined,
    );
    assert.deepEqual(out.details.card.options.map((o: { href?: string }) => o.href), [undefined, "#/usage", "https://github.com/x/y/pull/1", "settings:overseer"]);
    await assert.rejects(
      card.execute("l2", { ops: [{ op: "create", title: "?", options: [{ label: "Go" }, { label: "Bad", link: { url: "http://x.test" } }, { label: "Creds", link: { url: "https://u:p@x.test" } }] }] }, undefined, undefined, undefined),
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
    items.push({ id: `u${i}`, kind: "user", text: `ask ${i}` });
    items.push({ id: `a${i}`, kind: "assistant-text", text: `answer ${i} ${"z".repeat(2000)}` });
    items.push({ id: `t${i}`, kind: "thinking", text: "secret thoughts" });
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

  const told = (entries: [string, number, number?][]) => new Map(entries.map(([k, count, clearedAt]) => [k, clearedAt === undefined ? { count } : { count, clearedAt }]));

  test("the first look is a baseline: what is already blocked is not news, at its count then", () => {
    const d = briefDecision({ ...base, current: ["a:error", "b:open-questions"], counts: new Map([["b:open-questions", 3]]), announced: null });
    assert.deepEqual(d.brief, []);
    assert.deepEqual([...d.announced], [["a:error", { count: 1 }], ["b:open-questions", { count: 3 }]]);
  });

  test("a new blocker briefs once; a standing one is not news again at the same or a lower count (§app.overseer/brief-repeat)", () => {
    let d = briefDecision({ ...base, current: ["a:error", "b:needs-input"], announced: told([["a:error", 1]]) });
    assert.deepEqual(d.brief, ["b:needs-input"]);
    d = briefDecision({ ...base, current: ["a:error", "b:needs-input"], announced: d.announced });
    assert.deepEqual(d.brief, []);
    const q = "s:open-questions";
    d = briefDecision({ ...base, current: [q], counts: new Map([[q, 2]]), announced: told([[q, 3]]) });
    assert.deepEqual(d.brief, [], "fewer questions than told");
    assert.equal(d.announced.get(q)?.count, 3, "the count told stays the bar");
    d = briefDecision({ ...base, current: [q], counts: new Map([[q, 3]]), announced: d.announced });
    assert.deepEqual(d.brief, [], "back to the count told");
  });

  test("its count rising is news while it stands, and the brief raises the count told", () => {
    const q = "s:open-questions";
    let d = briefDecision({ ...base, current: [q], counts: new Map([[q, 4]]), announced: told([[q, 2]]) });
    assert.deepEqual(d.brief, [q]);
    assert.equal(d.announced.get(q)?.count, 4);
    d = briefDecision({ ...base, current: [q], counts: new Map([[q, 4]]), announced: d.announced });
    assert.deepEqual(d.brief, []);
    // A worker error's failed count rises the same way.
    const w = "s:worker-error";
    assert.deepEqual(briefDecision({ ...base, current: [w], counts: new Map([[w, 2]]), announced: told([[w, 1]]) }).brief, [w]);
  });

  test("a told blocker that clears and returns within the hour is the same blocker; after an hour, or with more, it is news", () => {
    const q = "s:open-questions";
    const counts = new Map([[q, 2]]);
    // It stands, then clears (the session runs a turn): remembered from that moment.
    let d = briefDecision({ ...base, current: [], announced: told([[q, 2]]) });
    assert.deepEqual([...d.announced], [[q, { count: 2, clearedAt: base.now }]]);
    // Back 17 minutes later at the same count: not briefed, and standing again.
    const back = base.now + 17 * 60_000;
    d = briefDecision({ ...base, now: back, current: [q], counts, announced: d.announced });
    assert.deepEqual(d.brief, []);
    assert.deepEqual([...d.announced], [[q, { count: 2 }]]);
    // Back with more questions within the hour: news.
    const cleared = told([[q, 2, base.now]]);
    assert.deepEqual(briefDecision({ ...base, now: back, current: [q], counts: new Map([[q, 3]]), announced: cleared }).brief, [q]);
    // Back after the hour, same count: forgotten, so news.
    const late = base.now + BRIEF_REPEAT_MS;
    assert.deepEqual(briefDecision({ ...base, now: late, current: [q], counts, announced: cleared }).brief, [q]);
    // One that stays cleared for the hour leaves the memory.
    assert.deepEqual([...briefDecision({ ...base, now: late, current: [], announced: cleared }).announced], []);
    assert.deepEqual([...briefDecision({ ...base, now: late - 1, current: [], announced: cleared }).announced], [[q, { count: 2, clearedAt: base.now }]]);
  });

  test("held back while the Overseer is busy, within 10 minutes of the last brief, after 30 unattended, or when not in brief mode", () => {
    const announced = told([]);
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced, overseerIdle: false }).brief, []);
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced, lastBriefAt: base.now - 60_000 }).brief, []);
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced, unattended: 30 }).brief, []);
    // Held back is not forgotten: it briefs when the gate opens.
    const held = briefDecision({ ...base, current: ["n"], announced, overseerIdle: false });
    assert.deepEqual(briefDecision({ ...base, current: ["n"], announced: held.announced }).brief, ["n"]);
    // A risen count held back stays news until a brief carries it: the bar stays the count told.
    const q = "s:open-questions";
    const heldRise = briefDecision({ ...base, current: [q], counts: new Map([[q, 5]]), announced: told([[q, 2]]), overseerIdle: false });
    assert.equal(heldRise.announced.get(q)?.count, 2);
    assert.deepEqual(briefDecision({ ...base, current: [q], counts: new Map([[q, 5]]), announced: heldRise.announced }).brief, [q]);
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

describe("sova_session's truth lines (§app.overseer/session-truth)", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  const min = 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const item = (raw: unknown): TranscriptItem => sourced({ id: "x", kind: "unknown" }, raw);
  const question = (n: number, decided = false) => ({
    id: `q${n}`,
    topic: `Topic ${n}`,
    ask: `Ask ${n}?`,
    recommendation: { choice: "A", why: "because" },
    ...(decided ? { decision: { text: "A", by: "user", at: iso(now) } } : {}),
  });
  const alignDoc = (id: string, phase: "open" | "done", questions: unknown[]) => ({
    id,
    title: `Doc ${id}`,
    summary: "s",
    findings: [],
    approach: [],
    rejected: [],
    questions,
    phase,
    next: { f: 0, a: 0, x: 0, q: questions.length },
    rev: 1,
    createdAt: iso(now - 90 * min),
    updatedAt: iso(now - 90 * min),
  });
  const alignResult = (doc: unknown) => item({ type: "message", timestamp: iso(now - 80 * min), message: { role: "toolResult", toolName: "align", details: { v: 1, doc, changes: [{ kind: "created" }], line: "created" } } });
  const assistant = (at: number, text: string, stopReason = "stop", extra: Record<string, unknown> = {}) =>
    item({ type: "message", timestamp: iso(at), message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra } });
  const base = { id: "s1", path: "/s/s1.jsonl", title: "T", archived: false } as SessionSummary;

  test("the last reply with its age, stop reason and opening text; the summary dated and marked as written before it", async () => {
    const { truthLines } = await import("./overseer-tools");
    const long = `Done. ${"word ".repeat(100)}`;
    const items = [assistant(now - 3 * 3_600_000, "older"), assistant(now - 12 * min, long)];
    const outline = { now: "Running the migration", overall: "Port the store", lastHeading: null, state: "stale" as const, generatedAt: now - 2 * 3_600_000, topics: [] };
    const lines = truthLines(base, items, outline, undefined, now);
    const last = lines.find((l) => l.startsWith("Last reply: "))!;
    assert.match(last, /^Last reply: 12m ago \(stop: stop\) — "Done\. word word/);
    assert.ok(last.endsWith('…"') && last.length < 340, "the text is cut to 300 characters");
    assert.ok(lines.includes("Now (summary, 2h ago, written before the last reply, stale): Running the migration"), lines.join("\n"));
    assert.ok(lines.includes("Purpose (summary, 2h ago, written before the last reply, stale): Port the store"));
    // A summary newer than the last reply carries no such words.
    const fresh = truthLines(base, items, { ...outline, state: "fresh", generatedAt: now - min }, undefined, now);
    assert.ok(fresh.includes("Now (summary, 1m ago): Running the migration"), fresh.join("\n"));
  });

  test("an errored last turn, a session with no reply yet, and open alignments with their question counts and who they wait on", async () => {
    const { truthLines } = await import("./overseer-tools");
    const errored = truthLines(base, [assistant(now - 5 * min, "", "error", { errorMessage: "429 rate limited" })], undefined, undefined, now);
    assert.ok(errored.includes("Turn error: 429 rate limited"), errored.join("\n"));
    assert.deepEqual(truthLines(base, [], undefined, undefined, now), ["Last reply: none yet."]);
    const items = [
      alignResult(alignDoc("al_3", "open", [question(1), question(2, true), question(3)])),
      alignResult(alignDoc("al_4", "done", [question(1)])),
      assistant(now - min, "Which do you want?"),
    ];
    const waiting = truthLines({ ...base, align: { openDocs: 1, openQuestions: 2, questionDocs: 1 } }, items, undefined, undefined, now);
    assert.ok(waiting.includes(`Alignments: al_3 "Doc al_3": 2 of 3 questions open — the session waits on the user's answers`), waiting.join("\n"));
    const movedOn = truthLines(base, items, undefined, undefined, now);
    assert.ok(movedOn.some((l) => l.startsWith("Alignments: al_3") && l.endsWith("not waiting on the user (they spoke since, or align is off)")));
    assert.ok(!movedOn.join("\n").includes("al_4"), "a done alignment is not listed");
  });

  test("merge lines: each worktree's readiness, the merged badge, and the last check before or after the newest commit", async () => {
    const { truthLines } = await import("./overseer-tools");
    const s = {
      ...base,
      readiness: {
        trees: [
          { path: "/wt/a", branch: "feat/a", state: "ready", reason: "Ready to merge · checks passed · 3 commits ahead" },
          { path: "/wt/b", branch: "feat/b", state: "in-progress", reason: "In progress · uncommitted changes" },
        ],
        since: now - 30 * min,
      },
    } as unknown as SessionSummary;
    const checks = { lastCheck: { at: now - 10 * min, ok: true }, heads: { "/wt/a": now - 20 * min, "/wt/b": now - 5 * min } };
    const lines = truthLines(s, [], undefined, checks, now);
    assert.ok(lines.includes("Merge: feat/a — Ready to merge · checks passed · 3 commits ahead; last check passed 10m ago, after its newest commit (20m ago)"), lines.join("\n"));
    assert.ok(lines.includes("Merge: feat/b — In progress · uncommitted changes; last check passed 10m ago, before its newest commit (5m ago)"));
    const none = truthLines(s, [], undefined, { heads: {} }, now);
    assert.ok(none.includes("Merge: feat/a — Ready to merge · checks passed · 3 commits ahead; no check run seen"));
    const merged = truthLines({ ...s, readiness: { ...s.readiness!, badge: "restart", branch: "feat/a" } }, [], undefined, checks, now);
    assert.ok(merged.includes("Merged: feat/a 30m ago, the server restart it needs is pending"), merged.join("\n"));
  });

  test("the tool prints them for a session, and sova_read_session no longer says to prefer the summary", async () => {
    const s = { ...base, cwd: "/w", model: null, lastActiveAt: iso(now), live: null, busy: false, origin: "web" } as unknown as SessionSummary;
    const host = {
      session: async (ref: string) => (ref === "s1" ? s : null),
      insight: async () => ({ outline: { now: "Old line", overall: "", lastHeading: null, state: "fresh", generatedAt: Date.now() - 3_600_000, topics: [] } }),
      transcript: async () => [assistant(Date.now() - 60_000, "Merged and pushed.")],
      held: () => null,
      checks: () => undefined,
      confirmed: () => null,
      attended: () => true,
    } as unknown as OverseerToolHost;
    const tools = overseerTools(host, new TurnLimits());
    const out = await tools.find((t) => t.name === "sova_session")!.execute("t", { session: "s1" }, undefined, undefined, undefined as never);
    const text = (out.content[0] as { text: string }).text;
    assert.match(text, /\nLast reply: 1m ago \(stop: stop\) — "Merged and pushed\."/);
    assert.match(text, /\nNow \(summary, 1h ago, written before the last reply\): Old line/);
    const read = tools.find((t) => t.name === "sova_read_session")!;
    assert.ok(!/prefer/i.test(read.description), read.description);
    assert.match(read.description, /The tail is what is true now/);
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
    const { cardHeader } = await import("./overseer-tools");
    const { OVERSEER_CARD_HEADER } = await import("./overseer-sender");
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

describe("sova_alignment and the transcript's ALIGN rows (§app.overseer/alignment-read)", async () => {
  const { applyAlignCall } = await import("../pi-config/extensions/mode/align.ts");
  const { normalizeEntry } = await import("./transcript");
  type Doc = import("../pi-config/extensions/mode/align.ts").AlignDocument;
  const now = Date.parse("2026-10-01T10:00:00Z");
  const env = { now: "2026-10-01T09:00:00.000Z", readFile: () => "" };
  let docs: Doc[] = [];
  let seq = 0;
  /** An align call's result entry, normalized as the tool's transcript read gets it. */
  const call = (input: unknown): TranscriptItem[] => {
    const { details } = applyAlignCall(docs, input, env);
    if (details.doc) docs = [...docs.filter((d) => d.id !== details.doc!.id), details.doc];
    const id = `r${++seq}`;
    return normalizeEntry({ type: "message", id, parentId: null, timestamp: env.now, message: { role: "toolResult", toolCallId: `c${id}`, toolName: "align", content: [{ type: "text", text: "echo" }], details: JSON.parse(JSON.stringify(details)), isError: false } });
  };
  const items: TranscriptItem[] = [
    ...call({
      ops: [
        {
          op: "create",
          title: "Export",
          summary: "Download a session.",
          questions: [
            { topic: "Format", ask: "Which file format?", options: [{ label: "JSONL", tradeoff: "one line per entry" }, { label: "CSV", tradeoff: "opens in a spreadsheet" }], recommendation: { choice: "JSONL", why: "lossless" } },
            { topic: "Zip", ask: "Zip it?", recommendation: { choice: "no", why: "small files" } },
            { topic: "Name", ask: "File name?", recommendation: { choice: "title", why: "readable" } },
          ],
        },
      ],
    }),
    ...call({ ops: [{ op: "create", title: "Pane", summary: "Show workers.", questions: [{ topic: "Cap", ask: "How many?", recommendation: { choice: "8", why: "fits" } }] }] }),
    ...call({ doc: "al_1", ops: [{ op: "decide", q: "q1", decision: "CSV, for the spreadsheet" }, { op: "drop_question", q: "q3", reason: "the title is always used" }] }),
    ...call({ doc: "al_2", ops: [{ op: "accept_all" }, { op: "status", to: "done" }] }),
    ...call({ ops: [{ op: "exempt", reason: "a question, no change" }] }),
  ];
  const s = { id: "s1", path: "/s/s1.jsonl", title: "Export work", archived: false } as SessionSummary;
  const tool = (align?: SessionSummary["align"]) => {
    const host = {
      session: async (ref: string) => (ref === "s1" ? { ...s, ...(align ? { align } : {}) } : null),
      transcript: async () => items,
      confirmed: () => null,
      attended: () => false,
    } as unknown as OverseerToolHost;
    return overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_alignment")!;
  };
  const run = async (params: Record<string, unknown>, align?: SessionSummary["align"]) =>
    ((await tool(align).execute("t", params, undefined, undefined, undefined as never)).content[0] as { text: string }).text;

  test("every open alignment: each question's state, ask, lettered options, recommendation and decision; dropped as one line; untrusted", async () => {
    const out = await run({ session: "s1" }, { openDocs: 1, openQuestions: 1, questionDocs: 1 });
    assert.match(out, /^<<untrusted content from another session: "Export work" \(s1\)/);
    assert.ok(out.endsWith("<<end of untrusted content>>"));
    assert.ok(out.includes("The session waits on the user's answers now."), out);
    assert.ok(out.includes('al_1 "Export" · aligning · 1 of 2 open'), out);
    assert.ok(out.includes("  Summary: Download a session."));
    assert.ok(out.includes("  q1 Format — decided\n    Ask: Which file format?\n    a. JSONL — one line per entry\n    b. CSV — opens in a spreadsheet\n    Recommendation: a — JSONL — lossless\n    Decision (the user, "), out);
    assert.ok(out.includes("): CSV, for the spreadsheet"));
    assert.ok(out.includes("  q2 Zip — open\n    Ask: Zip it?\n    Recommendation: no — small files"), out);
    assert.ok(out.includes("  q3 Name — dropped: the title is always used"));
    assert.ok(!out.includes("al_2"), "a done alignment is left out without doc");
  });

  test("doc reads one alignment in any state; an id the branch lacks refuses naming the ones it has; not waiting is said", async () => {
    const done = await run({ session: "s1", doc: "al_2" });
    assert.ok(done.includes('al_2 "Pane" · done · all 1 decided'), done);
    assert.ok(done.includes("Decision (the recommendation accepted"), done);
    assert.ok(done.includes("not waiting on the user's answers"));
    assert.ok(!done.includes("al_1"));
    await assert.rejects(run({ session: "s1", doc: "al_9" }), /No alignment al_9 in that session; it has al_1, al_2\./);
  });

  test("a session with no open alignment says so in one line", async () => {
    const { alignmentText } = await import("./align-state");
    assert.equal(alignmentText([], { waits: false }), "No open alignment in this session.");
  });

  test("a transcript read shows each changing align call as one ALIGN row, and an exemption", () => {
    const out = renderTranscript(items, { from: "start", items: 40, chars: 12000, title: "T", id: "x" });
    const rows = out.split("\n").filter((l) => l.startsWith("ALIGN: "));
    assert.deepEqual(rows, [
      'ALIGN: al_1 "Export" · aligning · 3 of 3 open · created',
      'ALIGN: al_2 "Pane" · aligning · 1 of 1 open · created',
      'ALIGN: al_1 "Export" · aligning · 1 of 2 open · q1 decided · q3 dropped',
      'ALIGN: al_2 "Pane" · done · all 1 decided · q1 accepted · → done',
      "ALIGN: exempt — a question, no change",
    ]);
    assert.ok(!out.includes("Which file format?"), "the row never carries the questions");
  });
});

describe("sova_list_sessions rows say each worktree's branch (§app.overseer/sessions-in-play)", () => {
  test("'branch <name> (<badge>)' for the worktree the badge speaks for, the state for the others", async () => {
    const base = { id: "s1", path: "/s/s1.jsonl", title: "T", cwd: "/w", model: null, lastActiveAt: new Date().toISOString(), live: null, busy: false, origin: "web", archived: false };
    const sessions = [
      {
        ...base,
        readiness: {
          trees: [
            { path: "/wt/a", branch: "feat/a", state: "ready" },
            { path: "/wt/b", branch: "feat/b", state: "blocked" },
          ],
          badge: "ready",
          branch: "feat/a",
          since: 0,
        },
      },
      { ...base, id: "s2", path: "/s/s2.jsonl" },
    ] as unknown as SessionSummary[];
    const host = { sessions: async () => sessions, confirmed: () => null, attended: () => false } as unknown as OverseerToolHost;
    const list = overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_list_sessions")!;
    const text = ((await list.execute("t", {}, undefined, undefined, undefined as never)).content[0] as { text: string }).text;
    const [row1, row2] = text.split("\n").filter((l) => l.startsWith("- "));
    assert.ok(row1!.endsWith(" · branch feat/a (ready) · branch feat/b (blocked)"), row1);
    assert.ok(!row2!.includes("branch"), row2);
  });
});

describe("sandbox on sova_set_session and sova_create_session (§app.overseer/tools)", () => {
  type State = "off" | "subagents" | "on";
  /** Sessions `a` and `b` with a sandbox each; the route sets it as the extension would. `card`: the
      items of the card whose click opened this turn (null: none did). */
  function harness(o: { states?: Record<string, State | null>; card?: { kind: "session"; id: string }[] | null; attended?: boolean; permit?: boolean; defaultState?: State } = {}) {
    const states = new Map<string, State | null>(Object.entries(o.states ?? { a: "subagents", b: "on" }) as [string, State | null][]);
    const calls: { path: string; body: any }[] = [];
    const summary = (id: string) => ({ id, path: `/s/${id}.jsonl`, title: `Session ${id}`, cwd: "/w" }) as SessionSummary;
    const info = (s: State) => ({ on: s === "on", state: s, enforcement: s === "on" ? "full" : "none", status: `Sandbox ${s}` });
    const host = {
      request: async (path: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        if (path === "/api/sessions") {
          states.set("new", "subagents");
          return Response.json(summary("new"), { status: 201 });
        }
        const m = /^\/api\/sandbox\?path=%2Fs%2F(\w+)\.jsonl$/.exec(path);
        if (m) {
          const st = states.get(m[1]!);
          if (st === null || st === undefined) return Response.json({ outcome: "unsupported" });
          states.set(m[1]!, body.state);
          return Response.json({ outcome: "command", sandbox: info(body.state) });
        }
        return Response.json({ ok: true });
      },
      overseerId: () => "ov",
      confirmed: () => o.card ?? null,
      attended: () => o.attended ?? true,
      permit: () => (o.permit ? { id: "g_1", label: "any act" } : null),
      used: () => {},
      caps: () => DEFAULT_CAPS,
      session: async (ref: string) => (["a", "b", "new"].includes(ref) ? summary(ref) : null),
      open: async () => {},
      sandbox: async (path: string) => {
        const st = states.get(/\/s\/(\w+)\.jsonl/.exec(path)![1]!);
        return st ? info(st) : null;
      },
      sandboxDefault: () => o.defaultState ?? "subagents",
      started: () => {},
      runningStarted: () => 0,
      counted: () => false,
    } as unknown as OverseerToolHost;
    const tools = overseerTools(host, new TurnLimits());
    const run = (name: string, params: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.execute("tc", params, undefined, undefined, undefined as never).then(
        (r) => r.content.map((c) => (c as { text: string }).text).join("\n"),
        (e: Error) => `ERROR: ${e.message}`,
      );
    const sandboxCalls = () => calls.filter((c) => c.path.startsWith("/api/sandbox"));
    return { run, calls, sandboxCalls, states };
  }

  test("raising runs like any act; the result names the state and what running subagents keep", async () => {
    const h = harness();
    const r = await h.run("sova_set_session", { session: "a", sandbox: "on" });
    assert.match(r, /sandbox On \(from its next tool call; running subagents keep theirs until resumed\)/);
    assert.deepEqual(h.sandboxCalls().map((c) => c.body), [{ state: "on" }]);
    assert.equal(h.states.get("a"), "on");
  });

  test("lowering without a click refuses before anything changes, a rename in the same call included", async () => {
    const h = harness();
    for (const to of ["subagents", "off"]) {
      assert.equal(await h.run("sova_set_session", { session: "b", sandbox: to, title: "renamed" }), `ERROR: ${SANDBOX_LOWER_REFUSAL}`);
    }
    assert.equal(await h.run("sova_set_session", { session: "a", sandbox: "off" }), `ERROR: ${SANDBOX_LOWER_REFUSAL}`);
    assert.deepEqual(h.calls, [], "no route was called: no title, no sandbox");
    assert.deepEqual([h.states.get("a"), h.states.get("b")], ["subagents", "on"]);
  });

  test("lowering needs a click on a card that lists that session", async () => {
    const other = harness({ card: [{ kind: "session", id: "a" }] });
    assert.equal(await other.run("sova_set_session", { session: "b", sandbox: "off" }), `ERROR: ${SANDBOX_LOWER_REFUSAL}`);
    const listed = harness({ card: [{ kind: "session", id: "b" }] });
    assert.match(await listed.run("sova_set_session", { session: "b", sandbox: "off" }), /sandbox Off/);
    assert.equal(listed.states.get("b"), "off");
  });

  test("an approval for later covers raising, never lowering", async () => {
    const h = harness({ attended: false, permit: true });
    assert.match(await h.run("sova_set_session", { session: "a", sandbox: "on" }), /sandbox On.*Done under g_1/s);
    assert.equal(await h.run("sova_set_session", { session: "a", sandbox: "off" }), `ERROR: ${SANDBOX_LOWER_REFUSAL}`);
    assert.equal(h.states.get("a"), "on");
  });

  test("a session without the sandbox extension, and a value that is no state, refuse", async () => {
    const h = harness({ states: { a: null, b: "on" } });
    assert.match(await h.run("sova_set_session", { session: "a", sandbox: "on" }), /^ERROR: .* has no sandbox extension, so its sandbox can't be set\. Nothing was changed\.$/);
    assert.equal(await h.run("sova_set_session", { session: "b", sandbox: "none" }), 'ERROR: sandbox is "off", "subagents" or "on". Nothing was changed.');
    assert.deepEqual(h.sandboxCalls(), []);
  });

  test("create: below the state it would start in needs a click, refused before anything is created; it is set before the first prompt", async () => {
    const h = harness();
    assert.equal(await h.run("sova_create_session", { cwd: "/w", sandbox: "off", prompt: "go" }), `ERROR: ${SANDBOX_LOWER_CREATE_REFUSAL}`);
    assert.deepEqual(h.calls, [], "nothing created");
    const on = harness({ defaultState: "on" });
    assert.equal(await on.run("sova_create_session", { cwd: "/w", sandbox: "subagents" }), `ERROR: ${SANDBOX_LOWER_CREATE_REFUSAL}`);
    assert.match(await harness().run("sova_create_session", { cwd: "/w", sandbox: "on" }), /Sandbox: On \(this session only\)\./);
    const clicked = harness({ card: [] });
    const r = await clicked.run("sova_create_session", { cwd: "/w", sandbox: "off", prompt: "go" });
    assert.match(r, /Sandbox: Off \(this session only\)\./);
    const order = clicked.calls.map((c) => c.path.split("?")[0]);
    assert.ok(order.indexOf("/api/sandbox") < order.indexOf("/api/sessions/prompt"), `the sandbox before the first prompt: ${order.join(", ")}`);
    assert.equal(clicked.states.get("new"), "off");
    assert.match(await harness({ card: [] }).run("sova_create_session", { host: "peer", cwd: "/w", sandbox: "on" }), /^ERROR: A sandbox can't be given with host\. No session was created\.$/);
  });
});
