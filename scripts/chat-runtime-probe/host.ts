// chat-runtime-probe host: one standalone Bun process hosting ONE Sova chat, the way a stage-2 chat
// process would (al_3). It opens the chat through the server's own chat-manager (acquireChat: the same
// pi session, extensions and loadout a hosted main chat gets), optionally runs a few short turns, and
// reports each phase as a `PROBE {json}` line on stdout. run.mjs drives it; never run it on ~/.pi.
//
//   PI_CODING_AGENT_DIR=<scratch agent dir> bun scripts/chat-runtime-probe/host.ts
//       (--session <file> | --new <cwd>) [--model <provider/id>] [--prompts <n>] [--prompt <text>]
//       [--also <k>] [--hold]
//
// --hold keeps the chat open after the last phase until SIGTERM (for the N-at-once and survival runs).
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const T0 = performance.timeOrigin;
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const agentDir = process.env.PI_CODING_AGENT_DIR;
const homePi = join(homedir(), ".pi");
if (!agentDir || resolve(agentDir) === homePi || resolve(agentDir).startsWith(homePi + "/")) {
  console.error("chat-runtime-probe host: PI_CODING_AGENT_DIR must name a scratch agent dir outside ~/.pi");
  process.exit(2);
}

const gc = () => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
const report = (phase: string, extra: Record<string, unknown> = {}) => {
  gc();
  const m = process.memoryUsage();
  console.log(`PROBE ${JSON.stringify({ phase, pid: process.pid, sinceStartMs: Math.round(Date.now() - T0), rss: m.rss, heapUsed: m.heapUsed, ...extra })}`);
};

process.on("uncaughtException", (err) => console.error("[probe uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[probe unhandledRejection]", err));

report("boot");
const tImport = performance.now();
const cm = await import("../../server/chat-manager");
const { createSessionFile } = await import("../../server/harness/pi/state");
report("imported", { importMs: Math.round(performance.now() - tImport) });

const model = opt("model");
const session = opt("session");
const newCwd = opt("new");
let path: string;
if (session) path = resolve(session);
else if (newCwd) path = createSessionFile({ cwd: resolve(newCwd) }).path;
else throw new Error("--session <file> or --new <cwd>");

if (model?.startsWith("claude-code-cli/")) {
  // The server registers the Claude Code models once at boot; a chat process would have to as well.
  const t = performance.now();
  await cm.warmClaudeCodeProvider(await cm.getModelRuntime(), agentDir);
  report("claude-warm", { warmMs: Math.round(performance.now() - t) });
}

const events: Record<string, number> = {};
const errors: string[] = [];
const client = {
  send(msg: { type?: string; message?: string }) {
    const type = String(msg?.type ?? "?");
    events[type] = (events[type] ?? 0) + 1;
    if (type === "error") errors.push(String(msg.message ?? ""));
  },
};

// The shared model runtime first, timed apart: it is what a warm spare process would already hold.
const tRuntime = performance.now();
await cm.getModelRuntime();
report("runtime", { runtimeMs: Math.round(performance.now() - tRuntime) });

const tOpen = performance.now();
const chat = await cm.acquireChat(path, true);
const openMs = Math.round(performance.now() - tOpen);
chat.attach(client as never);
report("ready", { openMs, path, entries: chat.harness.branch().length });

if (model) {
  await chat.setModelRef(model);
  report("model", { model: chat.harness.model()?.ref ?? null });
}

const prompts = Number(opt("prompts") ?? "0");
const text = opt("prompt") ?? "Reply with the single word OK. Use no tools.";
for (let i = 1; i <= prompts; i++) {
  const t = performance.now();
  await chat.prompt(`${text} (turn ${i})`);
  report(`turn${i}`, { turnMs: Math.round(performance.now() - t), errors: errors.splice(0) });
}
// --also <k>: k more chats in this same process, as today's server holds them (the in-process baseline
// a chat process is compared against), each with the same turns.
const also = Number(opt("also") ?? "0");
for (let k = 1; k <= also && newCwd; k++) {
  const t = performance.now();
  const extra = await cm.acquireChat(createSessionFile({ cwd: resolve(newCwd) }).path, true);
  extra.attach(client as never);
  if (model) await extra.setModelRef(model);
  for (let i = 1; i <= prompts; i++) await extra.prompt(`${text} (turn ${i})`);
  report(`also${k}`, { alsoMs: Math.round(performance.now() - t), errors: errors.splice(0) });
}
report("idle", { events });

if (args.includes("--hold")) {
  process.on("SIGTERM", async () => {
    const t = performance.now();
    await cm.disposeAllChats().catch(() => {});
    report("disposed-on-sigterm", { disposeMs: Math.round(performance.now() - t) });
    process.exit(0);
  });
  setInterval(() => {}, 1 << 30);
} else {
  await cm.disposeAllChats().catch(() => {});
  report("disposed");
  process.exit(0);
}
