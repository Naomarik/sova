// Where the real-session parity gate samples from: a hermetic .agent only when marked a copy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { paritySource } from "./sessions-index-real-source.test.helper";

const root = mkdtempSync(join(tmpdir(), "sova-parity-source-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A checkout whose .agent holds `sessions` session files, marked a copy or not. */
function checkout(name: string, sessions: number, marked: boolean): string {
  const repo = join(root, name);
  const agent = join(repo, ".agent");
  mkdirSync(join(agent, "sessions", "--home-x--"), { recursive: true });
  for (let i = 0; i < sessions; i++) writeFileSync(join(agent, "sessions", "--home-x--", `s${i}.jsonl`), "{}\n");
  if (marked) writeFileSync(join(agent, "copied-sessions.json"), JSON.stringify({ sessions: [] }));
  return repo;
}

const SKIP = { kind: "skip", reason: "no copy of the real chats here, nothing checked" };

test("a hermetic .agent with no sessions and no marker: skipped, saying why", () => {
  assert.deepEqual(paritySource(checkout("empty", 0, false)), SKIP);
});

test("a hermetic .agent with its own sessions but no copied-sessions.json: skipped, never sampled", () => {
  assert.deepEqual(paritySource(checkout("own-chats", 3, false)), SKIP);
});

test("a hermetic .agent marked a copy, with sessions: sampled, its sova/ stores beside them", () => {
  const repo = checkout("copied", 3, true);
  assert.deepEqual(paritySource(repo), { kind: "sample", sessionsRoot: join(repo, ".agent", "sessions"), source: join(repo, ".agent") });
});

test("a .tmp/verifier/real-source pointer is taken with no marker (a sessions folder itself)", () => {
  const repo = checkout("pointer", 0, false);
  const named = join(root, "bench-sessions");
  mkdirSync(named, { recursive: true });
  mkdirSync(join(repo, ".tmp", "verifier"), { recursive: true });
  writeFileSync(join(repo, ".tmp", "verifier", "real-source"), `${named}\n`);
  assert.deepEqual(paritySource(repo), { kind: "sample", sessionsRoot: named, source: root });
});
