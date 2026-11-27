// The decision block the Needs you row and the run page share (components/EntryDecision.tsx), rendered: for every
// decision kind and every state that waits from before decisions, the buttons it draws are the entry's answers
// (lib/merge-answers entryAnswers) by their own words, then Answer in Chat when it is answered in words, then Remove
// from Queue. The landing bar's rule (landing-bar.test.ts) trusts exactly this: a screen it links to offers the control.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeDecision, MergeDecisionAction, MergeEntry } from "../../shared/merge-queue";
import { entryAnswers } from "./merge-answers";
import { DECISION_ACTION_LABEL, DECISION_LABEL } from "./merge-standing";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { EntryDecision } = await importSsr(new URL("../components/EntryDecision.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const SHA = "20e78aa".padEnd(40, "0");
const entry = (x: Partial<MergeEntry>): MergeEntry =>
  ({ id: "me_w", project: "prj_a", target: "master", branch: "feat/w", commit: SHA, run: "mr_7", session: "s_w", approval: { by: "land-button", at: "", commit: SHA }, state: "needs-user", runs: [], picks: [], notes: [], createdAt: "", updatedAt: "", ...x }) as MergeEntry;
const html = (e: MergeEntry) => renderToString(() => solid.createComponent(EntryDecision, { projectId: "prj_a", root: "/r/a", target: "master", entry: e })).replaceAll(/<!--[^>]*-->/g, "");
/** Each control's text, in document order: the buttons and the button-styled links. */
const controls = (h: string) => [...h.matchAll(/<(?:button|a)[^>]*class="button[^"]*"[^>]*>([^<]*)<\/(?:button|a)>/g)].map((m) => (m[1] ?? "").trim());

test("the block draws the entry's answers, Answer in Chat when it's answered in words, and Remove from Queue last", () => {
  const KINDS = Object.keys(DECISION_LABEL) as MergeDecision["kind"][];
  const ACTIONS = Object.keys(DECISION_ACTION_LABEL) as MergeDecisionAction[];
  const shapes: Partial<MergeEntry>[] = [
    ...KINDS.flatMap((kind) => [[], ACTIONS].map((actions) => ({ decision: { id: "dc_1", kind, question: `Q about ${kind}?`, choices: kind === "needs-you" ? ["Keep it", "Drop it"] : [], raisedBy: "queue" as const, actions, at: "" } }))),
    { state: "behaviour-differs", conflict: { files: ["a.ts"], verdict: "behaviour-differs", ours: "x", theirs: "y", proposal: "z", commit: SHA } as MergeEntry["conflict"] },
    { state: "unattributed" },
    { state: "drafts-changed" },
  ];
  for (const shape of shapes) {
    const e = entry(shape);
    const h = html(e);
    const got = controls(h);
    const answers = entryAnswers(e).filter((a) => a !== "remove").map((a) => DECISION_ACTION_LABEL[a]);
    const what = e.decision ? `${e.decision.kind} [${e.decision.actions.join(",")}]` : e.state;
    assert.deepEqual(got.slice(0, answers.length), answers, `${what}: its answers, in order`);
    assert.equal(got.at(-1), "Remove from Queue", what);
    assert.ok(got.length - answers.length <= 2, `${what}: nothing but Answer in Chat between: ${got.join(", ")}`);
    if (e.decision) {
      assert.ok(h.includes(e.decision.question), `${what}: its question`);
      assert.ok(h.includes(DECISION_LABEL[e.decision.kind]), `${what}: its words`);
    }
  }
  // Answered in words (choices): Answer in Chat opens its chat; its choices and the held note's line show.
  const words = html(entry({ decision: { id: "dc_2", kind: "needs-you", question: "Which way?", choices: ["Keep it"], heldNote: { request: "rq_1", text: "t" }, raisedBy: "chat", actions: [], at: "" } }));
  assert.deepEqual(controls(words), ["Answer in Chat", "Remove from Queue"]);
  assert.match(words, /href="#\/sid\/s_w"/);
  assert.match(words, /Keep it/);
  assert.match(words, /isn't sent yet/);
  // Nothing to answer here (the merge thread still rules on it): no block at all.
  assert.equal(controls(html(entry({ state: "unattributed", waitingRuling: true }))).length, 0);
});
