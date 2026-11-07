// Run: pnpm test -- server/transcript-shell.test.ts. A command the user ran (§chat.shell-mode/card,
// §chat.transcript/transcript-items): pi's bashExecution message, from shell mode or pi's own terminal, is a
// `shell` row with its outcome (exit code, stopped and by what, the cut and where the whole went, `!!`); a
// close marker makes a stopped one "closed"; a wire-1 consumer keeps the plain `$ command` row byte for byte;
// it is never an input; a `!!` one holds no context (§app.subagents-pane/context-tab).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HEntry } from "../shared/harness";
import type { ChatServerMessage, TranscriptItem } from "../shared/protocol";
import { isInput, messageCount } from "../shared/row-counts";
import { conversationTalk, conversationTokens } from "./context-tab";
import { normalizeEntries } from "./transcript";
import { onWire, rowsFor, withRows } from "./wire-rows";

const header = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" };
let n = 0;
const msg = (message: Record<string, unknown>, parentId: string | null = null) => ({ type: "message", id: `e${++n}`, parentId, timestamp: "2026-01-01T00:00:01.000Z", message });
const bash = (o: Record<string, unknown> = {}) =>
  msg({ role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false, timestamp: 1, ...o });
const shellOf = (entries: unknown[]) => normalizeEntries([header, ...entries] as never).filter((r) => r.kind === "shell");

describe("a command's row", () => {
  test("pi's bashExecution is a shell row: the command, the output as saved, the exit code", () => {
    const [row] = shellOf([bash()]);
    assert.equal(row!.text, "$ git status");
    assert.deepEqual(row!.shell, { command: "git status", output: "clean", exitCode: 0 });
  });

  test("stopped: by you, unless a close marker names it; cut: by lines or by bytes, with the whole output's file; `!!`: private", () => {
    const stopped = bash({ exitCode: undefined, cancelled: true });
    const closed = bash({ command: "sleep 60", exitCode: undefined, cancelled: true });
    const marker = { type: "custom", id: `e${++n}`, parentId: closed.id, timestamp: "2026-01-01T00:00:02.000Z", customType: "sova-shell-closed", data: { targetId: closed.id } };
    const lines = Array.from({ length: 2000 }, (_, i) => String(i)).join("\n");
    const byLines = bash({ command: "seq", output: lines, truncated: true, fullOutputPath: "/tmp/pi-bash-1.log" });
    const byBytes = bash({ command: "cat big", output: "x".repeat(51_000), truncated: true, fullOutputPath: "/tmp/pi-bash-2.log" });
    const secret = bash({ command: "env", output: "TOKEN=…", excludeFromContext: true, exitCode: 1 });
    const rows = shellOf([stopped, closed, marker, byLines, byBytes, secret]);
    assert.deepEqual(rows.map((r) => r.shell), [
      { command: "git status", output: "clean", cancelled: true, cancelReason: "user" },
      { command: "sleep 60", output: "clean", cancelled: true, cancelReason: "closed" },
      { command: "seq", output: lines, exitCode: 0, truncated: { by: "lines", max: 2000 }, fullOutputPath: "/tmp/pi-bash-1.log" },
      { command: "cat big", output: "x".repeat(51_000), exitCode: 0, truncated: { by: "bytes", max: 51_200 }, fullOutputPath: "/tmp/pi-bash-2.log" },
      { command: "env", output: "TOKEN=…", exitCode: 1, private: true },
    ]);
    assert.equal(normalizeEntries([header, closed, marker] as never).length, 1, "the marker draws nothing itself");
  });

  test("a wire-1 consumer gets the plain row it always had, byte for byte; wire 2 gets the card's row", () => {
    const entry = bash({ output: "on branch main" });
    const rows = normalizeEntries([header, entry] as never);
    // As the row builder made it before shell rows: an info row, its entry's facts last.
    const legacy = { id: entry.id, kind: "info", text: "$ git status\non branch main", at: entry.timestamp, meta: { type: "message", role: "bashExecution" } };
    const v1 = rowsFor(rows, 1);
    assert.equal(JSON.stringify(v1[0]), JSON.stringify(legacy));
    assert.equal(rowsFor(rows, 2)[0]!.kind, "shell");
    const hello = { type: "hello", items: rows, isStreaming: false, model: null, thinking: "off", context: null } as ChatServerMessage;
    assert.equal(JSON.stringify((withRows(hello, 1) as { items: TranscriptItem[] }).items[0]), JSON.stringify(legacy));
    const append = { type: "append", items: rows } as ChatServerMessage;
    assert.equal(JSON.stringify((onWire(append, 1)[0] as { items: TranscriptItem[] }).items[0]), JSON.stringify(legacy));
    assert.equal(((onWire(append, 2)[0] as { items: TranscriptItem[] }).items[0])!.kind, "shell");
    // Shell mode itself is wire 2's: a wire-1 hello carries no runs and no flag, and no live message reaches it.
    const run = { id: "sh_1", command: "ls", output: "", state: "running" as const, startedAt: 1 };
    const withShell = { ...hello, shell: [run], shellMode: true } as ChatServerMessage;
    assert.deepEqual(Object.keys(withRows(withShell, 1)), Object.keys(hello));
    assert.deepEqual((withRows(withShell, 2) as { shell?: unknown }).shell, [run]);
    assert.deepEqual(onWire({ type: "shell_start", run }, 1), []);
    assert.deepEqual(onWire({ type: "shell_output", id: "sh_1", delta: "x" }, 1), []);
    assert.equal(onWire({ type: "shell_start", run }, 2).length, 1);
    const plain = normalizeEntries([header, msg({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 })] as never);
    assert.equal(rowsFor(plain, 1), plain, "rows without a command: the very array, as before");
  });

  test("a command is never an input, and a `!!` one holds no context", () => {
    const rows = normalizeEntries([header, msg({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }), bash()] as never);
    assert.deepEqual(rows.filter(isInput).map((r) => r.kind), ["user"]);
    assert.equal(messageCount(rows), messageCount(rows.filter((r) => r.kind !== "shell")));
    const h = (o: Partial<Extract<HEntry, { kind: "shell" }>>): HEntry => ({ id: "s", parentId: null, kind: "shell", command: "env", output: "x".repeat(4000), ...o });
    assert.ok(conversationTokens([h({})]) > 900, "a shared command counts");
    assert.equal(conversationTokens([h({ private: true })]), 0, "a `!!` command counts nothing");
    assert.deepEqual(conversationTalk([h({ private: true })]).user, { count: 0, tokens: 0 }, "nor is it one of your messages in the Context tab");
    assert.equal(conversationTalk([h({})]).user.count, 1, "a shared one is");
  });
});
