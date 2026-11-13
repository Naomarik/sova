// Run: pnpm test -- server/modes/engine-review.test.ts. Adversarial review behind the `adversarial-review` flag
// (§chat.alignment-review) on Sova's mode engine, on a fake pi host (tests/engine-host.fixture.ts); no model.
// Flag off: the align tool's declaration and the mode prompts equal the ones from before the feature
// (tests/fixtures/align-flag-off-master.json, generated from master 043816d4), no /review, no review op. Flag on: the
// review form of the tool and /review register at session_start, once; the reviewer comes from the chat's subagent
// profile; the ops run end to end.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const { agentDir, fakePi } = await import("./tests/engine-host.fixture");
type Tool = import("./tests/engine-host.fixture").Tool;
const { REVIEW_FLAG } = await import("./engine");
const { composePrompt, DEFAULT_ROUTES } = await import("../../pi-config/extensions/mode/prompt.ts");

const fixture = JSON.parse(readFileSync(new URL("./tests/fixtures/align-flag-off-master.json", import.meta.url), "utf8")) as { prompt: Record<string, string | null>; tool: unknown };
const declaration = (t: Tool) =>
  JSON.parse(JSON.stringify({ name: t.name, label: t.label, description: t.description, promptSnippet: t.promptSnippet, promptGuidelines: t.promptGuidelines, parameters: t.parameters, executionMode: t.executionMode }));

test("flag off: the mode prompts and the align tool are as before the feature; no /review, no review op", async () => {
  for (const [key, text] of Object.entries(fixture.prompt)) {
    const [mode, minors] = key.split("+");
    assert.equal(composePrompt({ mode: mode as never, strict: false, minorModes: (minors ? minors.split(",") : []) as never }, DEFAULT_ROUTES, null) ?? null, text, `mode prompt ${key} unchanged`);
  }
  const off = fakePi([]);
  await off.start();
  assert.deepEqual(off.registrations.filter((n) => n === "align"), ["align"], "registered once, never re-registered");
  assert.deepEqual(declaration(off.tools.get("align")!), fixture.tool, "align tool declaration byte-identical to before");
  assert.ok(!off.commands.has("review"), "/review not registered");
  await off.mode("align on");
  const align = off.tools.get("align")!;
  const created = await align.execute("c1", { ops: [{ op: "create", title: "T", summary: "S." }] }, undefined, undefined, off.ctx);
  assert.equal((created.details as { doc: { review?: unknown } }).doc.review, undefined);
  await assert.rejects(
    align.execute("c2", { ops: [{ op: "review", phase: "plan", state: "running", reason: "r" }] }, undefined, undefined, off.ctx),
    /ops\[0\]\.op must be one of create, import, add, edit, edit_question, edit_rejected, edit_doc, remove, decide, accept, accept_all, reopen, drop_question, drop_alignment, status, exempt, change_request, get\. Nothing was changed\./,
  );
});

test("flag on: the review form and /review at session_start, the reviewer from the chat's profile, the ops end to end", async () => {
  const route = { primary: { backend: "pi", model: "fake/sol", effort: "high" }, fallback: { backend: "claude-code", model: "claude-opus-5-5", effort: "high" } };
  const profile = (id: string, reviewer?: unknown) => ({
    id,
    name: id,
    delegate: Object.fromEntries(["planning", "investigation", "routine", "complex"].map((k) => [k, { primary: { backend: "claude-code", model: "claude-opus-5-5", effort: "high" }, fallback: null }])),
    teams: null,
    members: null,
    specWriter: null,
    ...(reviewer === undefined ? {} : { reviewer }),
  });
  const profilesFile = join(agentDir, "subagent-profiles.json");
  const defaultFile = join(agentDir, "subagent-profiles-default.json");
  writeFileSync(profilesFile, JSON.stringify({ version: 1, profiles: [profile("with-reviewer", route), profile("none", null), profile("old")] }));
  writeFileSync(defaultFile, JSON.stringify({ version: 1, default: "with-reviewer" }));

  const on = fakePi([], { flags: { [REVIEW_FLAG]: true as never } });
  assert.deepEqual(declaration(on.tools.get("align")!), fixture.tool, "before session_start the flag is not visible: the flag-off tool");
  await on.start("startup");
  assert.deepEqual(on.registrations.filter((n) => n === "align"), ["align", "align"], "re-registered once with the review form");
  await on.start("new");
  assert.equal(on.registrations.filter((n) => n === "align").length, 2, "and only once per process");
  const tool = on.tools.get("align")!;
  const ops = (tool.parameters as { properties: { ops: { items: { anyOf: { properties: { op: { const: string } } }[] } } } }).properties.ops.items.anyOf.map((b) => b.properties.op.const);
  assert.deepEqual(ops.slice(-2), ["review", "close_blocker"]);
  assert.match(tool.description as string, /Adversarial review \(op review, at most once per phase per alignment\)/);
  assert.ok((tool.description as string).startsWith((fixture.tool as { description: string }).description), "the flag-off text is kept, the rules appended");
  assert.match((tool.promptGuidelines as string[]).at(-1)!, /^Adversarial review \(align review op\)/);
  const review = on.commands.get("review");
  assert.ok(review, "/review registered");

  // /review needs align on, then sends the card's message.
  await review!.handler("plan", on.ctx);
  assert.match(on.notes.at(-1)!.text, /needs the align minor mode on/);
  await on.mode("align on");
  await review!.handler("plan", on.ctx);
  assert.match(on.notes.at(-1)!.text, /No open alignment to review/);
  const exec = (params: unknown) => tool.execute("x", params, undefined, undefined, on.ctx) as Promise<{ content: { text: string }[]; details: { doc: { phase: string; review: { plan: { model: string } } } } }>;
  await exec({ ops: [{ op: "create", title: "Queue", summary: "Persist the queue.", approach: ["Write it to disk"] }] });
  // "implementation" is the user's word for the diff phase; the message's phase token is always the id.
  const implMessage = { text: "al_1: run the adversarial implementation review now (align review, phase diff), whatever the rule says.", options: undefined };
  await review!.handler("implementation", on.ctx);
  assert.deepEqual(on.userMessages.at(-1), implMessage);
  await review!.handler("diff al_1", on.ctx);
  assert.deepEqual(on.userMessages.at(-1), implMessage, "/review diff keeps working");
  assert.deepEqual(review!.getArgumentCompletions!("")!.map((i) => i.value), ["plan", "implementation"]);
  await review!.handler("bogus", on.ctx);
  assert.match(on.notes.at(-1)!.text, /^Usage: \/review plan\|implementation \[al_N\]$/);

  // The reviewer is the profile's: primary unverified (never probed) is used, its fallback offered for a retry.
  const started = await exec({ ops: [{ op: "review", phase: "plan", state: "running", reason: "persistence format" }] });
  assert.equal(started.details.doc.review.plan.model, "pi · fake/sol · high");
  assert.match(started.content[0]!.text, /backend "pi", model "fake\/sol", effort "high", tools \["read","grep","find","ls"\]/);
  assert.match(started.content[0]!.text, /retry once with backend "claude-code", model "claude-opus-5-5"/);
  await assert.rejects(exec({ ops: [{ op: "status", to: "implementing" }] }), /plan review is running/);
  await exec({ ops: [{ op: "add", findings: ["Review (plan, fake/sol): the reload path loses the tail"] }, { op: "review", phase: "plan", state: "clear", reason: "1 constraint added" }] });
  await assert.rejects(exec({ ops: [{ op: "review", phase: "plan", state: "running", reason: "again" }] }), /no second round/);
  await exec({ ops: [{ op: "status", to: "implementing" }] });
  await exec({ ops: [{ op: "review", phase: "diff", state: "running", reason: "persistence" }] });
  await exec({ ops: [{ op: "review", phase: "diff", state: "blocking", reason: "1 blocking", blockers: [{ title: "reload drops the tail", check: "node --test q.test.ts" }] }] });
  await assert.rejects(exec({ ops: [{ op: "status", to: "done" }] }), /1 open blocker \(diff b1\)/);
  const done = await exec({ ops: [{ op: "close_blocker", phase: "diff", id: "b1", by: "check", evidence: "node --test q.test.ts passes" }, { op: "status", to: "done" }] });
  assert.equal(done.details.doc.phase, "done");

  // A profile with Reviewer None, and an older profile without the key: no reviewer, the start is refused.
  for (const pick of ["none", "old"]) {
    writeFileSync(defaultFile, JSON.stringify({ version: 1, default: pick }));
    await exec({ ops: [{ op: "create", title: `Other ${pick}`, summary: "S." }] });
    await assert.rejects(exec({ ops: [{ op: "review", phase: "plan", state: "running", reason: "r" }] }), /names no reviewer \(Reviewer: None\)/);
    await exec({ ops: [{ op: "drop_alignment", reason: "test" }] });
  }
  assert.equal(JSON.parse(readFileSync(profilesFile, "utf8")).profiles[2].reviewer, undefined, "nothing was written to the profiles");
});
