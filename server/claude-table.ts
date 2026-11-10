// Sova follows Claude Code's own model table by itself: a cheap look at the program file on a timer, a
// short child to read it when it changed, the result remembered in claude-models.json, and one tiny
// message to a newly current model before any built-in default may move to it. Only this server writes
// the file; every process follows it by its mtime. A table Sova can't read keeps the last good list.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { offerFromTable, type ClaudeTableParse } from "../pi-config/extensions/claude-code/bundle-table.ts";
import { CLAUDE_MODELS, parseClaudeId } from "../pi-config/extensions/claude-code/catalog.ts";
import { CLAUDE_MODELS_FILE, readClaudeModelsFile, type ClaudeModelsFile } from "../pi-config/extensions/claude-code/catalog-store.ts";
import { claudeExecutable } from "../pi-config/extensions/claude-code/claude-executable.ts";
import { fixedSettingsJson } from "../pi-config/extensions/claude-code/fixed-settings.ts";
import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";
import { modelFetchEnabled } from "../pi-config/extensions/model-levels/core.ts";
import { claudeLoginEnv } from "./claude-accounts";
import { DecisionError, failureMessage } from "./decide";
import { claudeRun, LLM_TIMEOUT_MS, type Fail } from "./decide-llm";
import { stateRoot } from "./state-root";
import { runtimeCommand } from "./usage-helper/client";

/** How often the program file is looked at (a `stat`; it is read only when it changed). */
export const CLAUDE_TABLE_POLL_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 60_000;
const MAX_READ_OUTPUT = 4 * 1024 * 1024;
const PROBE_BUDGET_USD = 0.05;

export type ClaudeProbeResult = { ok: true } | { ok: false; reason: string };

export interface ClaudeTableClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ClaudeTableDeps {
  root(): string;
  /** Whether anything may run at all; checked at every step. */
  enabled(): boolean;
  /** The Claude program, or a throw when there is none. */
  executable(): string;
  /** The child read of one program file. */
  read(realPath: string): Promise<ClaudeTableParse>;
  /** The one-word test of one model. */
  probe(id: string): Promise<ClaudeProbeResult>;
  pollMs?: number;
  clock?: ClaudeTableClock;
}

export interface ClaudeTableCheck {
  start(): void;
  stop(): void;
  /** Run now (joins one already running); resolves when done, without doing anything when off. */
  checkNow(): Promise<void>;
}

const realClock: ClaudeTableClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function writeFile(root: string, file: ClaudeModelsFile): void {
  const target = path.join(root, CLAUDE_MODELS_FILE);
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 1)}\n`);
  fs.renameSync(tmp, target);
}

/** The models due a one-word test: learned ones (the built-in list needs none) the table still has and that haven't passed. */
export function modelsToProbe(file: ClaudeModelsFile): string[] {
  const builtIn = new Set(CLAUDE_MODELS.map((m) => m.id));
  const tested = new Set(file.tested ?? []);
  const dropped = new Set(file.dropped ?? []);
  return file.models.map((m) => m.id).filter((id) => !builtIn.has(id) && !tested.has(id) && !dropped.has(id));
}

export function createClaudeTableCheck(deps: ClaudeTableDeps): ClaudeTableCheck {
  const clock = deps.clock ?? realClock;
  const pollMs = deps.pollMs ?? CLAUDE_TABLE_POLL_MS;
  let timer: unknown;
  let started = false;
  let inflight: Promise<void> | null = null;
  /** Every server start reads the table once, changed or not. */
  let readThisStart = false;

  const update = (change: (file: ClaudeModelsFile) => ClaudeModelsFile) => {
    const root = deps.root();
    const next = change(readClaudeModelsFile(root) ?? { v: 1, models: [] });
    writeFile(root, next);
    return next;
  };

  /** True when the table was read: the only moment a one-word test may run. */
  const readIfChanged = async (): Promise<boolean> => {
    let exe: string;
    try {
      exe = deps.executable();
    } catch {
      // No Claude Code here: nothing is wrong with the table, and the last good list stands.
      const held = readClaudeModelsFile(deps.root());
      if (held && (held.unreadable || !held.noProgram)) update(({ unreadable: _gone, ...file }) => ({ ...file, noProgram: true }));
      return false;
    }
    const realPath = fs.realpathSync(exe);
    const { mtimeMs } = fs.statSync(realPath);
    const held = readClaudeModelsFile(deps.root());
    const same = held?.cli?.realPath === realPath && held.cli.mtimeMs === mtimeMs;
    if (same && readThisStart) return false;
    readThisStart = true;
    const result = await deps.read(realPath);
    const at = clock.now();
    const fromName = /^\d+\.\d+\.\d+$/.test(path.basename(realPath)) ? path.basename(realPath) : undefined;
    update(({ noProgram: _found, ...file }) => {
      const version = fromName ?? (result.ok ? result.table.cliVersion : undefined);
      const cli = { path: exe, realPath, mtimeMs, ...(version ? { version } : {}) };
      if (!result.ok) return { ...file, cli, checkedAt: at, unreadable: { reason: result.reason, at, ...(version ? { cliVersion: version } : {}) } };
      const { unreadable: _gone, ...rest } = file;
      const { dropped: _d, ...keep } = rest;
      return { ...keep, ...offerFromTable(result.table, file), cli, checkedAt: at };
    });
    return true;
  };

  const runProbes = async (): Promise<void> => {
    const held = readClaudeModelsFile(deps.root());
    if (!held) return;
    for (const id of modelsToProbe(held)) {
      if (!deps.enabled()) return;
      const at = clock.now();
      const result = await deps.probe(id).catch((err): ClaudeProbeResult => ({ ok: false, reason: failureMessage(err) }));
      update((file) => ({
        ...file,
        probes: { ...file.probes, [id]: result.ok ? { at, ok: true } : { at, ok: false, reason: result.reason.slice(0, 240) } },
        ...(result.ok ? { tested: [...new Set([...(file.tested ?? []), id])].sort() } : {}),
      }));
    }
  };

  const arm = () => {
    if (!started) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      void run();
    }, pollMs);
  };

  const run = (): Promise<void> => {
    if (!deps.enabled()) return Promise.resolve();
    if (inflight) return inflight;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
    inflight = (async () => {
      try {
        if (await readIfChanged()) await runProbes();
      } catch (err) {
        console.warn(`[claude-table] ${failureMessage(err)}`);
      }
    })().finally(() => {
      inflight = null;
      arm();
    });
    return inflight;
  };

  return {
    start() {
      if (started || !deps.enabled()) return;
      started = true;
      void run();
    },
    stop() {
      started = false;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
    checkNow: run,
  };
}

/** Runs the reader child over one program file; a crash or timeout is "no data", like a bad parse. */
export function readClaudeTableInChild(realPath: string): Promise<ClaudeTableParse> {
  const { exe, args } = runtimeCommand(path.join(import.meta.dirname, "claude-table-read.ts"));
  return new Promise((resolve) => {
    const child = spawn(exe, [...args, realPath], { stdio: ["ignore", "pipe", "ignore"], env: process.env });
    let out = "";
    let done = false;
    const finish = (result: ClaudeTableParse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "reading Claude Code's table timed out" });
    }, READ_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if ((out += chunk).length > MAX_READ_OUTPUT) {
        child.kill("SIGKILL");
        finish({ ok: false, reason: "reading Claude Code's table printed too much" });
      }
    });
    child.on("error", () => finish({ ok: false, reason: "could not start the table reader" }));
    child.on("close", () => {
      try {
        finish(JSON.parse(out) as ClaudeTableParse);
      } catch {
        finish({ ok: false, reason: "the table reader stopped without an answer" });
      }
    });
  });
}

/** The argv of a one-word test: the same quiet one-shot as every other side call of Sova's. */
export function claudeProbeArgs(id: string): string[] {
  return [
    "-p", "--model", id,
    "--tools", "",
    "--setting-sources", "",
    "--settings", fixedSettingsJson(),
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--output-format", "json",
    "--max-budget-usd", PROBE_BUDGET_USD.toFixed(2),
  ];
}

/** What Claude Code printed for a one-word test. A pass is an answer from that model, named by Claude Code itself. */
export function judgeProbe(stdout: string, id: string, apiIds: readonly string[] = []): ClaudeProbeResult {
  let envelope: { is_error?: unknown; result?: unknown; subtype?: unknown; modelUsage?: unknown };
  try {
    envelope = JSON.parse(stdout) as typeof envelope;
  } catch {
    return { ok: false, reason: "Claude Code's answer was not JSON" };
  }
  if (envelope.is_error) return { ok: false, reason: String(envelope.result || envelope.subtype || "Claude Code reported an error") };
  if (typeof envelope.result !== "string" || !envelope.result.trim()) return { ok: false, reason: "the model gave no answer" };
  const used = envelope.modelUsage && typeof envelope.modelUsage === "object" ? Object.keys(envelope.modelUsage) : [];
  if (!used.some((m) => parseClaudeId(m)?.id === id || apiIds.includes(m.replace(/\[1m\]$/i, "")))) return { ok: false, reason: used.length ? `answered by ${used.join(", ")}` : "Claude Code didn't say which model answered" };
  return { ok: true };
}

async function probeClaudeModel(id: string): Promise<ClaudeProbeResult> {
  const fail: Fail = (failure, message) => new DecisionError(failure, message);
  const stdout = await withUsageContext({ owner: null, purpose: "model-check", kind: "oneshot" }, () =>
    claudeRun(claudeProbeArgs(id), "Reply with the single word OK.", { env: claudeLoginEnv }, LLM_TIMEOUT_MS, fail, undefined, { systemPrompt: "Reply in one word." }),
  );
  return judgeProbe(stdout, id, readClaudeModelsFile(stateRoot())?.models.find((m) => m.id === id)?.apiIds);
}

/** Tests never get here: a test process has fetches off unless it asks, and dev:hermetic sets SOVA_CLAUDE_TABLE=off. */
export function claudeTableEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return modelFetchEnabled(env) && env.SOVA_CLAUDE_TABLE !== "off";
}

let check: ClaudeTableCheck | null = null;

/** The server's check, made on first use. */
export function claudeTableCheck(): ClaudeTableCheck {
  const poll = Number(process.env.SOVA_CLAUDE_TABLE_POLL_MS);
  check ??= createClaudeTableCheck({
    root: stateRoot,
    enabled: () => claudeTableEnabled(),
    executable: () => claudeExecutable(),
    read: readClaudeTableInChild,
    probe: probeClaudeModel,
    ...(poll > 0 ? { pollMs: poll } : {}),
  });
  return check;
}

/** Startup (server/index.ts). The server only: a chat process only follows the file. */
export function startClaudeTableCheck(): void {
  claudeTableCheck().start();
}

export function stopClaudeTableCheck(): void {
  check?.stop();
}
