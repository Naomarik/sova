// The chat homes rollback (scripts/chat-homes/rollback.mjs): a run cut short after its moves, run
// again, still rewrites every path that named the home. A throwaway agent dir, homes and shared base.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error plain JS, no types
import { rollback } from "./chat-homes/rollback.mjs";

const scratch = mkdtempSync(join(tmpdir(), "sova-rollback-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("a rollback cut short after its moves, run again, points the worker records at the moved conversations", async () => {
  const agent = join(scratch, "agent");
  const homes = join(scratch, "homes");
  const env = { PI_CODING_AGENT_DIR: agent, SOVA_CHAT_HOMES: homes, SOVA_SHARED_BASE: join(scratch, "shared"), HOME: scratch };
  mkdirSync(join(agent, "sova"), { recursive: true });
  const id = "019a0000-0000-7000-8000-0000000000c1";
  const home = join(homes, id);
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "workers"), { recursive: true });
  writeFileSync(join(home, "home.json"), JSON.stringify({ v: 1, id }));
  const lead = join(home, "sessions", `2026_${id}.jsonl`);
  const helper = join(home, "sessions", "2026_019a0000-0000-7000-8000-0000000000c2.jsonl");
  writeFileSync(lead, `${JSON.stringify({ type: "session", id, cwd: "/w/proj" })}\n`);
  writeFileSync(helper, `${JSON.stringify({ type: "session", id: "c2", cwd: "/w/proj/.worktrees/x" })}\n`);
  writeFileSync(join(home, "workers", "ag_01.json"), JSON.stringify({ id: "ag_01", state: "ended", path: helper, parent: { path: lead } }));
  const quiet = () => {};
  await assert.rejects(
    rollback({ noBackup: true, env, log: quiet, hooks: { afterMoves: () => { throw new Error("cut short"); } } }),
    /cut short/,
  );
  assert.ok(!existsSync(lead), "the first run moved the conversations");
  await rollback({ noBackup: true, env, log: quiet });
  const rec = JSON.parse(readFileSync(join(agent, "sova", "chats", "workers", "ag_01.json"), "utf8"));
  assert.equal(rec.path, join(agent, "sessions", "--w-proj-.worktrees-x--", "2026_019a0000-0000-7000-8000-0000000000c2.jsonl"));
  assert.equal(rec.parent.path, join(agent, "sessions", "--w-proj--", `2026_${id}.jsonl`));
  assert.ok(existsSync(join(homes, ".rolled-back", id)), "the emptied home is kept aside");
  assert.ok(!existsSync(join(homes, ".rollback-journal.json")), "the journal is retired");
});
