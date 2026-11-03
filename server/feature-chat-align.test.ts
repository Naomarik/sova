// Run: pnpm test -- server/feature-chat-align.test.ts. Pure: no files. A feature request chat's served `align`
// (§app.project-assistant/feature-chats): no technical notes, no file import, no status or exemption; visuals on.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HEntry, ToolCtx } from "../shared/harness";
import { carriesTechnical, FEATURE_ALIGN_OPS, FEATURE_ALIGN_PARAMETERS, featureAlignTool, plansOf } from "./feature-chat-align";

const run = async (branch: HEntry[], params: unknown) => {
  const tool = featureAlignTool(() => branch);
  const ctx = { branch: () => branch, sessionId: "s1" } as unknown as ToolCtx;
  return (tool.execute as (...a: unknown[]) => Promise<{ content: { text: string }[]; details: { doc?: { id: string; technical?: unknown; questions: { visual?: unknown }[]; style?: string } } }>)("tc1", params, undefined, undefined, ctx);
};
const create = (extra: Record<string, unknown> = {}) => ({
  ops: [{ op: "create", title: "Online booking", summary: "Book from the site.", questions: [{ topic: "Who", ask: "Who can book?", options: [{ label: "Anyone", tradeoff: "More." }], recommendation: { choice: "Anyone", why: "Simple." }, visual: { kind: "wireframe", source: 'screen "Book"' } }], ...extra }],
});

test("a plan is created with its drawing, in the Project manager style, and folds back from the branch", async () => {
  const out = await run([], create());
  assert.equal(out.details.doc?.id, "al_1");
  assert.equal(out.details.doc?.style, "pm");
  assert.deepEqual(out.details.doc?.questions[0]?.visual, { kind: "wireframe", source: 'screen "Book"' });
  const branch = [{ kind: "tool-result", id: "r1", callId: "tc1", tool: "align", isError: false, details: out.details, blocks: [] } as unknown as HEntry];
  assert.deepEqual(plansOf(branch).map((d) => d.id), ["al_1"]);
});

test("a technical note is refused wherever it is, and nothing is changed", async () => {
  await assert.rejects(run([], create({ technical: ["server/x.ts"] })), /Plans here have no technical notes.*Nothing was changed/);
  assert.equal(carriesTechnical({ ops: [{ op: "add", technical: ["x"] }] }), true);
  assert.equal(carriesTechnical({ ops: [{ op: "edit", id: "t1", text: "x" }] }), true);
  assert.equal(carriesTechnical({ ops: [{ op: "remove", ids: ["t2"] }] }), true);
  assert.equal(carriesTechnical(create()), false);
  // Not in the schema either.
  assert.ok(!JSON.stringify(FEATURE_ALIGN_PARAMETERS).includes('"technical"'));
});

test("no import (no files here), no status (nothing is built here), no exemption, no review", async () => {
  for (const op of ["import", "status", "exempt", "review", "close_blocker"]) {
    assert.ok(!(FEATURE_ALIGN_OPS as readonly string[]).includes(op), op);
    await assert.rejects(run([], { ops: [{ op, path: "/etc/passwd", to: "implementing", reason: "x" }] }), /is not available here/, op);
  }
  assert.ok(!JSON.stringify(FEATURE_ALIGN_PARAMETERS).includes('"import"'));
});
