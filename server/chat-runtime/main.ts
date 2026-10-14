// A chat process's entry (al_3 stage 2): `bun server/chat-runtime/main.ts`, started by the server's
// chat supervisor as a systemd transient unit, its environment from the supervisor's env file:
//   SOVA_CHAT_SOCK   the socket to listen on      SOVA_CHAT_PATH   the one session file it hosts
//   SOVA_CHAT_ID     that session's id            SOVA_CHAT_UNIT   its unit's name
//   SOVA_CHAT_BUILD  the code of the server that started it (what it reports; it computes nothing)
// It listens before it loads anything heavy, so a slow import never looks like a dead process: the
// hello says "booting" until the chat's code is loaded and warm, then "ready"; the server's `open`
// opens the chat. SOVA_CHAT_TEST_FAIL_BOOT=<build>: exit 3 before listening when this build is that
// one (the code-pickup trial's failed start).
import { CHAT_WIRE_MIN_PROTO, CHAT_WIRE_PROTO, type ExitCause, type FrameOf } from "../../shared/chat-runtime-wire";
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
  // Read by the supervisor off the unit's log (server/chat-runtime/supervisor.ts announcedExit): an end
  // no server heard of is still an end on purpose, never a death. The format is that parser's.
  console.error(`[chat-runtime] exit ${cause} (pid ${process.pid})`);
  void server.close().finally(() => setTimeout(() => process.exit(0), 50));
}

const server = await serveLink(sock, {
  hello: () => host?.hello() ?? { build, pid: process.pid, startedAt, unit, sessionId, path, state, seq: 0 },
  onControl(link, control) {
    if (host) return host.onControl(link, control);
    early = { link, control };
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
  console.error(`[chat-runtime] ${signal}: closing`);
  if (host) void host.close("operator", { dispose: true, message: RELOAD_MESSAGE });
  else exitNow("operator", early?.link ?? null);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

// No terminal drawing code in a chat process (§app.chat-processes/no-terminal-drawing): before pi loads.
(await import("../harness/pi/headless")).installHeadless();
const { ChatRuntimeHost, RELOAD_MESSAGE, warmChatRuntime } = await import("./host");
await warmChatRuntime();
if (!exiting) {
  host = new ChatRuntimeHost({
    path,
    sessionId,
    unit,
    build,
    startedAt,
    // The host already sent `exit` on its link.
    exit: (cause) => exitNow(cause, null),
  });
  state = "ready";
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
