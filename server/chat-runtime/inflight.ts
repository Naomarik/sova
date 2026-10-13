// A chat process's run in flight, on disk (§app.chat-processes/crash): written when a run starts,
// removed when it settles, so a process that dies mid-run leaves it behind and the server resumes
// that chat once. A server restart leaves it in place while the chat runs on (not a death), and an
// exit on purpose removes it. The server's own run ledger (runs-in-flight.json, auto-resume.ts) is
// never written from a chat process: each process would rewrite it whole.
// At a death the server marks it `resume` until its resume is sent or refused, so a server that stops
// before then leaves it to the next (crash-resume across a restart).
// `<state root>/chats/inflight/<session id>.json`: `{v: 1, path, since, auto?, resume?}`.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatStateRoot } from "../state-root";

export interface InflightMarker {
  v: 1;
  /** The session file. */
  path: string;
  /** When the run started (ms epoch). */
  since: number;
  /** The run is itself an automatic resume: cut off again, it is not resumed a second time. */
  auto?: true;
  /** Its process died with it in flight, and its one resume is not sent yet (the server's mark). */
  resume?: true;
}

export const inflightDir = () => join(chatStateRoot(), "chats", "inflight");
const fileOf = (sessionId: string, dir: string) => join(dir, `${encodeURIComponent(sessionId)}.json`);

/** The marker a chat process left, or null. */
export function readInflight(sessionId: string, dir = inflightDir()): InflightMarker | null {
  try {
    const v = JSON.parse(readFileSync(fileOf(sessionId, dir), "utf8")) as Partial<InflightMarker>;
    if (v?.v !== 1 || typeof v.path !== "string") return null;
    return { v: 1, path: v.path, since: Number(v.since) || 0, ...(v.auto ? { auto: true as const } : {}), ...(v.resume ? { resume: true as const } : {}) };
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

function writeMarker(sessionId: string, marker: InflightMarker, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(sessionId, dir);
  writeFileSync(`${file}.tmp`, JSON.stringify(marker));
  renameSync(`${file}.tmp`, file);
}

/** At a death whose run is to be resumed: the marker stays, saying so, until the resume is sent or refused. */
export function markResume(sessionId: string, marker: InflightMarker, dir = inflightDir()): void {
  writeMarker(sessionId, { ...marker, resume: true }, dir);
}

/** The resume was sent or refused: its mark goes (a run it started has written a marker of its own: kept). */
export function dropResume(sessionId: string, dir = inflightDir()): void {
  if (readInflight(sessionId, dir)?.resume) rmSync(fileOf(sessionId, dir), { force: true });
}

/** The resumes a server left unsent, by session id (the next server sends them once it has taken its chats back). */
export function pendingResumes(dir = inflightDir()): { sessionId: string; marker: InflightMarker }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    if (!n.endsWith(".json")) return [];
    const sessionId = decodeURIComponent(n.slice(0, -5));
    const marker = readInflight(sessionId, dir);
    return marker?.resume ? [{ sessionId, marker }] : [];
  });
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
      writeMarker(this.sessionId(), marker, this.dir);
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
