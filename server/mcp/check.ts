// A Check: in a short-lived process of its own, in the clean environment, of an approved server
// only. Its record is what chats list. Sign In is the same child, kept open while the person
// signs in.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { agentRoot } from "../state-root";
import { readyToRun, type McpReady } from "./resolve";
import { withoutSecrets } from "./secrets";
import { saveCheck, saveFailedCheck, type McpCheckRecord } from "./store";
import { cleanMcpEnv } from "./transport";
import type { McpOwner } from "./trust";
import type { CheckAnswer, CheckJob } from "./check-child";

const CHILD = fileURLToPath(new URL("./check-child.ts", import.meta.url));
const CHECK_MS = 90_000;
const ERROR_LINES = 20;

const running = new Map<string, Promise<void>>();
const key = (owner: McpOwner, name: string) => `${owner.kind === "computer" ? "c" : owner.checkout}\0${name}`;
export const isChecking = (owner: McpOwner, name: string): boolean => running.has(key(owner, name));

/** The child: not in a repository's folder (Bun reads a folder's .env), holding only the basics and the agent dir. */
export function spawnCheckChild(job: Omit<CheckJob, "timeoutMs"> & { timeoutMs?: number }) {
  const child = spawn(process.execPath, [...process.execArgv, CHILD], {
    cwd: tmpdir(),
    env: cleanMcpEnv(process.env, { PI_CODING_AGENT_DIR: agentRoot() }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify(job)}\n`);
  return child;
}

function run(job: CheckJob): Promise<CheckAnswer> {
  return new Promise((done) => {
    const child = spawnCheckChild(job);
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CHECK_MS);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString("utf8")).slice(-2_000)));
    child.on("error", (e) => done({ ok: false, errors: [e.message] }));
    child.on("close", () => {
      clearTimeout(timer);
      const last = out.trim().split("\n").pop() ?? "";
      try {
        done(JSON.parse(last) as CheckAnswer);
      } catch {
        done({ ok: false, errors: [err.trim() || "the Check stopped before it finished"] });
      }
    });
  });
}

export interface McpChecker {
  (ready: Extract<McpReady, { ok: true }>, cwd: string): Promise<CheckAnswer>;
}
const childCheck: McpChecker = (ready, cwd) => run({ action: "check", entry: ready.entry, cwd, timeoutMs: 30_000 });

const linesOf = (errors: string[], values: readonly string[]) =>
  errors.flatMap((e) => withoutSecrets(e, values).split("\n")).map((l) => l.trimEnd()).filter(Boolean).slice(-ERROR_LINES);

/**
 * Check one server and record what it found. Never runs a server that isn't approved as it stands now. A server
 * with an unsaved secret fails here and says which. Two Checks of one server join.
 */
export function checkServer(owner: McpOwner, name: string, check: McpChecker = childCheck): Promise<void> {
  const k = key(owner, name);
  const joined = running.get(k);
  if (joined) return joined;
  const task = (async () => {
    const ready = readyToRun(owner, name);
    if (!ready.ok) {
      if (ready.how === "changed") return;
      const { versionOf } = await import("./fingerprint");
      const { baseOf, currentEntry } = await import("./resolve");
      const e = currentEntry(owner, name);
      if (e) saveFailedCheck(owner, name, versionOf(e, baseOf(owner)), [ready.reason]);
      return;
    }
    const answer = await check(ready, ready.cwd ?? agentRoot());
    if (answer.ok) saveCheck(owner, name, ready.version, answer.record as McpCheckRecord);
    else saveFailedCheck(owner, name, ready.version, linesOf(answer.errors, ready.values), answer.needsSignIn === true);
  })().finally(() => running.delete(k));
  running.set(k, task);
  return task;
}
