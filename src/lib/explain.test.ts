import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExplanationInfo, TranscriptItem } from "../../shared/protocol";
import { appendItems, explainCaption, explainState, galleryTitle, newestFirst } from "./explain";

const at = (id: string, createdAt: string): ExplanationInfo => ({
  id,
  topic: id,
  summary: "",
  createdAt,
  parentSessionId: "s",
});

test("newestFirst sorts by createdAt, newest first, without mutating", () => {
  const list = [at("a", "2026-09-01T00:00:00Z"), at("b", "2026-09-20T00:00:00Z"), at("c", "2026-09-10T00:00:00Z")];
  assert.deepEqual(newestFirst(list).map((e) => e.id), ["b", "c", "a"]);
  assert.deepEqual(list.map((e) => e.id), ["a", "b", "c"]);
});

test("galleryTitle counts and scopes", () => {
  assert.equal(galleryTitle(1, "session"), "1 explanation from this session");
  assert.equal(galleryTitle(3, "session"), "3 explanations from this session");
  assert.equal(galleryTitle(0, "all"), "0 explanations across all sessions");
});

test("explainState: fatal error beats an advisory note, which beats a clean run", () => {
  const base = at("x", "2026-09-20T00:00:00Z");
  assert.equal(explainState(base), "ok");
  assert.equal(explainState({ ...base, note: "The worker was killed after writing the page." }), "noted");
  assert.equal(explainState({ ...base, error: "The explainer wrote no page." }), "failed");
  // Both set: nothing may link to a page that isn't there.
  assert.equal(explainState({ ...base, error: "No page.", note: "Aborted." }), "failed");
});

test("explainState: a running entry reads as running, whatever else it carries", () => {
  const base = at("x", "2026-09-20T00:00:00Z");
  assert.equal(explainState({ ...base, status: "running" }), "running");
  assert.equal(explainState({ ...base, status: "running", error: "No page.", note: "Aborted." }), "running");
});

const row = (id: string): TranscriptItem => ({ id, kind: "info", text: id, raw: null });
const explainRow = (entry: string, explainId: string, status?: "running"): TranscriptItem => ({
  id: entry,
  kind: "info",
  raw: null,
  report: { source: "explain-doc", body: "", preview: "", truncated: false, explain: { ...at(explainId, "2026-09-20T00:00:00Z"), ...(status ? { status } : {}) } },
});
const ids = (list: TranscriptItem[]) => list.map((i) => i.id);

test("appendItems: rows without an explain id append, as before", () => {
  const list = [row("a"), row("b")];
  const next = appendItems(list, [row("c"), row("d")]);
  assert.deepEqual(ids(next), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(list), ["a", "b"], "the old list is not mutated");
});

test("appendItems: a finished explain row replaces its running row in place", () => {
  const next = appendItems([row("a"), explainRow("e1", "x", "running"), row("b")], [explainRow("e2", "x")]);
  assert.deepEqual(ids(next), ["a", "e2", "b"]);
  assert.equal(explainState(next[1]!.report!.explain!), "ok");
});

test("appendItems: an explain row with no match appends; a batch can carry several", () => {
  const list = [explainRow("r1", "x", "running"), row("a"), explainRow("r2", "y", "running")];
  const next = appendItems(list, [explainRow("f2", "y"), row("b"), explainRow("r3", "z", "running"), explainRow("f1", "x"), explainRow("f3", "z")]);
  assert.deepEqual(ids(next), ["f1", "a", "f2", "b", "f3"], "z's running row, appended in this batch, is replaced by its finished one");
});

test("explainCaption reads '<when> · <model>', dropping the provider and an absent model", () => {
  const now = Date.parse("2026-09-20T12:00:00Z");
  const createdAt = "2026-09-20T10:00:00Z";
  assert.equal(explainCaption({ createdAt, model: "zai/glm-5.3" }, now), "2h ago · glm-5.3");
  assert.equal(explainCaption({ createdAt, model: "claude-opus-5" }, now), "2h ago · claude-opus-5", "an id with no provider is left alone");
  assert.equal(explainCaption({ createdAt }, now), "2h ago", "no model, no separator");
  assert.equal(explainCaption({ createdAt, model: "" }, now), "2h ago", "an empty model reads as absent");
});

