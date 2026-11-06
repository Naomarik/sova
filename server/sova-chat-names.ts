import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import { cleanSessionTitle } from "./session-titles";
import { sessionsChanged } from "./list-generation";
import type { SovaNamedKind } from "../shared/fixed-names";

/**
 * The names Sova gives the chats it starts itself: the merge queue's thread and reviewers and each release chat
 * (shared/fixed-names.ts). Kept apart from the title store (server/session-titles.ts) on purpose: that store is the
 * one every rename writes (the user's, the Overseer's, the automatic namer's), and this one only Sova's own starts
 * and a release's retitle write, so no rename can ever overwrite the name Sova gave. Keyed by session id;
 * `<stateRoot>/sova-chat-names.json`, version 1. Never written into a session file.
 */

export interface SovaChatName {
  kind: SovaNamedKind;
  name: string;
}

const KINDS: readonly SovaNamedKind[] = ["merge-thread", "merge-reviewer", "release"];
const file = (): string => join(stateRoot(), "sova-chat-names.json");

function load(): Record<string, SovaChatName> {
  const out: Record<string, SovaChatName> = Object.create(null);
  try {
    const v = JSON.parse(readFileSync(file(), "utf8")) as { names?: Record<string, unknown> };
    for (const [id, raw] of Object.entries(v?.names ?? {})) {
      const r = raw as Partial<SovaChatName> | null;
      const name = cleanSessionTitle(r?.name);
      if (name && KINDS.includes(r?.kind as SovaNamedKind)) out[id] = { kind: r!.kind as SovaNamedKind, name };
    }
  } catch {
    // missing or corrupt: none
  }
  return out;
}

let names = load();
let loadedFrom = file();

/** The names as last read or written here, with no file read (per-tick use). Re-read when the state root moved. */
export function memoSovaChatNames(): Readonly<Record<string, SovaChatName>> {
  if (loadedFrom !== file()) readSovaChatNames();
  return names;
}

/** Every name, read from the file (a listing sees another server instance's writes). */
export function readSovaChatNames(): Readonly<Record<string, SovaChatName>> {
  loadedFrom = file();
  names = load();
  return names;
}

/** Record the name Sova gives a chat it started (or renames, as a release does once its tag is known). Re-reads the
    file and changes only this id. False when the name isn't one a title may be. */
export function setSovaChatName(id: string, kind: SovaNamedKind, raw: string): boolean {
  const name = cleanSessionTitle(raw);
  if (!name) return false;
  const next = load();
  const cur = next[id];
  if (cur && cur.kind === kind && cur.name === name) {
    names = next;
    loadedFrom = file();
    return true;
  }
  next[id] = { kind, name };
  mkdirSync(dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, names: next }));
  renameSync(tmp, file());
  names = next;
  loadedFrom = file();
  sessionsChanged();
  return true;
}
