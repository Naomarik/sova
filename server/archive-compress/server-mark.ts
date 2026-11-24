/**
 * `<state root>/server-running.json`: which Sova server runs on this agent dir (its pid, port and
 * start), so the backup and rollback commands (scripts/chat-homes) refuse while it runs. They ask the
 * port's /api/health and compare its startedAt, which holds across pid namespaces; a stale file
 * (a server that died) answers nothing and refuses nothing.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state-root";

export const SERVER_MARK = "server-running.json";

export function markServerRunning(port: number, startedAt: string): void {
  try {
    const dir = stateRoot();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, SERVER_MARK);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, pid: process.pid, port, startedAt })}\n`);
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`[server] couldn't write ${SERVER_MARK}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
