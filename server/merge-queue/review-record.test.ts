// The review card's state rule (§chat.merge-queue/review-card), checked over every order of events up to a length
// rather than by examples; the same check run on a broken rule must fail, or it proves nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeReviewRecord } from "../../shared/merge-queue";
import { nextReviewState, type ReviewEvent } from "./review-record";

type Rule = typeof nextReviewState;
type Step = Pick<MergeReviewRecord, "state" | "stoppedFor">;

const EVENTS: ReviewEvent[] = [
  { kind: "handed" },
  { kind: "checked" },
  { kind: "checking" },
  { kind: "stopped", why: "a check failed" },
  { kind: "reviewed", verdict: "ok" },
  { kind: "reviewed", verdict: "notes" },
  { kind: "reviewed", verdict: "blocking" },
  { kind: "waiting" },
  { kind: "removed" },
  { kind: "landed" },
];

/** What must hold after each event, whatever came before; the first broken one, or null. */
function broken(rule: Rule, depth: number): string | null {
  const walk = (s: Step, path: string[]): string | null => {
    if (path.length === depth) return null;
    for (const ev of EVENTS) {
      const n = rule(s, ev);
      const at = [...path, ev.kind === "reviewed" ? `reviewed:${ev.verdict}` : ev.kind].join(" → ");
      const final = s.state === "passed" || s.state === "removed";
      if (final && (n.state !== s.state || n.stoppedFor !== s.stoppedFor)) return `${at}: a final card changed`;
      if (!final) {
        if (ev.kind === "removed" && n.state !== "removed") return `${at}: Remove from Queue isn't Removed`;
        if (ev.kind === "waiting" && n.state !== "waiting") return `${at}: a decision isn't Waiting for you`;
        if ((ev.kind === "checked" || ev.kind === "checking") && n.state !== "re-reviewing") return `${at}: checked isn't re-reviewing`;
        // A run that ends before its review never leaves the card re-reviewing, and keeps what sent it back.
        if (ev.kind === "stopped" && s.state === "re-reviewing" && (n.state !== "stopped" || n.stoppedFor !== ev.why)) return `${at}: a stopped run left it ${n.state}`;
        if (ev.kind === "reviewed" && s.state === "re-reviewing" && (ev.verdict === "blocking" ? n.state !== "re-reviewing" : n.state !== "passed")) return `${at}: the re-review's answer read ${n.state}`;
        if (ev.kind === "handed" && s.state === "stopped" && n.state !== "stopped") return `${at}: a Stopped card's own send-back moved it`;
      }
      // Only a run's review passes a card, and only the landing otherwise; only a send-back makes it Fixing.
      if (n.state === "passed" && !final && !(ev.kind === "landed" || (ev.kind === "reviewed" && ev.verdict !== "blocking" && s.state === "re-reviewing"))) return `${at}: passed without a re-review or a landing`;
      if (n.state === "fixing" && s.state !== "fixing" && ev.kind !== "handed") return `${at}: Fixing with no request`;
      if (!!n.stoppedFor !== (n.state === "stopped")) return `${at}: stoppedFor and Stopped disagree`;
      const deeper = walk(n, [...path, at.split(" → ").at(-1)!]);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk({ state: "with-thread" }, []);
}

test("every order of events (up to 6) keeps the review card's state rules", () => {
  assert.equal(broken(nextReviewState, 6), null);
});

test("the same check catches a rule that leaves a stopped run re-reviewing (the run that ended before its review)", () => {
  const leaky: Rule = (s, ev) => (ev.kind === "stopped" ? { state: s.state } : nextReviewState(s, ev));
  assert.match(broken(leaky, 4) ?? "", /a stopped run left it re-reviewing/);
  const reopens: Rule = (s, ev) => (s.state === "passed" && ev.kind === "checking" ? { state: "re-reviewing" } : nextReviewState(s, ev));
  assert.match(broken(reopens, 4) ?? "", /a final card changed/);
});
