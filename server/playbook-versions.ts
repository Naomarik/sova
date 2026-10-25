import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * Every playbook text a session was given, kept by its sha (§chat.schedules/delivery):
 * `<state root>/playbook-versions/<sha>`, outside every repo, so a later fire can send the change
 * against what that session holds. A text unused for 30 days is dropped; a missing one means the
 * next load is whole.
 */

export const VERSION_TTL_MS = 30 * 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;

/** A text's sha as a block names it: 16 hex of its sha256. */
export const shaOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

export class PlaybookVersions {
  private lastPrune = 0;
  constructor(
    readonly dir: string = join(stateRoot(), "playbook-versions"),
    private readonly now: () => number = Date.now,
  ) {}

  private file(sha: string): string | null {
    return /^[0-9a-f]{16}$/.test(sha) ? join(this.dir, sha) : null;
  }

  /** Keep `text` (or mark it used again); its sha. */
  keep(text: string): string {
    const sha = shaOf(text);
    const f = this.file(sha)!;
    try {
      const t = new Date(this.now());
      utimesSync(f, t, t);
    } catch {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${f}.${process.pid}.tmp`;
        writeFileSync(tmp, text, { mode: 0o600 });
        renameSync(tmp, f);
      } catch (err) {
        console.warn("[playbook-versions] not kept:", err instanceof Error ? err.message : String(err));
      }
    }
    this.prune();
    return sha;
  }

  get(sha: string): string | null {
    const f = this.file(sha);
    if (!f) return null;
    try {
      return readFileSync(f, "utf8");
    } catch {
      return null;
    }
  }

  has(sha: string): boolean {
    const f = this.file(sha);
    if (!f) return false;
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  }

  /** Drop texts unused for 30 days, at most once an hour. */
  prune(): void {
    const now = this.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!/^[0-9a-f]{16}$/.test(n)) continue;
      try {
        if (now - statSync(join(this.dir, n)).mtimeMs > VERSION_TTL_MS) unlinkSync(join(this.dir, n));
      } catch {
        // gone already
      }
    }
  }
}

let versions: PlaybookVersions | null = null;
/** The process's store (under the state root it starts with). */
export const playbookVersions = (): PlaybookVersions => (versions ??= new PlaybookVersions());
