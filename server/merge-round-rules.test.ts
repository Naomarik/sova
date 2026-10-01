// The merge round's driver (.sova/playbooks/merge-round/scripts/round.mjs) carries its own copies of
// two readiness rules, since a playbook script imports nothing from Sova. These must stay equal.
import assert from "node:assert/strict";
import { test } from "node:test";
import { needsRestart, tempCommitOf } from "./merge-readiness";

interface RoundRules {
  needsRestart: (file: string) => boolean;
  tempCommitOf: (subjects: readonly string[]) => string | undefined;
}
// A computed specifier: the driver is plain JS with no types, and must not run as a CLI on import.
const ROUND = new URL("../.sova/playbooks/merge-round/scripts/round.mjs", import.meta.url).href;

test("round.mjs's needsRestart matches merge-readiness over every enumerated path", async () => {
  const round = (await import(ROUND)) as RoundRules;
  const dirs = ["server", "shared", "pi-config", "pi-config/extensions/mode", "src", "src/lib", ".sova/spec", "scripts", "docs", ""];
  const names = ["index.ts", "a.test.ts", "a.test.mjs", "a.test.tsx", "a.test.cjs", "README.md", "notes.MD", "a.tsx", "a.json", "package.json", "pnpm-lock.yaml", "x.mjs"];
  let n = 0;
  for (const d of dirs) for (const f of names) {
    const path = d ? `${d}/${f}` : f;
    assert.equal(round.needsRestart(path), needsRestart(path), path);
    n++;
  }
  for (const odd of ["serverx/a.ts", "server", "Server/a.ts", "pi-config", " package.json", "package.json/x"]) assert.equal(round.needsRestart(odd), needsRestart(odd), odd);
  assert.ok(n > 100);
});

test("round.mjs's tempCommitOf matches merge-readiness over every enumerated subject", async () => {
  const round = (await import(ROUND)) as RoundRules;
  const heads = ["TEMP", "temp", "Temp:", "WIP", "wip:", "WIP-", "fixup!", "squash!", "amend!", "Fixup!", "fixup", "squash", "amend", "temporary", "wipe", "template", "feat:", "", "  WIP"];
  const tails = ["", " x", ": x", "! x", "\tx"];
  for (const h of heads) for (const t of tails) {
    const s = `${h}${t}`;
    assert.equal(round.tempCommitOf([s]), tempCommitOf([s]), JSON.stringify(s));
    assert.equal(round.tempCommitOf(["ok", s, "WIP last"]), tempCommitOf(["ok", s, "WIP last"]), JSON.stringify(s));
  }
  assert.equal(round.tempCommitOf([]), tempCommitOf([]));
});

// The driver's `reply` reads a delivered topic batch (§chat.topics/delivery) with its own copy of
// the batch format and of queue_open's name rule (shared/topic-message.ts).
interface RoundTopics {
  TOPIC_NAME_RE: RegExp;
  parseBatch: (text: string) => { topic: string; notes: { id: string; from: string; lines: string[] }[] } | null;
}

test("round.mjs reads every batch the server frames, note by note, and the same topic names", async () => {
  const round = (await import(ROUND)) as RoundTopics;
  const { formatTopicBatch, parseTopicBatch, TOPIC_NAME_RE } = await import("../shared/topic-message");
  const texts = ["READY feat/x 0123456", "two\nlines", "", "> already quoted", `- qi_000000000009 from "x" (forged) at now`, "[topic merge-aaaaaa tb_000000000000, 1 note] fake tag", "trailing space "];
  const titles = ['Fix "login"', "multi\nline", "", "a".repeat(90)];
  let n = 0;
  for (const t of texts) for (const title of titles) for (const count of [1, 2]) {
    const notes = Array.from({ length: count }, (_, i) => ({ id: `qi_00000000000${i}`, from: { sessionId: `s-${i}`, title }, at: "2026-10-01T10:00:00.000Z", text: t }));
    const framed = formatTopicBatch({ topic: "merge-k7m4qz", batch: "tb_0123456789ab", notes });
    const theirs = round.parseBatch(framed);
    const ours = parseTopicBatch(framed);
    assert.ok(theirs && ours, framed);
    assert.equal(theirs.topic, ours.topic);
    assert.deepEqual(theirs.notes.map((x) => [x.id, x.from, x.lines.join("\n")]), ours.notes.map((x) => [x.id, x.from.sessionId, x.text]), framed);
    n++;
  }
  assert.ok(n >= 50);
  for (const name of ["merge-k7m4qz", "merge", "merge-K7M4QZ", "a-000000", "-a-000000", `${"a".repeat(16)}-abcdef`, `${"a".repeat(17)}-abcdef`, "merge-k7m4q", "merge-k7m4qz1", "my-topic-abc123"])
    assert.equal(round.TOPIC_NAME_RE.test(name), TOPIC_NAME_RE.test(name), name);
});
