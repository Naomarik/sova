// Run: pnpm exec tsx --test src/lib/baton-told.test.ts. The strip's Started by line and What It's Told's
// markdown (§app.baton/told), for every starter kind and every prompt state.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatonStarted, BatonTold } from "../../shared/baton";
import { startedLine, starterHref, starterName, toldMarkdown, whyText } from "./baton-told";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const at = "2026-09-30T11:55:00.000Z";
const you: BatonStarted = { who: "operator", at };
const po: BatonStarted = { who: "project-overseer", at, why: "Nobody said who hosts it.", overseer: { id: "c1", current: true } };
const via: BatonStarted = { who: "overseer", at, why: "You asked me to.", overseer: { id: "o1", current: false } };

const doc = (over: Partial<BatonTold> = {}): BatonTold => ({
  publicTitle: "Hosting",
  orgId: "org_1",
  projectId: "prj_1",
  projectName: "Portal",
  started: po,
  goal: "Who hosts the portal\nand where.",
  prompt: { kind: "recorded", text: "PREAMBLE with ``` inside", at, changes: 2 },
  tools: [{ name: "read_link", description: "Open a page.", parameters: { type: "object" }, ability: "Read links" }],
  inactive: [{ name: "write_profile_updates", when: "only during the wrap-up" }],
  model: "zai/glm-5.3",
  thinking: "low",
  budget: { messagesMax: 60, messagesUsed: 3 },
  ...over,
});

test("the strip's line names each starter, with when", () => {
  assert.equal(startedLine(you, "Portal", NOW), "Started by you · 5m ago");
  assert.equal(startedLine(po, "Portal", NOW), "Started by the Portal overseer · 5m ago");
  assert.equal(startedLine(via, "Portal", NOW), "Started by you, via the Overseer · 5m ago");
  assert.equal(starterName(po, ""), "the project's overseer");
});

test("the overseer part links to that overseer, never to the operator", () => {
  assert.equal(starterHref(you, "prj_1"), null);
  assert.equal(starterHref(po, "prj_1"), "#/projects/prj_1/overseer");
  assert.equal(starterHref(via, "prj_1"), "#/overseer/h/o1", "an earlier conversation, read-only");
  assert.equal(starterHref({ ...via, overseer: { id: "o1", current: true } }, "prj_1"), "#/overseer");
  assert.equal(starterHref({ who: "overseer" }, "prj_1"), null, "no conversation recorded: no link, none guessed");
});

test("the why as written, else what is known", () => {
  assert.equal(whyText(po), "Nobody said who hosts it.");
  assert.equal(whyText(you), "Not recorded: you started it.");
  assert.equal(whyText({ who: "project-overseer" }), "Not recorded.");
});

test("What It's Told: who, why, goal, the recorded prompt, tools, model, and the closing line", () => {
  const md = toldMarkdown(doc(), NOW);
  const sections = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(sections, ["Started by", "Why", "Goal", "Prompt", "Tools", "Model"]);
  assert.match(md, /Started by \[the Portal overseer\]\(#\/projects\/prj_1\/overseer\) · .+ \(5m ago\)\./);
  assert.match(md, /^> Nobody said who hosts it\. {2}$/m);
  assert.match(md, /^> Who hosts the portal {2}\n> and where\. {2}$/m, "the goal's line breaks kept");
  assert.match(md, /Last changed .+, sent with every reply since\./);
  assert.match(md, /````text\nPREAMBLE with ``` inside\n````/, "a fence the prompt can't close");
  assert.match(md, /### `read_link`\n\nOpen a page\.\n\nTurned on by \*\*Read links\*\*\./);
  assert.match(md, /Not active now: `write_profile_updates` \(only during the wrap-up\)\./);
  assert.match(md, /`zai\/glm-5\.3`, thinking low\./);
  assert.match(md, /Message limit: 3 of 60 used\./);
  assert.ok(md.trimEnd().endsWith("Only you see this. It's never on their page."));
  assert.doesNotMatch(md, /Not sent yet|Wrap-up prompt/);
});

test("before the first reply: the preview, labelled; after the wrap-up: its prompt apart", () => {
  const preview = toldMarkdown(doc({ prompt: { kind: "preview", text: "RENDERED" } }), NOW);
  assert.match(preview, /\*\*Not sent yet: what the next reply would get\.\*\*\n\n```text\nRENDERED\n```/);
  assert.doesNotMatch(preview, /Last changed/);
  const wrapped = toldMarkdown(doc({ wrapup: { text: "WRAP", at } }), NOW);
  assert.match(wrapped, /## Wrap-up prompt\n\nSent .+, for the wrap-up only\.\n\n```text\nWRAP\n```/);
});

test("what it was started for, and what isn't recorded", () => {
  const of = (over: Partial<BatonTold>) => toldMarkdown(doc(over), NOW);
  assert.match(of({ startedFor: { kind: "gap", id: "§gap/payday", title: "Nobody decided the pay day" } }), /For the gap `§gap\/payday`: Nobody decided the pay day\./);
  assert.match(of({ startedFor: { kind: "conflict", area: "hosting" } }), /To settle a conflict about hosting\./);
  assert.match(of({ startedFor: { kind: "parent", sessionId: "s1", title: "Budget [draft]" } }), /From the session \[Budget \\\[draft\\\]\]\(sova:\/\/s\/s1\)\./);
  assert.match(of({ startedFor: { kind: "todo", text: "Ask Tony" } }), /From the to-do: Ask Tony\./);
  const mine = of({ started: you, model: null, thinking: null, tools: [], inactive: [] });
  assert.match(mine, /Started by you · /);
  assert.match(mine, /## Why\n\nNot recorded: you started it\./);
  assert.match(mine, /The new-session default\./);
  assert.match(of({ started: { who: "project-overseer", at } }), /## Why\n\nNot recorded\./);
});
