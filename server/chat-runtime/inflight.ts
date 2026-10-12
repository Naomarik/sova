// A chat process's run in flight, on disk (§app.chat-processes/crash): written when a run starts,
// removed when it settles, so a process that dies mid-run leaves it behind and the server resumes
// that chat once. A server restart leaves it in place while the chat runs on (not a death), and an
// exit on purpose removes it. The server's own run ledger (runs-in-flight.json, auto-resume.ts) is
// never written from a chat process: each process would rewrite it whole.
// `<state root>/chats/inflight/<session id>.json`: `{v: 1, path, since, auto?}`.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state-root";

export interface InflightMarker {
  v: 1;
  /** The session file. */
  path: string;
  /** When the run started (ms epoch). */
  since: number;
  /** The run is itself an automatic resume: cut off again, it is not resumed a second time. */
  auto?: true;
}

export const inflightDir = () => join(stateRoot(), "chats", "inflight");
const fileOf = (sessionId: string, dir: string) => join(dir, `${encodeURIComponent(sessionId)}.json`);

/** The marker a chat process left, or null. */
export function readInflight(sessionId: string, dir = inflightDir()): InflightMarker | null {
  try {
    const v = JSON.parse(readFileSync(fileOf(sessionId, dir), "utf8")) as Partial<InflightMarker>;
    if (v?.v !== 1 || typeof v.path !== "string") return null;
    return { v: 1, path: v.path, since: Number(v.since) || 0, ...(v.auto ? { auto: true as const } : {}) };
  } catch {
    return null;
  }
}

/** Read and remove it (the server, at a chat process's death). */
export function takeInflight(sessionId: string, dir = inflightDir()): InflightMarker | null {
  const m = readInflight(sessionId, dir);
  rmSync(fileOf(sessionId, dir), { force: true });
  return m;
}

/** The run recorder a chat process installs (chat-manager setRunRecorder): its one chat's marker. */
export class InflightRecorder {
  private resuming = false;
  constructor(
    private readonly sessionId: () => string,
    private readonly dir = inflightDir(),
    private readonly now: () => number = Date.now,
  ) {}

  started(path: string): void {
    const auto = this.resuming;
    this.resuming = false;
    const marker: InflightMarker = { v: 1, path, since: this.now(), ...(auto ? { auto: true as const } : {}) };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = fileOf(this.sessionId(), this.dir);
      writeFileSync(`${file}.tmp`, JSON.stringify(marker));
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error("[chat-runtime] couldn't record the run in flight", err);
    }
  }

  settled(_path: string): void {
    this.clear();
  }

  markResuming(_path: string): void {
    this.resuming = true;
  }

  /** The chat stops on purpose: nothing of it is cut off. */
  clear(): void {
    rmSync(fileOf(this.sessionId(), this.dir), { force: true });
  }
}
