// What a Move leaves on the device it left (§app.transport/moved-row): a mark per moved chat, in this
// server's state (`transport/moved.json`), which the session list puts on the chat's archived row as
// `moved`. Its home stays as the safety copy; nothing here removes it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state-root";

export interface MovedMark {
  tid: string;
  /** The device it moved to: its peer id here and its name. */
  peer: string;
  to: string;
  at: string;
  /** Its id there. */
  arrivedId: string;
}

/** Move Back is offered for this long after a Move (§app.transport/moved-row). */
export const MOVE_BACK_MS = 7 * 24 * 60 * 60 * 1000;

const fileOf = () => join(stateRoot(), "transport", "moved.json");
let memo: { file: string; marks: Record<string, MovedMark> } | null = null;

function marks(): Record<string, MovedMark> {
  const file = fileOf();
  if (memo?.file === file) return memo.marks;
  let m: Record<string, MovedMark> = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: number; moved?: Record<string, MovedMark> };
    if (raw?.v === 1 && raw.moved && typeof raw.moved === "object") m = raw.moved;
  } catch {
    // none yet
  }
  memo = { file, marks: m };
  return m;
}

function save(m: Record<string, MovedMark>): void {
  const file = fileOf();
  mkdirSync(join(stateRoot(), "transport"), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ v: 1, moved: m })}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  memo = { file, marks: m };
}

/** The mark of chat `chatId`, if it moved away. */
export const movedOf = (chatId: string): MovedMark | undefined => marks()[chatId];

export function markMoved(chatId: string, mark: MovedMark): void {
  save({ ...marks(), [chatId]: mark });
}

/** Moved back here (Move Back): the row is the chat's own again. */
export function unmarkMoved(chatId: string): void {
  const m = { ...marks() };
  delete m[chatId];
  save(m);
}

/** Every moved chat here. */
export const allMoved = (): Record<string, MovedMark> => ({ ...marks() });

/** Tests: forget the memo. */
export const resetMovedMemo = (): void => void (memo = null);
