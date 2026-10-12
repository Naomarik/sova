// A worker chat's session file, made before its chat process opens it (al_3 stage 4, design §2.4): what
// the pi CLI's `--session-dir`, `--fork` and `--session` did for an RPC worker, plus /btw's seeded side
// thread. The chat process then opens the file like any chat (it must exist: chat-manager's open
// refuses a missing file), so a new session's header is written at once, never at its first reply as
// pi would.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkerSession } from "../../../shared/chat-runtime";

export interface WorkerSessionFile {
  path: string;
  sessionId: string;
}

/** Create (or, for a resume, take) the session file a worker chat opens, in `cwd`. */
export function createWorkerSession(session: WorkerSession, cwd: string): WorkerSessionFile {
  if ("resume" in session) {
    if (!existsSync(session.resume.file)) throw new Error(`Session file not found: ${session.resume.file}`);
    const sm = SessionManager.open(session.resume.file);
    return { path: session.resume.file, sessionId: sm.getSessionId() };
  }
  if ("fork" in session) {
    // pi's own fork: a new header naming the source as its parent, then every entry of the source.
    const sm = SessionManager.forkFrom(session.fork.from, cwd, session.fork.dir);
    return { path: sm.getSessionFile()!, sessionId: sm.getSessionId() };
  }
  const dir = "new" in session ? session.new.dir : session.seed.dir;
  mkdirSync(dir, { recursive: true });
  const sm = SessionManager.create(cwd, dir);
  const path = sm.getSessionFile()!;
  // A seed's messages are the side thread's start: pi writes the file with its first conversation message.
  if ("seed" in session) for (const m of session.seed.messages) sm.appendMessage(m as Parameters<SessionManager["appendMessage"]>[0]);
  if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(sm.getHeader())}\n`, { flag: "wx" });
  return { path, sessionId: sm.getSessionId() };
}
