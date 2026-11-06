// Run: pnpm test -- src/lib/reply-draft.browser.test.ts (Solid's reactive build).
// A staged reply is part of the draft (§chat.composer/replying, §chat.composer/behavior "Drafts"):
// the composer's strip and the sidebar's pencil follow it, it is saved with the words, it comes back
// from the server on a reload, and a send clears it. The DOM (the strip, focus, the jump) is driven
// in a real browser against dev:hermetic.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
/** What GET /api/sessions/draft answers, by session path. */
const stored = new Map<string, unknown>();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  if (method === "GET" && url.startsWith("/api/sessions/draft")) {
    const path = decodeURIComponent(url.split("path=")[1] ?? "");
    return new Response(JSON.stringify(stored.get(path) ?? { text: null, attachments: [], reply: null, updatedAt: null }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as typeof fetch;

const solid = await import("solid-js");
const { clearDraft, draftReply, flushDrafts, hasLocalDraft, loadDraft, setDraftReply, setDraftText } = await import("./ui-state");

const reply = { entryId: "a1b2c3d4", role: "assistant" as const, part: false, quote: "the agent's words", trimmed: false };
const puts = () => calls.filter((c) => c.method === "PUT").map((c) => c.body as { path: string; text: string; reply?: unknown });

test("staging is reactive, counts as a draft alone, and is saved with the words", () => {
  const path = "/s/staged.jsonl";
  const seen: (string | null)[] = [];
  const dispose = solid.createRoot((dispose) => {
    solid.createRenderEffect(() => seen.push(draftReply(path)?.entryId ?? null));
    return dispose;
  });
  setDraftReply(path, reply);
  assert.deepEqual(seen, [null, "a1b2c3d4"]);
  assert.equal(hasLocalDraft(path), true, "the sidebar's pencil: a reply alone is a draft");
  setDraftText(path, "why?");
  flushDrafts();
  assert.deepEqual(puts().at(-1), { path, text: "why?", attachments: [], reply });
  dispose();
});

test("Remove Reply and a send each clear it, and the saved draft goes with it", () => {
  const path = "/s/cleared.jsonl";
  setDraftReply(path, reply);
  setDraftReply(path, null);
  assert.equal(draftReply(path), null);
  assert.equal(hasLocalDraft(path), false);
  flushDrafts();
  assert.deepEqual(puts().at(-1), { path, text: "", attachments: [] }, "no reply field: the server deletes the draft");
  setDraftReply(path, reply);
  setDraftText(path, "words");
  clearDraft(path);
  assert.equal(draftReply(path), null, "a send clears the staged reply with the words");
  assert.equal(hasLocalDraft(path), false);
});

test("a reload: the stored draft's reply comes back staged", async () => {
  const path = "/s/reloaded.jsonl";
  stored.set(path, { text: "half typed", attachments: [], reply, updatedAt: "2026-11-01T00:00:00.000Z" });
  const d = await loadDraft(path);
  assert.deepEqual(d.reply, reply);
  assert.deepEqual(draftReply(path), reply);
  assert.equal(d.text, "half typed");
});

test("a stored reply never revives one this tab removed while the load was out, and a malformed one is dropped", async () => {
  const path = "/s/raced.jsonl";
  stored.set(path, { text: "", attachments: [], reply, updatedAt: "2026-11-01T00:00:00.000Z" });
  const load = loadDraft(path);
  setDraftReply(path, null); // Remove Reply before the server answered
  await load;
  assert.equal(draftReply(path), null);
  const bad = "/s/bad.jsonl";
  stored.set(bad, { text: "x", attachments: [], reply: { ...reply, entryId: "not an id" }, updatedAt: null });
  assert.equal((await loadDraft(bad)).reply, null);
  assert.equal(draftReply(bad), null);
});
