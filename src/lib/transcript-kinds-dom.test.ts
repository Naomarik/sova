// Run: pnpm test -- src/lib/transcript-kinds-dom.test.ts
// The transcript rows drawn through the card toolkit's kind list (src/lib/transcript-kinds.ts) draw
// exactly the markup they drew on the old per-kind path (§chat.transcript-cards/built-ins: "Nothing
// a user sees changes"). Each case renders a whole transcript (HistoryItems) with Solid's SSR build
// (src/lib/align-card-ssr.mjs), row boxes and their height estimates included, and is compared with
// transcript-kinds-dom.snapshot.json, taken from the transcript before the kind list existed.
// Hydration keys and marker comments are left out: they say how Solid drew it, not what the page
// holds. Regenerate only for a change you mean:
// WRITE_KINDS_SNAPSHOT=1 pnpm test -- src/lib/transcript-kinds-dom.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { HistoryItems } = await importSsr(new URL("../components/Thread.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
type TranscriptItem = import("../../shared/protocol").TranscriptItem;

const SNAPSHOT = new URL("./transcript-kinds-dom.snapshot.json", import.meta.url);
const AT = "2026-02-01T10:00:00.000Z";

const row = (id: string, over: Partial<TranscriptItem>): TranscriptItem => ({ id, kind: "info", at: AT, ...over }) as TranscriptItem;
const user = row("u1", { kind: "user", text: "Hello" });

/** Each case: the rows of one transcript, and the props it is drawn with. */
const CASES: Record<string, { items: TranscriptItem[]; props?: Record<string, unknown> }> = {
  "wake: a nudge with a reason": { items: [row("w1", { kind: "wake", text: "[wake_nudge n1] Reason: check the build", wake: { id: "n1", reason: "check the build" } })] },
  "wake: late, no reason": { items: [row("w2", { kind: "wake", text: "[wake_nudge n2]", wake: { id: "n2", late: "3 minutes" } })] },
  "wake: a schedule with a playbook": {
    items: [row("w3", { kind: "wake", text: "[schedule s1] Reason: nightly", wake: { id: "s1", schedule: true, reason: "nightly", playbook: { id: "pb-1", load: "inline" } } as never })],
  },
  "wake: a tour sign-in": { items: [row("w4", { kind: "wake", text: "[tour_sign_in t1]", wake: { id: "t1", tour: true } })] },
  "topic: two notes": {
    items: [
      row("t1", {
        kind: "topic",
        text: "[topic release b3, 2 notes]",
        topic: {
          topic: "release",
          batch: "b3",
          notes: [
            { id: "n1", from: { sessionId: "s-a", title: "Build fixer" }, at: AT, text: "The build is green.\nShipping." },
            { id: "n2", from: { sessionId: "s-b", title: "Docs" }, at: AT, text: "Docs updated `here`." },
          ],
        },
      }),
    ],
  },
  "compaction: tokens and files": {
    items: [row("c1", { text: "Compacted", facts: { compaction: { tokensBefore: 123456, summary: "Earlier work: the build.", details: { readFiles: ["/a/b.ts"], modifiedFiles: ["/a/c.ts", "/a/d.ts"] } } } })],
  },
  "compaction: no tokens": { items: [row("c2", { text: "Compacted", facts: { compaction: { summary: "S" } } })] },
  "compaction: from meta (wire v1)": { items: [row("c3", { text: "Compacted", meta: { compaction: { tokensBefore: 9, summary: "old" } } as never })] },
  "info: plain": { items: [row("i1", { text: "Model changed to glm" })] },
  "info: long text with a path": { items: [row("i2", { text: "Wrote /home/someone/project/src/a.ts and more text that wraps across the row because it is long enough to wrap twice over." })] },
  "info: errored stop with the limit row": {
    items: [user, row("e1:stop", { text: "Error: 429 rate limited", model: "anthropic/claude" })],
    props: { limitPath: "/state/sessions/a.jsonl" },
  },
  "info: errored stop without a limit path": { items: [user, row("e2:stop", { text: "Error: boom" })] },
  "info: aborted stop": { items: [user, row("e3:stop", { text: "Aborted" })], props: { limitPath: "/state/sessions/a.jsonl" } },
  "info: login note before a user row": { items: [row("l1", { text: "Signed in as someone", loginNote: true } as never)] },
  "info: login note after a user row": { items: [user, row("l2", { text: "Signed in as someone", loginNote: true } as never)] },
  "info: a sent mark draws nothing": { items: [row("m1", { text: "sent", overseerMark: { kind: "sent", targetId: "x" } } as never)] },
  "info: a handoff run stays its own row": { items: [row("h1", { text: "Handing off…", handoffRun: { status: "running" } } as never)] },
  "mixed: every migrated kind in one transcript": {
    items: [
      user,
      row("w5", { kind: "wake", text: "[wake_nudge n5]", wake: { id: "n5", reason: "r" } }),
      row("t5", { kind: "topic", text: "[topic x b1, 1 note]", topic: { topic: "x", batch: "b1", notes: [{ id: "n1", from: { sessionId: "s", title: "T" }, at: AT, text: "hi" }] } }),
      row("c5", { text: "Compacted", facts: { compaction: { tokensBefore: 10 } } }),
      row("i5", { text: "Note" }),
    ],
  },
};

const draw = (c: (typeof CASES)[string]): string =>
  renderToString(() => solid.createComponent(HistoryItems as never, { items: c.items, author: "Agent", streaming: false, whole: true, ...c.props } as never))
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");

const drawn = Object.fromEntries(Object.entries(CASES).map(([name, c]) => [name, draw(c)]));

if (process.env.WRITE_KINDS_SNAPSHOT === "1") writeFileSync(SNAPSHOT, `${JSON.stringify(drawn, null, 2)}\n`);

test("every migrated row draws the markup it drew before the kind list", () => {
  assert.ok(existsSync(SNAPSHOT), "the snapshot is missing");
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(drawn).sort(), Object.keys(before).sort(), "the cases changed: regenerate the snapshot from the old path, never from this one");
  for (const [name, html] of Object.entries(drawn)) assert.equal(html, before[name], name);
});

test("each case draws something, so the comparison can't pass on two empty strings", () => {
  for (const [name, html] of Object.entries(drawn)) {
    if (name.includes("draws nothing") || name.includes("before a user row")) continue;
    assert.match(html, /class="entry[^"]*"[^>]*><[a-z]/, name);
  }
});
