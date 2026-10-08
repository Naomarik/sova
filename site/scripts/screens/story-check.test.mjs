// node --test site/scripts/screens/story-check.test.mjs — the story check's messages, on broken copies of story.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cutReplies, formatProblems, checkStory, HERE, SCHEMA, STORY } from "./load-story.mjs";
import { KNOWN_KEYWORDS, schemaKeywords } from "./story-check.mjs";

const dir = mkdtempSync(join(tmpdir(), "story-check-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const original = readFileSync(STORY, "utf8");

/** Check a copy of story.json with `edit` applied to its text; the formatted problem lines. */
async function broken(edit, name = "story.json") {
  const text = typeof edit === "function" ? edit(original) : edit;
  assert.notEqual(text, original, "the edit changed nothing");
  const file = join(dir, name);
  writeFileSync(file, text);
  const r = await checkStory(file, { storyDir: HERE, banned: [] });
  return formatProblems(r.problems, file, r.pos);
}
const mutate = (fn) => (src) => {
  const v = JSON.parse(src);
  fn(v);
  return JSON.stringify(v, null, 2);
};

test("the committed story passes", async () => {
  const r = await checkStory(STORY, { banned: [] });
  assert.deepEqual(r.problems, []);
});

test("a syntax error names line and column", async () => {
  const out = await broken((s) => s.replace('"version": 1,', '"version": 1,,'));
  assert.match(out, /^story\.json:3:16 \/: expected a "key" in double quotes, found ","/);
});

test("a trailing comma is called one", async () => {
  const out = await broken((s) => s.replace('"routine": "claude-opus-5-5"', "x").replace('"contextWindow": 200000 }\n  },', '"contextWindow": 200000 },\n  },'));
  assert.match(out, /trailing comma before \}/);
});

test("a duplicate key is refused, with both places", async () => {
  const out = await broken((s) => s.replace('"provider": "demo",', '"provider": "demo",\n  "provider": "other",'));
  assert.match(out, /^story\.json:7:3 \/provider: duplicate key "provider" \(first at line 6:3\)/);
});

test("an unknown key gets a did-you-mean", async () => {
  const out = await broken((s) => s.replace('"script": [\n        { "user": "Cap', '"scirpt": [\n        { "user": "Cap'));
  assert.match(out, /^story\.json:\d+:7 \/sessions\/5\/scirpt: unknown key; did you mean "script"\?/m);
});

test("a step with no action, or two, says what a step takes", async () => {
  const out = await broken((s) => s.replace('{ "read": "src/upload/retry.ts" },\n        { "say": "The delay', '{ "raed": "src/upload/retry.ts" },\n        { "say": "The delay'));
  assert.match(out, /"raed" is not an action; did you mean "read"\? \(a step takes exactly one of: user, say, read/);
  const two = await broken((s) => s.replace('{ "user": "1a" }', '{ "user": "1a", "say": "ok" }'));
  assert.match(two, /a step takes exactly one action, but this one has "user" and "say" \(split it into two steps\)/);
});

test("an enum error lists the allowed values", async () => {
  const out = await broken((s) => s.replace('"viewport": "fold"', '"viewport": "tablet"'));
  assert.match(out, /\/shots\/1\/viewport: "tablet" is not allowed; use one of: "desktop", "compact", "fold", "phone"/);
});

test("a dangling reference is named", async () => {
  const out = await broken((s) => s.replace('{ "spawn": ["cap-delay", "retry-docs", "server-check"] }', '{ "spawn": ["cap-delay", "retry-docs", "server-chek"] }'));
  assert.match(out, /\/sessions\/5\/script\/10\/spawn\/2: unknown worker "server-chek"/);
  const slot = await broken((s) => s.replace('"hero.fold": "hero-fold"', '"hero.fold": "hero-flod"'));
  assert.match(slot, /\/pageShots\/hero\.fold: unknown shot "hero-flod" \(did you mean "hero-fold"\?\)/);
  const hold = await broken((s) => s.replace('"at": "aligned"', '"at": "align"'));
  assert.match(hold, /no hold "align" in retry-policy's script or its workers' \(holds: aligned, delegating, or "end"\)/);
});

test("an edit whose old text isn't in the file says the closest line", async () => {
  const out = await broken((s) => s.replace('"old": "export const MAX_TRIES = 5;"', '"old": "export const MAX_TRIES = 6;"'));
  assert.match(out, /\/workers\/cap-delay\/script\/1\/edit\/old: not found in src\/upload\/retry\.ts \(worktree retry-cap\) \(closest line 3: "export const MAX_TRIES = 5;"\)/);
});

test("a change in no show_changes step is refused, like the tool does", async () => {
  const out = await broken(
    mutate((v) => {
      v.sessions[5].script[13].show_changes.steps.pop();
    }),
  );
  assert.match(out, /\/sessions\/5\/script\/13\/show_changes\/steps: README\.md is changed but in no step/);
});

test("the align tool's own rules apply", async () => {
  const out = await broken(
    mutate((v) => {
      v.sessions[5].script[7].decide.answers = { q2: "30 s" };
    }),
  );
  assert.match(out, /\/sessions\/5\/script\/7\/decide: the align tool would refuse it: .*q2/);
});

test("absolute paths, outside emails, IPs and tailnet names are refused", async () => {
  const out = await broken((s) => s.replace('"Count failed uploads per hour on the dashboard."', '"Read /home/someone/notes.txt, mail ops@corp.io from 100.64.1.2 on box.tail1234.ts.net"'));
  assert.match(out, /contains an absolute path/);
  assert.match(out, /contains an email address outside example\.com/);
  assert.match(out, /contains an IP address/);
  assert.match(out, /contains a tailnet \(\.ts\.net\) name/);
});

test("this machine's names are refused when given", async () => {
  const file = join(dir, "banned.json");
  writeFileSync(file, original.replace("Point the README", "Ask quokkahost about the README"));
  const r = await checkStory(file, { storyDir: HERE, banned: [{ v: "quokkahost", what: "this machine's host name" }] });
  assert.match(formatProblems(r.problems, file, r.pos), /contains this machine's host name \(the story is public/);
});

test("a turn must end in a reply before the next user step", async () => {
  const out = await broken((s) => s.replace('{ "say": "One question before I hand this out." },\n', ""));
  assert.match(out, /\/sessions\/5\/script\/\d+: the reply before this user step ends in a tool call \(a turn ends with a say step\)/);
});

test("every keyword the schema uses is one the validator knows", () => {
  const used = schemaKeywords(JSON.parse(readFileSync(SCHEMA, "utf8")));
  const unknown = [...used].filter((k) => !KNOWN_KEYWORDS.has(k));
  assert.deepEqual(unknown, [], `story-check.mjs doesn't implement: ${unknown.join(", ")}`);
});

test("a script is cut into replies at user steps and tool calls", () => {
  const { replies, users } = cutReplies(
    [{ user: "a" }, { say: "x" }, { read: "f" }, { say: "y" }, { hold: "h1" }, { user: "b" }, { hold: "h2" }, { say: "z" }],
    "/s",
    { storyDir: HERE, workerSpec: () => ({}) },
  );
  assert.deepEqual(
    replies.map((r) => [r.text, r.calls.map((c) => c.name), r.hold ?? null, r.idleHolds ?? null]),
    [
      ["x", ["read"], null, null],
      ["y", [], null, ["h1"]],
      ["z", [], "h2", null],
    ],
  );
  assert.deepEqual(users.map((u) => [u.text, u.afterReply]), [["a", 0], ["b", 2]]);
});

test("check.mjs exits 1 with the problem line on a broken copy", () => {
  const file = join(dir, "cli.json");
  writeFileSync(file, original.replace('"version": 1,', '"version": 2,'));
  let out = "";
  try {
    execFileSync(process.execPath, [join(HERE, "check.mjs"), file], { stdio: "pipe" });
    assert.fail("check.mjs passed a broken story");
  } catch (e) {
    assert.equal(e.status, 1);
    out = String(e.stderr);
  }
  assert.match(out, /^cli\.json:3:14 \/version: must be 1$/m);
});
