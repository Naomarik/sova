import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARE_TEXT_MAX } from "../../shared/baton";
import { appendTourDraft, prefillTourDraft, TOUR_DRAFT_FULL, TOUR_PREFILL_LINES, TOUR_PREFILL_FAILED, TOUR_PREFILL_NOT_YOUR_TURN, tourPrefillMessage, type TourPrefillDeps } from "./tour-draft";

test("tour Ask/coverage cannot prefill outside the viewer's current turn", () => {
  for (const draft of ["", "Keep this existing question."]) assert.deepEqual(appendTourDraft(draft, "Ask about this step", false), { status: "blocked" });
});
test("tour prefill preserves the controlled draft and never truncates words at the send limit", () => {
  assert.deepEqual(appendTourDraft("Keep my draft.", "About step 2?", true), { status: "ready", draft: "Keep my draft.\n\nAbout step 2?" });
  assert.deepEqual(appendTourDraft("", "About step 2?", true), { status: "ready", draft: "About step 2?" });
  assert.deepEqual(appendTourDraft("x".repeat(SHARE_TEXT_MAX - 2), "About step 2?", true), { status: "full" });
});

/** A composer whose draft is a plain value; the re-check may change it meanwhile (the reader types). */
function composer(initial: string, over: Partial<TourPrefillDeps> & { during?: (set: (v: string) => void) => void } = {}) {
  let value = initial;
  const deps: TourPrefillDeps = {
    canWrite: () => true,
    recheck: async () => { over.during?.((v) => { value = v; }); return { canWrite: true }; },
    draft: () => value,
    ...over,
  };
  return { deps, value: () => value };
}

test("Ask appends the question to an existing note, and to text typed while the turn is re-checked", async () => {
  const kept = composer("Keep my existing note.");
  assert.deepEqual(await prefillTourDraft("About step 2?", kept.deps), { status: "ready", draft: "Keep my existing note.\n\nAbout step 2?" });
  const typed = composer("Keep my existing note.", { during: (set) => set("Keep my existing note. And more.") });
  assert.deepEqual(await prefillTourDraft("About step 2?", typed.deps), { status: "ready", draft: "Keep my existing note. And more.\n\nAbout step 2?" });
});

test("a failed re-check or a lost turn is reported, never a silent no-op, and the draft is byte-identical", async () => {
  const note = "Keep my existing note.";
  const cases: [string, Partial<TourPrefillDeps>, string][] = [
    ["network error", { recheck: () => Promise.reject(new Error("offline")) }, "recheck"],
    ["non-OK answer", { recheck: async () => null }, "recheck"],
    ["turn ended on the re-check", { recheck: async () => ({ canWrite: false }) }, "turn"],
    ["not this reader's turn", { canWrite: () => false }, "turn"],
  ];
  for (const [name, over, reason] of cases) {
    const c = composer(note, over);
    const outcome = await prefillTourDraft("About step 2?", c.deps);
    assert.deepEqual(outcome, { status: "failed", reason }, name);
    assert.equal(tourPrefillMessage(outcome), reason === "turn" ? TOUR_PREFILL_NOT_YOUR_TURN : TOUR_PREFILL_FAILED, `${name}: its own line, never the other one`);
    assert.equal(c.value(), note, `${name}: draft untouched`);
  }
  assert.equal(TOUR_PREFILL_FAILED, "Couldn't add the question. Try again.");
  assert.equal(TOUR_PREFILL_NOT_YOUR_TURN, "It's no longer your turn, so the question wasn't added.");
  const full = composer("x".repeat(SHARE_TEXT_MAX - 2));
  const fullOutcome = await prefillTourDraft("About step 2?", full.deps);
  assert.deepEqual(fullOutcome, { status: "full" }); assert.equal(tourPrefillMessage(fullOutcome), TOUR_DRAFT_FULL);
  assert.equal(tourPrefillMessage(await prefillTourDraft("About step 2?", composer("").deps)), null, "control: an added question shows no error line");
  assert.deepEqual(new Set(TOUR_PREFILL_LINES), new Set([TOUR_PREFILL_FAILED, TOUR_PREFILL_NOT_YOUR_TURN, TOUR_DRAFT_FULL]), "a later added question clears every one of its own lines");
  assert.equal(full.value(), "x".repeat(SHARE_TEXT_MAX - 2));
});
