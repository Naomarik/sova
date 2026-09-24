// Open/closed state for the sidebar's folder sections.
// A folder head is a <summary>, so every one of them can be collapsed, and like the Archive and its
// date sections it is COLLAPSED by default: the Recent region already shows whatever is active, and
// a folder that holds a working agent says so on its own head (`folderActive`).
//
// Pure on purpose: the rule is what a unit test can hold, and the component keeps the storage.

import type { SessionSummary } from "../../shared/protocol";
import { readKey, writeKey } from "./storage-keys";
import { sessionWorking } from "./workers";

/** One key per region + folder. The region prefix is what keeps the same folder under Live & web
    separate from it inside a group or an Archive date section. */
export const folderOpenKey = (idPrefix: string, cwd: string) => `sova:folder-open-${idPrefix}-${cwd}`;

/** The stored open/closed string for a folder section. */
export const readFolderOpenRaw = (idPrefix: string, cwd: string): string | null =>
  readKey(sessionStorage, folderOpenKey(idPrefix, cwd));

/** Remembers open/closed for a folder section. */
export const writeFolderOpenRaw = (idPrefix: string, cwd: string, open: boolean): void =>
  writeKey(sessionStorage, folderOpenKey(idPrefix, cwd), open ? "1" : "0");

/** The stored choice, in the Archive's own `"1"`/`"0"` spelling. Anything else — including nothing
    stored at all — means the user has never chosen, which is not the same as having chosen open. */
export const storedFolderOpen = (raw: string | null | undefined): boolean | undefined =>
  raw === "1" ? true : raw === "0" ? false : undefined;

/**
 * Whether a folder section is open right now. It is forced open, WITHOUT changing the stored
 * choice, while a search is on (every hit has to be visible). Holding the selected session does
 * NOT force it open: an active session is already in Recent, so the folder keeps the user's choice.
 */
export function folderOpen(input: { stored?: boolean | undefined; searching: boolean }): boolean {
  return input.searching || (input.stored ?? false);
}

/** Whether one session has an agent at work: pi replying in it (this tab's own run wins over the
    fetched list), a TUI mid-turn, or subagents working. */
export function sessionActive(
  s: Pick<SessionSummary, "path" | "busy" | "live" | "workers">,
  localRunning: Record<string, boolean> = {},
): boolean {
  if (sessionWorking(s) > 0) return true;
  if (s.live) return /^running/i.test(s.live.status);
  return !!(localRunning[s.path] ?? s.busy);
}

/** Whether a folder head shows its "agent at work" indicator: any of its sessions is active. */
export const folderActive = (
  sessions: readonly Pick<SessionSummary, "path" | "busy" | "live" | "workers">[],
  localRunning: Record<string, boolean> = {},
): boolean => sessions.some((s) => sessionActive(s, localRunning));
