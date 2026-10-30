// Run: pnpm test -- src/lib/transcript-builtins-dom.test.ts
// Sova's own transcript cards draw exactly the markup they drew on their old per-kind path as they
// move onto the card toolkit (§chat.transcript-cards/built-ins: "Nothing a user sees changes"): the
// companion of transcript-kinds-dom.test.ts for every built-in that was still drawn by a branch of
// its own in Thread.tsx. Each case renders a whole transcript (HistoryItems) with Solid's SSR build
// (src/lib/align-card-ssr.mjs), row boxes and their height estimates included, and is compared with
// transcript-builtins-dom.snapshot.json, taken from the transcript before any of these kinds moved.
// Hydration keys and marker comments are left out, and Math.random is seeded (a card's radio group
// names are random). Regenerate only for a change you mean, and only from the old path:
// WRITE_BUILTINS_SNAPSHOT=1 pnpm test -- src/lib/transcript-builtins-dom.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { HistoryItems } = await importSsr(new URL("../components/Thread.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
type TranscriptItem = import("../../shared/protocol").TranscriptItem;

const SNAPSHOT = new URL("./transcript-builtins-dom.snapshot.json", import.meta.url);
const AT = "2026-02-01T10:00:00.000Z";

const row = (id: string, over: Partial<TranscriptItem>): TranscriptItem => ({ id, kind: "info", at: AT, ...over }) as TranscriptItem;
const user = (id: string, text = "Hello") => row(id, { kind: "user", text });
const call = (id: string, name: string, args: unknown, over: Partial<TranscriptItem> = {}) =>
  row(id, { kind: "tool-call", text: name, toolCallId: `c-${id}`, tool: { args }, ...over } as never);
const result = (id: string, callId: string, text: string, details?: unknown, isError = false) =>
  row(id, { kind: "tool-result", toolCallId: callId, text, tool: { output: text, details }, facts: { tool: { isError } } } as never);
const cardOf = (id: string, name: string, args: unknown, details: unknown, text = "ok") => [call(id, name, args), result(`${id}r`, `c-${id}`, text, details)];

const btn = (label: string) => ({ label, about: `${label}.`, kind: "send", text: label });
const offer = {
  v: 1,
  card: { id: "of_2", name: "deploy", title: "Deploy the preview?", note: "The build is green.", buttons: [btn("Deploy"), btn("Not Yet")], at: AT, by: "another-chat", state: "open" },
};
const settingsCard = {
  id: "sc_3",
  state: "waiting",
  title: "Let Reviewer read other sessions",
  why: "It reviews branches across chats.",
  by: { kind: "agent", sessionId: "s-1", title: "Overseer" },
  createdAt: AT,
  kept: [{ field: "autonomy", label: "Autonomy", from: "ask", to: "act", fromText: "Ask first", toText: "Act" }],
  files: [{ setting: "profiles", id: "reviewer", path: ".sova/profiles/reviewer.json", change: "changed", summary: "Profile Reviewer: may also read other sessions (read)" }],
  grants: [{ key: "project:/p#reviewer", setting: "profiles", what: "Reviewer may read other sessions" }],
  lands: "master in /p",
  diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
  fingerprint: "fp1",
};

/** Each case: the rows of one transcript, and the props it is drawn with. */
const CASES: Record<string, { items: TranscriptItem[]; props?: Record<string, unknown> }> = {
  "user and brief rows": { items: [user("u1", "Fix the **sidebar**"), row("b1", { kind: "user", text: "[brief]\nDo the thing" } as never)] },
  "a user row an overseer sent": { items: [user("u2", "Look at this"), row("m2", { text: "", overseerMark: { kind: "sent", targetId: "u2" } } as never)] },
  "a user row another session sent": {
    items: [user("u3", "Hi"), row("m3", { text: "", sessionMark: { kind: "sent", targetId: "u3", from: { sessionId: "s-9", title: "Planner" }, hop: 1 } } as never)],
  },
  "assistant text: heads by model": {
    items: [
      user("u4"),
      row("a1", { kind: "assistant-text", text: "First **reply**.", model: "anthropic/claude-x" }),
      row("a2", { kind: "assistant-text", text: "Same model, no head.", model: "anthropic/claude-x" }),
      row("a3", { kind: "assistant-text", text: "Another model.", model: "zai/glm-5.3" }),
    ],
  },
  thinking: { items: [user("u5"), row("th1", { kind: "thinking", text: "Let me think about `x`." })] },
  "profile mark before and after a user row": {
    items: [row("p1", { text: "Profile: Reviewer", profileMark: { profile: { id: "reviewer", label: "Reviewer", icon: "eye" } } } as never), user("u6")],
  },
  "profile mark with no user row": { items: [row("p2", { text: "Profile: Reviewer", profileMark: { profile: { id: "reviewer", label: "Reviewer", icon: "eye" } } } as never)] },
  "baton marks": {
    props: { names: { p_kim: "Kim", p_lee: "Lee" } },
    items: [
      row("bm1", { text: "", batonMark: { kind: "handoff", n: 1, from: "operator", to: "p_kim", question: "Ship it?", briefing: "The **build** is green." } } as never),
      row("bm2", { text: "", batonMark: { kind: "offer", n: 2, offerId: "o1", from: "p_kim", to: ["p_lee", "operator"], question: "Who reviews?", briefing: "Needs eyes." } } as never),
      row("bm3", { text: "", batonMark: { kind: "lease", n: 2, offerId: "o1", event: "claimed", by: "p_lee" } } as never),
      row("bm4", { text: "", batonMark: { kind: "lease", n: 2, offerId: "o1", event: "expired", by: "p_lee" } } as never),
      row("bm5", { text: "", batonMark: { kind: "decision", by: "p_kim", area: "release", statement: "Ship Friday", quote: "Let's ship Friday." } } as never),
      row("bm6", { text: "", batonMark: { kind: "proposal", personId: "p_new", name: "Ana", role: "QA", why: "Testing", by: "p_kim" } } as never),
      row("bm7", { text: "", batonMark: { kind: "wrapup", phase: "start" } } as never),
      row("bm8", { text: "", batonMark: { kind: "wrapup", phase: "end", applied: [{ personId: "p_kim", field: "notes", at: AT }], refused: [] } } as never),
      row("bm9", { text: "", batonMark: { kind: "done", summary: "Shipped." } } as never),
      user("u7", "From Kim"),
      row("bm10", { text: "", batonMark: { kind: "sent", targetId: "u7", by: "p_kim" } } as never),
    ],
  },
  "overseer dialog answer": { items: [row("oa1", { text: "", overseerMark: { kind: "dialog-answer", title: "Merge feat/a?", answer: "Yes" } } as never)] },
  "worktree merge": {
    items: [row("wm1", { kind: "worktree-merge", text: "merged", worktreeMerge: { path: "/w/feat-a", branch: "feat/a", target: "master", sha: "abc1234def5678", commits: 3, added: 40, removed: 7, fastForward: false, how: "tool" } } as never)],
  },
  "owner request": { items: [row("or1", { text: "Request", ownerRequest: { orgId: "o1", requestId: "rq1", kind: "feature", projectId: "p1", project: "Shop", title: "Add dark mode", text: "Please add a **dark** mode.", filedAt: AT, ownerName: "Sam Rivera" } } as never)] },
  "handoff runs": {
    items: [
      row("hr1", { text: "Handing off to a fresh chat…", handoffRun: { id: "h1", status: "running" } } as never),
      row("hr2", { text: "Handed off.", handoffRun: { id: "h2", status: "saved", path: "/n/handoff.md" } } as never),
    ],
  },
  "a report": { items: [row("r1", { kind: "report", text: "Report", report: { source: "subagent-complete", agent: { id: "ag_01", name: "builder", status: "done", outcome: "success" }, model: "zai/glm-5.3", effort: "low", body: "All **green**.", preview: "All green.", truncated: false, kind: "report", role: "worker" } } as never)] },
  "an offer card": { items: [user("u8"), ...cardOf("of", "offer", { name: "deploy" }, offer, "Shown")] },
  "an offer call that failed stays a tool card": { items: [user("u9"), call("of2", "offer", { name: "x" }), result("of2r", "c-of2", "No such offer", undefined, true)] },
  "a settings change card": { items: [user("u10"), ...cardOf("st", "sova_settings", { op: "propose" }, { kind: "settings-card", projectId: "p1", card: settingsCard, appliedNow: [] })] },
  "settings applied now": {
    items: [
      user("u11"),
      ...cardOf("st2", "sova_settings", { op: "set" }, {
        kind: "settings-card",
        projectId: "p1",
        card: null,
        appliedNow: [{ id: "h1", at: AT, field: "autonomy", from: "ask", to: "act", by: { kind: "operator" }, label: "Autonomy", fromText: "Ask first", toText: "Act" }],
      }),
    ],
  },
  "tools: done, failed, running and an orphan result": {
    props: { streaming: true },
    items: [
      user("u12"),
      ...cardOf("t1", "read", { path: "/a.ts" }, undefined, "file text"),
      call("t2", "bash", { command: "false" }),
      result("t2r", "c-t2", "exit 1", undefined, true),
      user("u13"),
      call("t3", "bash", { command: "sleep 9" }),
      result("t4r", "c-gone", "orphan output"),
    ],
  },
  "tools: a tool with no result, not streaming": { items: [user("u14"), call("t5", "grep", { pattern: "x" })] },
  "hidden tools and thinking": {
    props: { hideTools: true, hideThinking: true },
    items: [user("u15"), row("th2", { kind: "thinking", text: "hmm" }), ...cardOf("t6", "read", { path: "/b.ts" }, undefined, "b"), row("a4", { kind: "assistant-text", text: "Done." })],
  },
};

let seed = 1;
const seeded = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
// Solid's SSR runs a view's cleanups after the render; the Markdown view cancels its frame there.
const g = globalThis as { cancelAnimationFrame?: (n: number) => void };
g.cancelAnimationFrame ??= () => {};
const draw = (c: (typeof CASES)[string]): string => {
  const random = Math.random;
  seed = 1;
  Math.random = seeded;
  try {
    return renderToString(() => solid.createComponent(HistoryItems as never, { items: c.items, author: "Agent", streaming: false, whole: true, ...c.props } as never))
      .replace(/ data-hk="[^"]*"/g, "")
      .replace(/<!--[^>]*-->/g, "");
  } finally {
    Math.random = random;
  }
};

const drawn = Object.fromEntries(Object.entries(CASES).map(([name, c]) => [name, draw(c)]));

if (process.env.WRITE_BUILTINS_SNAPSHOT === "1") writeFileSync(SNAPSHOT, `${JSON.stringify(drawn, null, 2)}\n`);

test("every built-in row draws the markup it drew on its old path", () => {
  assert.ok(existsSync(SNAPSHOT), "the snapshot is missing");
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(drawn).sort(), Object.keys(before).sort(), "the cases changed: regenerate the snapshot from the old path, never from this one");
  for (const [name, html] of Object.entries(drawn)) assert.equal(html, before[name], name);
});

test("each case draws its rows, so the comparison can't pass on empty strings", () => {
  for (const [name, html] of Object.entries(drawn)) {
    if (name === "profile mark with no user row") assert.doesNotMatch(html, /profile-row/, name);
    else assert.match(html, /class="entry[^"]*"[^>]*><[a-z]/, name);
  }
});

test("the cases reach the cards they name, not a tool card or Unknown in their place", () => {
  assert.match(drawn["an offer card"]!, /offer-card/);
  assert.doesNotMatch(drawn["an offer call that failed stays a tool card"]!, /offer-card/);
  assert.match(drawn["a settings change card"]!, /Let Reviewer read other sessions/);
  assert.match(drawn["overseer dialog answer"]!, /Merge feat\/a\?/);
  for (const [name, html] of Object.entries(drawn)) assert.doesNotMatch(html, /class="[^"]*unknown/i, `${name} draws an Unknown row`);
});
