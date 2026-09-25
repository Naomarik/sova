import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { COMPARED_FIELDS, EXEMPT_FIELDS, reuseUnchanged, sameSummary } from "./summary-diff";

/** A summary with EVERY field set, so a change to any one of them is a real change. */
const full = (): Required<SessionSummary> => ({
  id: "01a0",
  path: "/s/a.jsonl",
  cwd: "/w",
  title: "Title",
  originalTitle: "first message",
  createdAt: "2026-09-20T00:00:00.000Z",
  lastActiveAt: "2026-09-20T00:01:00.000Z",
  model: "ollama-cloud/glm-5.3",
  outlineNow: "now",
  outlineGist: "gist",
  outlineAt: 1,
  outlineTopics: 2,
  context: { tokens: 10, window: 100 },
  live: { pid: 1, status: "idle", workers: { working: 0, total: 1 } },
  workers: { working: 0, total: 1 },
  workerSession: true,
  busy: false,
  origin: "web",
  archived: false,
  groupId: "g",
  parent: "/s/p.jsonl",
  parentId: "p",
  target: "box",
  remoteCwd: "/r",
  draftPreview: "draft",
  hasDraft: true,
  legacyFormat: true,
  overseer: true,
  activity: { state: "idle", since: 5 },
  pendingDialogs: 1,
  seenAt: 10,
  unread: true,
  signals: { at: 11, turnId: "e1", provider: "jev", asksUser: 0.9, kinds: ["asks-you"] },
  workerSignals: { stuck: 0, failed: 1 },
  tags: { topic: "feature", status: "done" },
});

/** A different value of the same shape, reaching inside objects. */
function changed(v: unknown): unknown {
  if (typeof v === "string") return `${v}!`;
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  if (v && typeof v === "object") {
    const [k, inner] = Object.entries(v).at(-1)!;
    return { ...v, [k]: changed(inner) };
  }
  return "x";
}

test("every field is either compared or exempt with a reason, never neither", () => {
  const all = Object.keys(full()).sort();
  assert.deepEqual([...COMPARED_FIELDS, ...EXEMPT_FIELDS].sort(), all);
  assert.deepEqual(EXEMPT_FIELDS, ["seenAt"]);
});

test("a change to any compared field, however deep, is a different row", () => {
  for (const k of COMPARED_FIELDS) {
    const a = full();
    const b = { ...full(), [k]: changed(a[k]) } as SessionSummary;
    assert.equal(sameSummary(a, b), false, `a change to ${k} must reach the row`);
    const gone = { ...full() } as Partial<SessionSummary>;
    delete gone[k];
    assert.equal(sameSummary(a, gone as SessionSummary), false, `${k} going absent must reach the row`);
  }
  assert.equal(sameSummary(full(), full()), true);
});

test("the unread dot clears: a row whose unread went away gets a new object (E2E F3)", () => {
  const before = { ...full(), unread: true as const };
  const { unread: _, ...after } = before;
  const [kept] = reuseUnchanged([after as SessionSummary], [before]);
  assert.notEqual(kept, before);
  assert.equal(kept!.unread, undefined);
  const [same] = reuseUnchanged([{ ...before, seenAt: 99 }], [before]);
  assert.equal(same, before, "an exempt field alone keeps the old object");
});
