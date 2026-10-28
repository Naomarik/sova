/**
 * The card toolkit a view imports as `sova:card` (§chat.transcript-cards/view-api), toolkit v1.
 * Bundled into each project view by server/card-views.ts and run only in the sealed box
 * (src/lib/card-box.ts): it speaks to the page through the box's one message channel
 * (`globalThis.__sovaCardBox`), and the page answers for its own card only
 * (src/lib/card-view-host.ts). Solid is Sova's own copy, shared with the view, so its signals are
 * the view's.
 *
 *   import { card, mount } from "sova:card";
 *   mount(() => <p>{card.data<{ n: number }>().n}</p>);
 */
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import type { CommandId, CommandParams } from "./commands.gen";

export type { CommandId, CommandParams } from "./commands.gen";

/** The toolkit version this module is (§chat.transcript-cards/versions). */
export const TOOLKIT = 1;

export type CardStatus = "open" | "answered" | "done" | "superseded";
export interface CardAnswer {
  text: string;
  /** The JSON value the view recorded with it, if any. */
  value: unknown;
  by: string;
  at: string;
}
export interface SessionInfo {
  id: string;
  title: string;
  /** Whether this view can act on the session (stage text, answer, run commands that change something). */
  canAct: boolean;
}
export interface ThemeInfo {
  name: string;
  scheme: "light" | "dark";
}
/** A command's answer: the route's own status and JSON body. */
export interface CommandResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** What the page sends a box at load and on every change. */
export interface BoxInit {
  card: { id: string; type: string; title: string; data: unknown; status: CardStatus; answer: CardAnswer | null; mode: "none" | "at-once" | "gather" };
  state: unknown;
  session: SessionInfo;
  theme: ThemeInfo;
}

interface Box {
  init: BoxInit;
  post(m: unknown): void;
  on(fn: (m: unknown) => void): () => void;
}

const box = (globalThis as unknown as { __sovaCardBox?: Box }).__sovaCardBox;
if (!box) throw new Error("sova:card runs only in a card's sealed box.");
const init = box.init;

const [data, setData] = createSignal<unknown>(init.card.data);
const [answer, setAnswer] = createSignal<CardAnswer | null>(init.card.answer);
const [status, setStatus] = createSignal<CardStatus>(init.card.status);
const [state, setStateSignal] = createSignal<unknown>(init.state ?? null);
const [session, setSession] = createSignal<SessionInfo>(init.session);
const [theme, setTheme] = createSignal<ThemeInfo>(init.theme);

let seq = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

box.on((raw) => {
  const m = raw as { re?: number; ok?: boolean; value?: unknown; error?: string; push?: string; init?: BoxInit; theme?: ThemeInfo };
  if (typeof m?.re === "number") {
    const p = pending.get(m.re);
    if (!p) return;
    pending.delete(m.re);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error ?? "Refused."));
    return;
  }
  if (m?.push === "update" && m.init) {
    setData(() => m.init!.card.data);
    setAnswer(m.init.card.answer);
    setStatus(m.init.card.status);
    setStateSignal(() => m.init!.state ?? null);
    setSession(m.init.session);
    setTheme(m.init.theme);
  } else if (m?.push === "theme" && m.theme) setTheme(m.theme);
});

function call<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    box!.post({ id, call: op, args });
  });
}

/** This card, as the view sees it. Every read is a Solid signal: a view redraws when it changes. */
export const card = {
  id: init.card.id,
  type: init.card.type,
  title: init.card.title,
  /** How it is answered: at once, gathered with the next message, or not at all. */
  mode: init.card.mode,
  /** The data the card was raised with (its newest revision). */
  data: <D = unknown>() => data() as D,
  /** Its answer, once given. */
  answer,
  status,
  /** The state Sova keeps for this card (null until the view sets one). */
  state: <S = unknown>() => state() as S | null,
  session,
  theme,
  /**
   * Keep a JSON value for this card (at most 64 KB): kept across a redraw on save, a reload of the
   * page and a box closed out of view. Only this card reads it.
   */
  setState(value: unknown): Promise<void> {
    setStateSignal(() => value);
    return call("state", { value });
  },
  /**
   * Run one of Sova's commands by its catalogue id, as the web app would: the route's own answer.
   * A command that changes something runs once this card's project is trusted; the first time,
   * the card asks the user, and the call is refused with that reason until they agree.
   */
  run<I extends CommandId>(id: I, params: CommandParams[I]): Promise<CommandResult> {
    return call("run", { command: id, params });
  },
  /** Put text at the end of the chat's draft, where the user sees and edits it. It never sends. */
  stage(text: string): Promise<void> {
    return call("stage", { text });
  },
  /**
   * Answer this card (never another): `text`, one line, is the answer in words; `value` any JSON
   * for the view. An at-once card records it now; a gathering one stages it for the next message.
   */
  answerWith(text: string, value?: unknown): Promise<void> {
    return call("answer", { text, ...(value !== undefined ? { value } : {}) });
  },
  /** Ask for a height in px (32 to 1200); without one, the box follows what the view draws. */
  resize(height?: number): void {
    box!.post({ id: 0, call: "resize", args: { height: height ?? null } });
  },
};

/** Draw the view into its box. */
export function mount(view: () => JSX.Element): void {
  const root = document.getElementById("root") ?? document.body;
  render(view, root);
}
