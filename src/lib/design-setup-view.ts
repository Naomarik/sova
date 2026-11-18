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

/** A save the server refused because the run changed after the card it was made from (409, `stale`), with the
    server's view when it sent one. */
function staleRefusal(e: unknown): { view?: unknown } | null {
  const err = e as { status?: unknown; body?: unknown } | null;
  if (err?.status !== 409) return null;
  const body = err.body as { stale?: unknown; view?: unknown; run?: unknown } | null | undefined;
  if (!body?.stale) return null;
  return { view: body.view ?? (body.run ? { runs: [body.run] } : undefined) };
}

/** Which version of a run's card it is: its last Setup change (yours, the chat's, Hide or Show), else when it was
    made. Nothing else moves it (a phase change, the brief being written). */
export const cardAt = (r: Pick<DesignRunView, "setupAt" | "createdAt">): string => r.setupAt ?? r.createdAt;

/**
 * The Setup card's choices as you make them: saved whole shortly after each click, so the latest change wins, and
 * never replaced by an update while unsaved, with one exception: a newer card from the server (the chat's change)
 * arriving while your click still waits to be sent wins, and the click isn't sent. Each save names the card it was
 * made from (`baseSetupAt`, its cardAt); one the server refuses because the run changed since then takes the server's
 * card. Once a save is answered with nothing newer waiting, the card shows what the server holds: the newer of that
 * answer and the last update. Text in the request's editor is its own, so none of this touches it.
 */
export function createSetupDraft(run: Accessor<DesignRunView>, store: Pick<DesignStore, "api">): SetupDraft {
  const [draft, setDraft] = createSignal<DesignSetup>(untrack(() => run().setup));
  const [saving, setSaving] = createSignal<"" | "saving" | "error">("");
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves sent and not yet answered: an update meanwhile may be one of them coming back, so it waits for the answer. */
  let sending = 0;
  /** The version (cardAt) of the server's card the draft is made from: the base each save names, and an update older
      than it (one sent before a save's answer that came first) never takes the card back. */
  let shownAt = cardAt(untrack(run));
  type Card = Pick<DesignRunView, "setupAt" | "createdAt" | "setup">;
  const show = (r: Card) => {
    if (cardAt(r) < shownAt) return;
    shownAt = cardAt(r);
    setDraft(r.setup);
  };
  /** A newer card from the server wins over clicks not yet sent: they're dropped and it shows. */
  const yieldTo = (r: Card) => {
    clearTimeout(timer);
    timer = undefined;
    dirty = false;
    show(r);
  };
  createEffect(
    on(
      () => run().setup,
      () => {
        const r = untrack(run);
        if (!dirty) show(r);
        else if (!sending && cardAt(r) > shownAt) yieldTo(r);
      },
    ),
  );
  const answeredRun = (answer: unknown) => (answer as Partial<DesignChatView> | null | undefined)?.runs?.find((r) => r.id === untrack(run).id);
  /** The newer of an answer's run and the last update. */
  const newest = (answer: unknown) => {
    const now = untrack(run);
    const answered = answeredRun(answer);
    return answered && cardAt(answered) > cardAt(now) ? answered : now;
  };
  /** Nothing waits to be saved: the card is the server's, from its answer or the last update, whichever is newer. */
  const settle = (answer: unknown) => {
    dirty = false;
    show(newest(answer));
  };
  /** The save on its way, for a press that must come after it. */
  let inflight: Promise<unknown> = Promise.resolve();
  const save = () => {
    timer = undefined;
    const sent = draft();
    setSaving("saving");
    sending++;
    const done = store.api.setup(untrack(run).id, sent, shownAt).then(
      (answer) => {
        sending--;
        setSaving("");
        if (sent === draft() && !timer) return settle(answer);
        // A newer click waits: it was made on top of this one, so its base is this save's card; a change the
        // server made after that wins over it.
        const answered = answeredRun(answer);
        if (answered && cardAt(answered) > shownAt) shownAt = cardAt(answered);
        const now = untrack(run);
        if (!sending && cardAt(now) > shownAt) yieldTo(now);
      },
      (e) => {
        sending--;
        const stale = staleRefusal(e);
        if (!stale) throw e;
        setSaving("");
        yieldTo(newest(stale.view));
      },
    );
    inflight = done.catch(() => setSaving("error"));
    return done;
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
