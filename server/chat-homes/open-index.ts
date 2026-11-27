/**
 * One index of the chats whose per-chat record (cards, offers) holds something open, over the server-wide folder and
 * every home's `chat/<kind>/`. Read whole once; after that only the homes whose generation moved are read again
 * (homesChangedSince), so a new chat or a home that arrived costs one folder of its own, not one per home.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homesChangeCursor, homesChangedSince } from "./records";
import { chatHome, homesRoot, listHomeIds } from "./root";

/** Folder reads the indexes did (the bench and tests count them). */
export const openIndexIo = { full: 0, homes: 0, readdirs: 0 };

export class OpenRecordIndex<V> {
  private st: { dir: string; root: string; cursor: number; open: Map<string, V>; home: Map<string, string | null> } | null = null;
  constructor(
    private readonly kind: "offers" | "cards",
    private readonly legacyDir: () => string,
    /** The chat's open entry, read from its record (undefined: nothing open). */
    private readonly entryOf: (sessionId: string) => V | undefined,
    /** A file name in the folder that isn't a chat's record. */
    private readonly skip: (name: string) => boolean = () => false,
  ) {}

  private names(dir: string): string[] {
    openIndexIo.readdirs++;
    try {
      return readdirSync(dir).filter((n) => n.endsWith(".json") && !this.skip(n));
    } catch {
      return []; // none there
    }
  }

  private add(name: string, home: string | null): void {
    const id = name.slice(0, -5);
    const v = this.entryOf(id);
    if (v === undefined) return;
    this.st!.open.set(id, v);
    this.st!.home.set(id, home);
  }

  private fresh(): Map<string, V> {
    const dir = this.legacyDir();
    const root = homesRoot();
    const s = this.st;
    const changed = s && s.dir === dir && s.root === root ? homesChangedSince(s.cursor) : null;
    if (!s || changed === null) {
      openIndexIo.full++;
      // The cursor first: a home that changes while the folders are read is read again next time.
      this.st = { dir, root, cursor: homesChangeCursor(), open: new Map(), home: new Map() };
      for (const n of this.names(dir)) this.add(n, null);
      for (const id of listHomeIds()) for (const n of this.names(join(chatHome(id), "chat", this.kind))) this.add(n, id);
      return this.st.open;
    }
    if (changed.length) {
      s.cursor = homesChangeCursor();
      const again = new Set(changed);
      for (const [id, h] of s.home)
        if (h !== null && again.has(h)) {
          s.open.delete(id);
          s.home.delete(id);
        }
      for (const h of again) {
        openIndexIo.homes++;
        for (const n of this.names(join(chatHome(h), "chat", this.kind))) this.add(n, h);
      }
    }
    return s.open;
  }

  get(sessionId: string): V | undefined {
    return this.fresh().get(sessionId);
  }

  /** A record this process just wrote: its entry now, kept only while the index is of the same folders. */
  put(sessionId: string, v: V | undefined, home: string | null): void {
    const s = this.st;
    if (!s || s.dir !== this.legacyDir() || s.root !== homesRoot()) return;
    if (v === undefined) {
      s.open.delete(sessionId);
      s.home.delete(sessionId);
    } else {
      s.open.set(sessionId, v);
      s.home.set(sessionId, home);
    }
  }

  delete(sessionId: string): void {
    this.st?.open.delete(sessionId);
    this.st?.home.delete(sessionId);
  }

  reset(): void {
    this.st = null;
  }
}
