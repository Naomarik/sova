// An open Lookbook view's chat on a phone: folded to a bar at first, every time (nothing remembered),
// and the bar's line, the newest message as the chat's transcript reports it.
import { createSignal } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import { chatBarLine, type ChatBarLine } from "./design-chat-bar";

export interface ChatFold {
  folded(): boolean;
  setFolded(folded: boolean): void;
  /** WorkerTranscript's latest-row callback. */
  onLatest(row: TranscriptItem | undefined): void;
  /** The bar's line for a chat whose replies are `author`'s; null: no message yet ("Message <name>"). */
  line(author: string): ChatBarLine | null;
}

export function createChatFold(): ChatFold {
  const [folded, setFolded] = createSignal(true);
  const [latest, setLatest] = createSignal<TranscriptItem | undefined>();
  return {
    folded,
    setFolded: (f) => setFolded(f),
    onLatest: (row) => setLatest(() => row),
    line: (author) => chatBarLine(latest(), author),
  };
}
