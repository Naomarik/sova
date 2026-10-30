import type { HEntry, HookCtx } from "../shared/harness";
import { CARD_NOTE_MESSAGE } from "../shared/transcript-cards";

// The transcript cards' note (§chat.transcript-cards/answering), rendered for a chat's note hook. Its
// own module, importing only shared/, so the chat's loadout loads it without the card store.

/** When the last card note on the branch was given (the next note says only what came after it). */
export function lastCardNoteAt(branch: readonly HEntry[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (h.kind === "note" && !h.inMessage && h.noteType === CARD_NOTE_MESSAGE) return h.at ?? null;
  }
  return null;
}

/** The note's render for a chat: the answers given at once since the last note on its branch. */
export const cardNoteRender =
  (ask: (sessionId: string, since: string | null) => Promise<string | null>) =>
  (ctx: HookCtx): Promise<string | null> =>
    // A server that knows no such ask (older code) answers an error: no note, never a failed turn.
    ask(ctx.sessionId, lastCardNoteAt(ctx.branch())).catch(() => null);
