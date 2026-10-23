// node --test site/scripts/screens/story-check.test.mjs — the story check's messages, on broken copies of story.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cutReplies, formatProblems, checkStory, HERE, SCHEMA, STORY } from "./load-story.mjs";
import { KNOWN_KEYWORDS, schemaKeywords } from "./story-check.mjs";
import { cueProblems, cuesOf } from "./video-check.mjs";

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
  const out = await broken((s) => s.replace('"contextWindow": 400000 }\n  },', '"contextWindow": 400000 },\n  },'));
  assert.match(out, /trailing comma before \}/);
});

test("a duplicate key is refused, with both places", async () => {
  const out = await broken((s) => s.replace('"provider": "demo",', '"provider": "demo",\n  "provider": "other",'));
  assert.match(out, /^story\.json:7:3 \/provider: duplicate key "provider" \(first at line 6:3\)/);
});

test("an unknown key gets a did-you-mean", async () => {
  const out = await broken((s) => s.replace('"script": [\n        { "user": "Make finalize', '"scirpt": [\n        { "user": "Make finalize'));
  assert.match(out, /^story\.json:\d+:7 \/sessions\/7\/scirpt: unknown key; did you mean "script"\?/m);
});

test("a step with no action, or two, says what a step takes", async () => {
  const out = await broken((s) => s.replace('{ "read": "src/upload/retry.ts" },\n        { "say": "Each wait', '{ "raed": "src/upload/retry.ts" },\n        { "say": "Each wait'));
  assert.match(out, /"raed" is not an action; did you mean "read"\? \(a step takes exactly one of: user, say, read/);
  const two = await broken((s) => s.replace('{ "user": "Count failed uploads per hour on the dashboard." }', '{ "user": "Count failed uploads per hour on the dashboard.", "say": "ok" }'));
  assert.match(two, /a step takes exactly one action, but this one has "user" and "say" \(split it into two steps\)/);
});

test("an enum error lists the allowed values", async () => {
  const out = await broken((s) => s.replace('"view": "workers", "worker": "cap-delay",', '"view": "panes", "worker": "cap-delay",'));
  assert.match(out, /\/shots\/0\/view: "panes" is not allowed; use one of: "chat", "workers", "changes", "sidebar"/);
});

test("a shot names a viewport the story defines", async () => {
  const out = await broken((s) => s.replace('"viewport": "fold"', '"viewport": "flod"'));
  assert.match(out, /\/shots\/1\/viewport: unknown viewport "flod" \(did you mean "fold"\? viewports are: desktop, compact, compact-wide, fold, phone, video\)/);
});

test("a dangling reference is named", async () => {
  const out = await broken((s) => s.replace('{ "spawn": ["cap-delay", "retry-docs", "server-check"] }', '{ "spawn": ["cap-delay", "retry-docs", "server-chek"] }'));
  assert.match(out, /\/sessions\/3\/then\/5\/spawn\/2: unknown worker "server-chek"/);
  const slot = await broken((s) => s.replace('"hero.fold": "hero-fold"', '"hero.fold": "hero-flod"'));
  assert.match(slot, /\/pageShots\/hero\.fold: unknown shot "hero-flod" \(did you mean "hero-fold"\?\)/);
  const hold = await broken((s) => s.replace('"at": "delegating", "viewport": "fold"', '"at": "delegatin", "viewport": "fold"'));
  assert.match(hold, /no hold "delegatin" in retry-backoff's script or its workers' \(holds: decided, delegating, or "end"\)/);
});

test("an edit whose old text isn't in the file says the closest line", async () => {
  const out = await broken((s) => s.replace('"old": "export const MAX_TRIES = 10;"', '"old": "export const MAX_TRIES = 11;"'));
  assert.match(out, /\/workers\/cap-delay\/script\/1\/edit\/old: not found in src\/upload\/retry\.ts \(worktree retry-cap\) \(closest line 3: "export const MAX_TRIES = 10;"\)/);
});

test("a change in no show_changes step is refused, like the tool does", async () => {
  const out = await broken(
    mutate((v) => {
      v.sessions[3].then[8].show_changes.steps.pop();
    }),
  );
  assert.match(out, /\/sessions\/3\/then\/8\/show_changes\/steps: README\.md is changed but in no step/);
});

test("the align tool's own rules apply", async () => {
  const out = await broken(
    mutate((v) => {
      v.sessions[3].then[1].decide.answers = { q2: "30 s" };
    }),
  );
  assert.match(out, /\/sessions\/3\/then\/1\/decide: the align tool would refuse it: .*q2/);
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
  const out = await broken(mutate((v) => v.sessions[3].messages.splice(2, 1)));
  assert.match(out, /\/sessions\/3\/messages\/\d+: the reply before this user step ends in a tool call \(a turn ends with a say step\)/);
});

test("a video hold shorter than its reading time is refused, with the arithmetic", async () => {
  const out = await broken(mutate((v) => (v.videos.desk.beats[3] = { do: "hold", for: "1s", read: "Retry policy is new and waits for your first message" })));
  assert.match(out, /\/videos\/desk\/beats\/3\/for: 1s is under the reading time of "Retry policy is new and waits for your first message" \(4\.0 s: 1 s \+ 0\.3 s for each of its 10 words\)/);
});

test("the pointer may not move before new content has had its 1.5 s", async () => {
  const out = await broken(mutate((v) => v.videos.desk.beats.splice(3, 1)));
  assert.match(out, /\/videos\/desk\/beats\/3: the pointer moves while the reply may still be arriving/);
});

test("a caption of more than 8 words or 48 characters is refused, and the first beat has one", async () => {
  const words = await broken(mutate((v) => (v.videos.desk.beats[0].caption = "Ask the Overseer about all of your past work")));
  assert.match(words, /\/videos\/desk\/beats\/0\/caption: 9 words; a caption has at most 8/);
  const chars = await broken(mutate((v) => (v.videos.desk.beats[0].caption = "Ask the Overseer about extraordinarily long-winded work")));
  assert.match(chars, /\/videos\/desk\/beats\/0\/caption: 55 characters; a caption has at most 48/);
  const first = await broken(mutate((v) => delete v.videos.desk.beats[0].caption));
  assert.match(first, /\/videos\/desk\/beats\/0: the first beat needs a caption/);
});

test("a vis drawing that the app can't parse is refused", async () => {
  const out = await broken((s) => s.replace('"\\"8\\" 64 30"', '"\\"8\\" 64 thirty"'));
  assert.match(out, /\/sessions\/3\/messages\/5\/say: the vis chart drawing doesn't parse: line \d+: /);
});

test("a summary updates only a topic written before it", async () => {
  const out = await broken(mutate((v) => (v.sessions[3].then[10].summary.topics[0].update = "t9")));
  assert.match(out, /\/sessions\/3\/then\/10\/summary\/topics\/0\/update: no topic t9 before this summary \(topics so far: t1, t2\)/);
  const from = await broken(mutate((v) => (v.sessions[3].messages[8].summary.topics[0].from = 2)));
  assert.match(from, /\/sessions\/3\/messages\/8\/summary\/topics\/0\/from: step 2 is not a user step before this summary/);
});

test("the page's cues run from 0 to the end, one per caption, each at least its reading time", () => {
  const v = { beats: [{ do: "hold", caption: "Ask the Overseer about past work" }, { do: "click" }, { do: "release", caption: "Every waiting session, and why it waits", speed: 3 }, { do: "home" }] };
  const timeline = { seconds: 12, beats: [{ i: 0, a: 0.04, b: 3 }, { i: 1, a: 3, b: 5 }, { i: 2, a: 5, b: 6 }, { i: 3, a: 6, b: 11 }], sped: [{ a: 5, b: 5.5, k: 3 }] };
  const c = cuesOf(v, timeline);
  assert.deepEqual(c.cues, [{ a: 0, b: 5, text: "Ask the Overseer about past work" }, { a: 5, b: 12, text: "Every waiting session, and why it waits" }]);
  assert.deepEqual(c.tags, [{ a: 5, b: 7, text: "Sped up 3\u00d7" }]);
  assert.deepEqual(cueProblems(c, v, 12), []);
  const short = cuesOf(v, { ...timeline, beats: timeline.beats.map((b) => (b.i === 2 ? { ...b, a: 1.5 } : b)) });
  assert.match(cueProblems(short, v, 12).join("\n"), /caption "Ask the Overseer about past work" is on the page 1\.50 s, under its 2\.8 s/);
  assert.match(cueProblems({ ...c, cues: [c.cues[1], c.cues[0]] }, v, 12).join("\n"), /are not the story's captions/);
});

test("a typed prompt is at most 90 characters, typed at about 30 a second", async () => {
  const long = await broken(mutate((v) => (v.videos.desk.overseer.script[4].user = `${v.videos.desk.overseer.script[4].user} And which of those can safely wait until after lunch today, or until tomorrow morning?`)));
  assert.match(long, /\/videos\/desk\/beats\/\d+\/step: that prompt is \d+ characters; a typed prompt is at most 90/);
  const slow = await broken(mutate((v) => (v.videos.desk.typing = "80ms")));
  assert.match(slow, /\/videos\/desk\/typing: 80ms a character is not about 30 a second/);
});

test("a video ends by going home, and a tap video never clicks", async () => {
  const home = await broken(mutate((v) => v.videos.desk.beats.pop()));
  assert.match(home, /\/videos\/desk\/beats: the last beat is "home"/);
  const click = await broken(mutate((v) => (v.videos.desk.pointer = "tap")));
  assert.match(click, /\/videos\/desk\/beats\/1\/do: a tap video presses with "tap"/);
});

test("$session: in reply text names a story session", async () => {
  const out = await broken((s) => s.replace("sova://s/$session:retry-backoff", "sova://s/$session:retry-backof"));
  assert.match(out, /\/videos\/desk\/overseer\/script\/6\/say\/2: unknown session "retry-backof"/);
});

test("a hold between a say and a tool call waits after the text, inside that reply", () => {
  const { replies } = cutReplies([{ user: "go" }, { say: "Found it." }, { hold: "found" }, { read: "a.ts" }, { say: "Done." }], "/s", { storyDir: HERE, workerSpec: () => ({}) });
  assert.equal(replies[0].text, "Found it.");
  assert.equal(replies[0].textHold, "found");
  assert.equal(replies[0].calls[0].name, "read");
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
