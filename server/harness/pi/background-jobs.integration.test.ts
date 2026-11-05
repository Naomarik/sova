// Run: pnpm test:int -- server/harness/pi/background-jobs.integration.test.ts
// A marked bash call runs exactly as the unmarked one (§app.background-jobs/keeping): pi's own bash tool,
// built as Sova builds it (the renice line in front of the user's shell prefix), runs each command once as
// it is and once marked, in bash and in zsh when the machine has it. Everything the prefix set up (an
// alias, a function, a plain variable, a shell option, a cd), the shell itself, the exit code, stderr and
// line numbers must come out the same. And a forked subshell of the call's shell, whose environment
// predates the mark, is still found as the call's.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { withPriorityPrefix } from "../../../pi-config/extensions/subagents/priority.ts";
import { JOB_CALL_ENV, markedCommand, markedPids, realCaptureDeps, realProc, type ProcView } from "../../background-jobs-capture";
import { scratchRoot } from "../../test-scratch";
import { backgroundJobsExtension } from "./background-jobs";

const root = scratchRoot("bgjobs-shell-");
const there = join(root, "there");
mkdirSync(there);

const PREFIX = [
  "shopt -s expand_aliases 2>/dev/null || setopt aliases 2>/dev/null",
  "alias hi='echo alias-ok'",
  "greet() { echo fn-ok; }",
  "plain=var-ok",
  "set -o pipefail",
  `cd ${there}`,
].join("\n");

const COMMANDS = [
  "hi",
  "greet",
  'echo "$plain"',
  "false | true; echo pipe=$?",
  "pwd",
  "echo $0",
  "ps -o comm= -p $$",
  `echo "it's" 'a "quote"' \`echo tick\``,
  "echo to-err >&2; exit 3",
  "echo one\nfoo_not_a_command_zz\necho three",
  "if then fi",
  "cat <<EOF\nheredoc $plain\nEOF",
  "# only a comment",
  "",
];

type Content = { type: "text"; text: string }[];

async function exec(shellPath: string | undefined, command: string): Promise<{ error: boolean; content: Content }> {
  const tool = createBashToolDefinition(root, { commandPrefix: withPriorityPrefix(PREFIX, "renice -n 1 -p $$ >/dev/null 2>&1"), shellPath });
  try {
    const r = await tool.execute("t", { command }, undefined, undefined, undefined as never);
    return { error: !!r.isError, content: r.content as Content };
  } catch (err) {
    return { error: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}
const textOf = (r: { error: boolean; content: Content }) => ({ error: r.error, text: r.content.map((c) => c.text).join("") });

/** pi's bash as it is. */
const run = async (shellPath: string | undefined, command: string) => textOf(await exec(shellPath, command));

/**
 * The same call through the extension, as pi drives it: tool_call on the call's own arguments, the
 * tool, then tool_result. A chat that keeps jobs (a store, a unit prefix), with nothing left to keep.
 */
async function runMarked(shellPath: string | undefined, command: string) {
  const handlers: Record<string, (e: unknown, ctx: unknown) => Promise<unknown>> = {};
  const fakePi = { on: (n: string, f: (e: unknown, ctx: unknown) => Promise<unknown>) => (handlers[n] = f), events: { on() {} } };
  const file = join(root, "chat.jsonl");
  const env = { ...process.env, SOVA_JOBS_UNIT_PREFIX: "sova-job-test-", SOVA_JOBS_DIR: join(root, "jobs"), SOVA_CHAT_PATH: file };
  backgroundJobsExtension(() => ({ ...realCaptureDeps(), env, proc: { ...realProc, pids: () => [] } })).factory(fakePi as never);
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "s1", getSessionFile: () => file } };
  const input = { command };
  await handlers.tool_call!({ toolName: "bash", toolCallId: "c1", input }, ctx);
  assert.notEqual(input.command, command, "the call was marked");
  const r = await exec(shellPath, input.command);
  const patch = (await handlers.tool_result!({ toolName: "bash", toolCallId: "c1", content: r.content, isError: r.error }, ctx)) as { content?: Content } | undefined;
  return textOf({ error: r.error, content: patch?.content ?? r.content });
}

const shells: Array<string | undefined> = [undefined, ...(existsSync("/usr/bin/zsh") ? ["/usr/bin/zsh"] : [])];

describe("background jobs: a marked call runs as the unmarked one", { skip: process.platform !== "linux" }, () => {
  for (const shell of shells) {
    test(`same output, exit code and prefix setup (${shell ?? "pi's default shell"})`, async () => {
      const own = await run(shell, "hi; greet; echo $plain");
      if (!shell) assert.equal(own.text.trim(), "alias-ok\nfn-ok\nvar-ok", "the prefix's setup reaches an unmarked command (the baseline)");
      for (const c of COMMANDS) {
        const plain = await run(shell, c);
        const marked = await runMarked(shell, c);
        assert.deepEqual(marked, plain, `marked ${JSON.stringify(c)}`);
      }
      const seen = await run(shell, markedCommand(`printenv ${JOB_CALL_ENV}`, "0123abcd"));
      assert.equal(seen.text.trim(), "0123abcd", "what the call starts carries its mark");
    });
  }

  test("a forked subshell, whose environment predates the mark, is the call's by its command line", async () => {
    const r = await run(undefined, markedCommand("( sleep 30; true ) >/dev/null 2>&1 & echo $!", "feed0001"));
    const pid = Number(r.text.trim());
    assert.ok(pid > 0, r.text);
    try {
      const env = realProc.environ(pid) ?? [];
      assert.ok(!env.includes(`${JOB_CALL_ENV}=feed0001`), "its /proc environment is the shell's starting one");
      const proc: ProcView = { ...realProc, pids: () => [pid], self: process.pid };
      assert.deepEqual(markedPids("feed0001", proc), [pid]);
      assert.deepEqual(markedPids("feed0002", proc), [], "another call's mark doesn't take it");
    } finally {
      try {
        execFileSync("pkill", ["-P", String(pid)]);
      } catch {}
      try {
        process.kill(pid);
      } catch {}
    }
  });
});
