// A chat process's entry (al_3 stage 2): `bun server/chat-runtime/main.ts`, started by the server's
// chat supervisor as a systemd transient unit, its environment from the supervisor's env file:
//   SOVA_CHAT_SOCK   the socket to listen on      SOVA_CHAT_PATH   the one session file it hosts
//   SOVA_CHAT_ID     that session's id            SOVA_CHAT_UNIT   its unit's name
//   SOVA_CHAT_BUILD  the code of the server that started it (what it reports; it computes nothing)
// It listens before it loads anything heavy, so a slow import never looks like a dead process: the
// hello says "booting" until the chat's code is loaded and warm, then "ready"; the server's `open`
// opens the chat. SOVA_CHAT_TEST_FAIL_BOOT=<build>: exit 3 before listening when this build is that
// one (the code-pickup trial's failed start).
//
// It names each step of its start and of its chat's open as it enters it (§app.chat-processes/boot-log,
// server/chat-runtime/boot-steps.ts): one summary line per phase, a line every 10 s while one lasts,
// the step on a stop in the middle of one, and each step to its server in a `boot` frame. Only this
// process records the trail: the server's own warm-up hears no step. Tests:
// SOVA_CHAT_TEST_HANG_BOOT=<build> hangs the start in a "test hang" step, with a `sleep` child running,
// when this build is that one; SOVA_CHAT_TEST_BEAT_MS beats faster than every 10 s.
import { spawn, type ChildProcess } from "node:child_process";
import { CHAT_WIRE_MIN_PROTO, CHAT_WIRE_PROTO, type ExitCause, type FrameOf } from "../../shared/chat-runtime-wire";
import { BEAT_MS, BootTrail, childPrograms, stoppedText } from "./boot-steps";
import { dropGcTimerEnv } from "./gc-timer";
import { type ControlFrame, type Link, serveLink } from "./link";

const env = process.env;
// Bun read it at start (its GC timer is off for this process); the programs this chat's tools run keep theirs.
dropGcTimerEnv(env);
const need = (name: string): string => {
  const v = env[name];
  if (!v) {
    console.error(`[chat-runtime] ${name} is not set`);
    process.exit(2);
  }
  return v;
};
const sock = need("SOVA_CHAT_SOCK");
const path = need("SOVA_CHAT_PATH");
const sessionId = need("SOVA_CHAT_ID");
const unit = env.SOVA_CHAT_UNIT ?? "";
const build = env.SOVA_CHAT_BUILD || "unknown";
const startedAt = Date.now();

if (env.SOVA_CHAT_TEST_FAIL_BOOT && env.SOVA_CHAT_TEST_FAIL_BOOT === build) {
  console.error(`[chat-runtime] SOVA_CHAT_TEST_FAIL_BOOT=${build}: failing the start on purpose`);
  process.exit(3);
}

const beatMs = Number(env.SOVA_CHAT_TEST_BEAT_MS) > 0 ? Number(env.SOVA_CHAT_TEST_BEAT_MS) : BEAT_MS;
const logLine = (line: string) => console.error(line);
/** The start's trail; its steps go to the server that controls this chat (none yet: dropped, and the
    next control hears the current step at once). */
const startTrail = new BootTrail({
  phase: "starting",
  since: startedAt,
  log: logLine,
  beatMs,
  send: (frame) => {
    const l = early?.link;
    if (l?.isOpen && l.compatible) l.send(frame);
  },
});
/** The trail of the phase this process is in, or was last in. */
let trail: BootTrail = startTrail;
/** When a stop signal came, and which: the exit line says how long the stop took. */
let stopAt: { at: number; signal: string } | null = null;
let hangChild: ChildProcess | null = null;

// An extension's stray error must not end the chat (as in the server, server/index.ts).
process.on("uncaughtException", (err) => console.error("[chat-runtime uncaughtException]", err));
process.on("unhandledRejection", (err) => console.error("[chat-runtime unhandledRejection]", err));

type Host = import("./host").ChatRuntimeHost;
let host: Host | null = null;
let state: "booting" | "ready" = "booting";
/** A controller that came before the chat's code was loaded: handed to the host once it is. */
let early: { link: Link; control: ControlFrame } | null = null;
let exiting = false;

function exitNow(cause: ExitCause, link: Link | null): void {
  if (exiting) return;
  exiting = true;
  link?.send({ t: "exit", cause });
  trail.finish(false);
  hangChild?.kill();
  // Read by the supervisor off the unit's log (server/chat-runtime/supervisor.ts announcedExit): an end
  // no server heard of is still an end on purpose, never a death. The format is that parser's; what
  // follows `)` is free.
  const after = stopAt ? ` ${((Date.now() - stopAt.at) / 1000).toFixed(2)} s after ${stopAt.signal}` : "";
  console.error(`[chat-runtime] exit ${cause} (pid ${process.pid})${after}`);
  void server.close().finally(() => setTimeout(() => process.exit(0), 50));
}

const server = await serveLink(sock, {
  hello: () => host?.hello() ?? { build, pid: process.pid, startedAt, unit, sessionId, path, state, seq: 0 },
  onControl(link, control) {
    if (host) return host.onControl(link, control);
    early = { link, control };
    startTrail.report();
    // While booting, only a drain means anything: there is no chat to close yet.
    link.on("drain", (f: FrameOf<"drain">) => {
      if (host) return;
      link.send({ t: "drained", id: f.id, ok: true });
      exitNow(f.reason, link);
    });
  },
});

let stopping = false;
// A stop from outside (the unit stopped): the panes reconnect quietly, as after a reload, to a new
// process, never told the chat stopped unexpectedly.
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  stopAt = { at: Date.now(), signal };
  console.error(`[chat-runtime] ${signal}: closing`);
  // Stopped in the middle of its start or its open: the step it was in, and what it was waiting on.
  if (!trail.done) console.error(stoppedText(signal, trail, childPrograms()));
  if (host) void host.close("operator", { dispose: true, message: RELOAD_MESSAGE });
  else exitNow("operator", early?.link ?? null);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

// No terminal drawing code in a chat process (§app.chat-processes/no-terminal-drawing): before pi loads.
startTrail.step("headless");
(await import("../harness/pi/headless")).installHeadless();
if (env.SOVA_CHAT_TEST_HANG_BOOT && env.SOVA_CHAT_TEST_HANG_BOOT === build) {
  startTrail.step("test hang");
  console.error(`[chat-runtime] SOVA_CHAT_TEST_HANG_BOOT=${build}: hanging the start on purpose`);
  hangChild = spawn("sleep", ["120"], { stdio: "ignore" });
  await new Promise(() => {});
}
startTrail.step("chat code");
const { ChatRuntimeHost, RELOAD_MESSAGE, warmChatRuntime } = await import("./host");
await warmChatRuntime(startTrail.step);
startTrail.step("host");
if (!exiting) {
  host = new ChatRuntimeHost({
    path,
    sessionId,
    unit,
    build,
    startedAt,
    // The host already sent `exit` on its link.
    exit: (cause) => exitNow(cause, null),
    // Each open's trail, this process's current one while it lasts.
    openTrail: (send) => (trail = new BootTrail({ phase: "opening", since: Date.now(), log: logLine, beatMs, send })),
  });
  state = "ready";
  startTrail.finish();
  // Set by onControl meanwhile (a callback: the compiler can't see it).
  const pending = early as { link: Link; control: ControlFrame } | null;
  if (pending?.link.isOpen) {
    host.onControl(pending.link, pending.control);
    // The state changed on this link: say it (kernel hello, as the host does on every change).
    pending.link.send({ t: "hello", proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch: pending.control.epoch, ...host.hello() });
  }
  early = null;
  if (stopping) void host.close("operator", { dispose: true, message: RELOAD_MESSAGE });
}
