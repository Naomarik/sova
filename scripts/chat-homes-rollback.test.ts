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

test("a chat whose record names a live process refuses the rollback; a dead one, or one a reboot left behind, doesn't", async () => {
  const agent = join(scratch, "agent2");
  const env = { PI_CODING_AGENT_DIR: agent, SOVA_CHAT_HOMES: join(scratch, "homes2"), SOVA_SHARED_BASE: join(scratch, "shared2"), HOME: scratch };
  // Records without a unit: the unit tier runs no systemctl (the unit check is the lab's).
  const reg = join(agent, "sova", "chats", "registry");
  mkdirSync(reg, { recursive: true });
  const rec = join(reg, "c.json");
  // No socket, but its process answers (the runner itself stands in for a live chat process).
  writeFileSync(rec, JSON.stringify({ chatId: "c", sessionPath: "/s/c.jsonl", pid: process.ppid, sock: join(scratch, "elsewhere", "c.sock") }));
  await assert.rejects(rollback({ noBackup: true, dryRun: true, env, log: () => {} }), /Still running .*a chat process \(c\.json.*pid \d+ alive.*--allow-running/);
  await rollback({ noBackup: true, dryRun: true, allowRunning: true, env, log: () => {} });
  // Left by a reboot: no socket, no unit, no process.
  writeFileSync(rec, JSON.stringify({ chatId: "c", sessionPath: "/s/c.jsonl", pid: 2147483646, sock: join(scratch, "elsewhere", "c.sock") }));
  await rollback({ noBackup: true, dryRun: true, env, log: () => {} });
  // One whose process died (its record carries the death) refuses nothing.
  writeFileSync(rec, JSON.stringify({ chatId: "c", unit: "sova-chat-x-c", sessionPath: "/s/c.jsonl", sock: join(scratch, "elsewhere", "c.sock"), death: { at: "x" } }));
  await rollback({ noBackup: true, dryRun: true, env, log: () => {} });
});

test("a rerun never reports a compressed chat an earlier run restored", async () => {
  const agent = join(scratch, "agent3");
  const homes = join(scratch, "homes3");
  const env = { PI_CODING_AGENT_DIR: agent, SOVA_CHAT_HOMES: homes, SOVA_SHARED_BASE: join(scratch, "shared3"), HOME: scratch };
  mkdirSync(join(agent, "sova"), { recursive: true });
  const dir = join(agent, "sessions", "--w--");
  mkdirSync(dir, { recursive: true });
  const restored = join(dir, "a.jsonl");
  writeFileSync(restored, "{}\n"); // restored by the first run: its .gz is gone
  const store = join(agent, "sova", "compressed-sessions.json");
  writeFileSync(store, JSON.stringify({ v: 1, chats: { a: { id: "a", kind: "files", row: { path: restored }, files: [{ path: restored, gz: `${restored}.gz`, size: 3, sha256: "x" }] }, b: { id: "b", kind: "files", row: { path: join(dir, "b.jsonl") }, files: [{ path: join(dir, "b.jsonl"), gz: join(dir, "b.jsonl.gz"), size: 3, sha256: "x" }] } } }));
  const lines: string[] = [];
  const r = await rollback({ noBackup: true, env, log: (l: string) => lines.push(l) });
  assert.deepEqual(r.problems, [`${join(dir, "b.jsonl.gz")} is missing: chat b can't be uncompressed`], "only the chat really missing");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(store, "utf8")).chats), ["b"], "the restored one left the store");
});

test("after a Chats folder move, the paths a chat's records and words still name in its earlier folder are rewritten too", async () => {
  const agent = join(scratch, "agent-moved");
  const homes = join(scratch, "homes-now");
  const earlier = join(scratch, "homes-before");
  const env = { PI_CODING_AGENT_DIR: agent, SOVA_CHAT_HOMES: homes, SOVA_SHARED_BASE: join(scratch, "shared-moved"), HOME: scratch };
  mkdirSync(join(agent, "sova"), { recursive: true });
  // The marker a Chats folder move wrote: the chats were in `earlier` before.
  writeFileSync(join(agent, "sova", "chat-homes.json"), JSON.stringify({ v: 1, homes, movedFrom: [earlier] }));
  const id = "019a0000-0000-7000-8000-0000000000d1";
  const home = join(homes, id);
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "workers"), { recursive: true });
  mkdirSync(join(home, "chat", "attachments"), { recursive: true });
  writeFileSync(join(home, "home.json"), JSON.stringify({ v: 1, id }));
  writeFileSync(join(home, "chat", "attachments", "a.png"), "png");
  const name = `2026_${id}.jsonl`;
  const helperName = "2026_019a0000-0000-7000-8000-0000000000d2.jsonl";
  // As a compressed chat's archive unpacks, or a conversation's words say: the earlier folder's paths.
  writeFileSync(join(home, "sessions", name), `${JSON.stringify({ type: "session", id, cwd: "/w/p" })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `see ${join(earlier, id, "chat", "attachments", "a.png")}` }] } })}\n`);
  writeFileSync(join(home, "sessions", helperName), `${JSON.stringify({ type: "session", id: "d2", cwd: "/w/p" })}\n`);
  writeFileSync(join(home, "workers", "ag_02.json"), JSON.stringify({ id: "ag_02", state: "ended", path: join(earlier, id, "sessions", helperName), parent: { path: join(earlier, id, "sessions", name) } }));
  await rollback({ noBackup: true, env, log: () => {} });
  const rec = JSON.parse(readFileSync(join(agent, "sova", "chats", "workers", "ag_02.json"), "utf8"));
  assert.equal(rec.path, join(agent, "sessions", "--w-p--", helperName));
  assert.equal(rec.parent.path, join(agent, "sessions", "--w-p--", name));
  const words = readFileSync(join(agent, "sessions", "--w-p--", name), "utf8");
  assert.ok(words.includes(join(agent, "sova", "attachments", id, "a.png")) && !words.includes(earlier), words);
});
