// Run: pnpm test -- src/lib/tour-rows.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import type { TourCardDetails } from "../../shared/tour";
import type { LiveTool } from "./live";
import { liveTourCalls, newestTourRows, tourFold, tourLine } from "./tour-rows";

const card = (tourId: string, status: TourCardDetails["status"] = "queued", title = "A look at the app"): TourCardDetails => ({
  v: 1, tourId, title, steps: 4, status, ...(status === "ready" ? { editionId: "ed-1" } : {}),
});

/** A tour call and its result: `card` undefined makes a failed result. */
const tourCall = (id: string, tourId: string | undefined, name = "record_tour", status: TourCardDetails["status"] = "queued"): TranscriptItem[] => [
  { id, kind: "tool-call", text: name, toolCallId: `c-${id}` } as TranscriptItem,
  {
    id: `${id}-r`,
    kind: "tool-result",
    toolCallId: `c-${id}`,
    meta: { type: "message", role: "toolResult", isError: tourId === undefined },
    tool: tourId === undefined ? { output: "Couldn't record." } : { details: card(tourId, status), output: tourLine(card(tourId, status)) },
  } as unknown as TranscriptItem,
];

test("several calls for one tour: only the newest draws the card", () => {
  const items = [...tourCall("look", "demo"), ...tourCall("status", "demo", "record_tour", "dry-run"), ...tourCall("show", "demo", "show_tour", "ready")];
  assert.deepEqual([...newestTourRows(items)], ["show"]);
  const fold = tourFold(items);
  assert.deepEqual([...fold.rows.keys()], ["look", "status", "show"]);
  assert.equal(fold.rows.get("look")?.status, "queued", "an earlier call keeps what it reported then");
});

test("two tours keep two cards", () => {
  const items = [...tourCall("a1", "alpha"), ...tourCall("b1", "beta"), ...tourCall("a2", "alpha")];
  assert.deepEqual([...newestTourRows(items)].sort(), ["a2", "b1"]);
});

test("a failed call never takes or hides the card", () => {
  const items = [...tourCall("ok", "demo"), ...tourCall("bad", undefined)];
  assert.deepEqual([...newestTourRows(items)], ["ok"]);
  assert.equal(tourFold(items).rows.has("bad"), false);
});

test("a tour this run already finished suppresses its settled card; other tours keep theirs", () => {
  const items = [...tourCall("a1", "alpha"), ...tourCall("b1", "beta")];
  assert.deepEqual([...newestTourRows(items, new Set(["alpha"]))], ["b1"]);
});

test("live calls: the newest successful call of each tour, failures and running calls skipped", () => {
  const t = (name: string, status: LiveTool["status"], details?: unknown): LiveTool => ({ name, status, output: "", images: [], details });
  const tools: Record<string, LiveTool> = {
    c1: t("record_tour", "done", card("demo")),
    c2: t("bash", "done"),
    c3: t("record_tour", "done", card("demo", "recording")),
    c4: t("record_tour", "error"),
    c5: t("show_tour", "running"),
    c6: t("show_tour", "done", card("other")),
  };
  assert.deepEqual([...liveTourCalls(tools)], [["demo", "c3"], ["other", "c6"]]);
});

test("the one line reads as the server writes a tour result's output", () => {
  assert.equal(tourLine(card("demo")), "A look at the app · 4 steps · queued");
});
