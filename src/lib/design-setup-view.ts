/** What a Setup card holds that isn't the run: which of its rows are open, and the request's editor. No DOM, so the
    browser-conditions tests drive it. */
import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { DesignChatView, DesignSetup } from "../../shared/design";
import type { DesignStore } from "./design-store";
import type { DesignRunView } from "./design-ui";

export interface SetupDraft {
  draft: Accessor<DesignSetup>;
  saving: Accessor<"" | "saving" | "error">;
  change(next: DesignSetup): void;
  /** Saves what's waiting now, for a press that needs the server to have it. */
  flush(): Promise<void>;
  /** Takes the card back from a server answer (a design view), unless a newer click is waiting to be saved. */
  adopt(answer: unknown): void;
}

/**
 * The Setup card's choices as you make them: saved shortly after each click (the whole card, so the latest change
 * wins), and never replaced by an update while unsaved. Once a save is answered with nothing newer waiting, the card
 * shows what the server holds: the newer of that answer and the last update, so a chat's change that came in while
 * the click was being saved shows, and the next click doesn't undo it.
 */
export function createSetupDraft(run: Accessor<DesignRunView>, store: Pick<DesignStore, "api">): SetupDraft {
  const [draft, setDraft] = createSignal<DesignSetup>(untrack(() => run().setup));
  const [saving, setSaving] = createSignal<"" | "saving" | "error">("");
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the server's card the draft shows was made: an update older than it (one sent before a save's answer
      that came first) never takes the card back. */
  let shownAt = untrack(run).updatedAt;
  const show = (r: Pick<DesignRunView, "updatedAt" | "setup">) => {
    if (r.updatedAt < shownAt) return;
    shownAt = r.updatedAt;
    setDraft(r.setup);
  };
  createEffect(
    on(
      () => run().setup,
      () => {
        if (!dirty) show(untrack(run));
      },
    ),
  );
  /** Nothing waits to be saved: the card is the server's, from its answer or the last update, whichever is newer. */
  const settle = (answer: unknown) => {
    dirty = false;
    const now = untrack(run);
    const answered = (answer as Partial<DesignChatView> | null | undefined)?.runs?.find((r) => r.id === now.id);
    show(answered && answered.updatedAt > now.updatedAt ? answered : now);
  };
  /** The save on its way, for a press that must come after it. */
  let inflight: Promise<unknown> = Promise.resolve();
  const save = () => {
    timer = undefined;
    const sent = draft();
    setSaving("saving");
    const sending = store.api.setup(untrack(run).id, sent).then((answer) => {
      if (sent === draft() && !timer) settle(answer);
      setSaving("");
    });
    inflight = sending.catch(() => setSaving("error"));
    return sending;
  };
  onCleanup(() => {
    if (timer) {
      clearTimeout(timer);
      void save().catch(() => {});
    }
  });
  return {
    draft,
    saving,
    change: (next) => {
      setDraft(next);
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(save, 300);
    },
    flush: async () => {
      if (!timer) return void (await inflight);
      clearTimeout(timer);
      await save();
    },
    adopt: (answer) => {
      if (!timer) settle(answer);
    },
  };
}

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
