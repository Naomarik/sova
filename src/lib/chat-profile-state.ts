// Each open chat's profile state, as its own `chat_profile` message last said (§chat.profiles/switch):
// the chat view writes it, and what draws inside its thread (the usage-limit row) reads it by path,
// so nothing asks the server again or guesses it.
import { createSignal, type Accessor, type Setter } from "solid-js";
import type { ChatProfileState } from "../../shared/protocol";

const states = new Map<string, [Accessor<ChatProfileState | null>, Setter<ChatProfileState | null>]>();

function slot(path: string) {
  let s = states.get(path);
  if (!s) {
    s = createSignal<ChatProfileState | null>(null);
    states.set(path, s);
  }
  return s;
}

/** The chat's profile state now; null before its message (or from a server that sends none). */
export const chatProfileOf = (path: string): ChatProfileState | null => slot(path)[0]();

/** What the chat's socket said; null clears it (a new hello). */
export const setChatProfileOf = (path: string, state: ChatProfileState | null): void => void slot(path)[1](state);
