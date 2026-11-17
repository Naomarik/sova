/** What a Setup card holds that isn't the run: which of its rows are open, and the request's editor. No DOM, so the
    browser-conditions tests drive it. */
import { createSignal, type Accessor } from "solid-js";

/** Which rows of a card are open: the Models row, each provider's row, Style and Layout. */
export interface SetupOpenState {
  models: Accessor<boolean>;
  setModels(open: boolean): void;
  /** Provider sections and direction rows ("style", "layout") by id. */
  opened: Accessor<ReadonlySet<string>>;
  toggle(id: string): void;
  /** The request's editor text while it is open (null closed), and where its cursor was: kept with the rest, so a
      card drawn again while you type opens its editor again with your words. */
  request: { text: Accessor<string | null>; setText(text: string | null): void; caret: [number, number] | null };
}

const kept = new Map<string, SetupOpenState>();

/**
 * A card's open rows, kept by `key` (a run and where its pickers are drawn) for as long as the page is up: the card is
 * drawn again when it moves down the chat (a chat's change to it), and it opens as it was left. `modelsOpen` is where
 * the Models row starts the first time (open behind the brief's Change).
 */
export function setupOpenState(key: string, modelsOpen = false): SetupOpenState {
  const held = kept.get(key);
  if (held) return held;
  const [models, setModels] = createSignal(modelsOpen);
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const [text, setText] = createSignal<string | null>(null);
  const state: SetupOpenState = {
    models,
    setModels,
    opened,
    toggle: (id) =>
      setOpened((was) => {
        const next = new Set(was);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    request: { text, setText: (t) => setText(t), caret: null },
  };
  kept.set(key, state);
  return state;
}

/** The request's editor: the whole text in a box of its own; the card changes only at Save. */
export interface RequestEditor {
  /** The text being edited, or null while the editor is closed. */
  text: Accessor<string | null>;
  open(): void;
  setText(text: string): void;
  /** Hands the edited text on (only when it changed) and closes. */
  save(): void;
  /** Drops the edit (Cancel, Escape, a tap outside). */
  cancel(): void;
}

export function createRequestEditor(
  current: () => string,
  onSave: (text: string) => void,
  held: Pick<SetupOpenState["request"], "text" | "setText"> = (() => {
    const [text, setText] = createSignal<string | null>(null);
    return { text, setText: (t: string | null) => setText(t) };
  })(),
): RequestEditor {
  const { text, setText } = held;
  return {
    text,
    open: () => setText(current()),
    setText: (t) => {
      if (text() !== null) setText(t);
    },
    save: () => {
      const t = text();
      setText(null);
      if (t !== null && t !== current()) onSave(t);
    },
    cancel: () => setText(null),
  };
}
