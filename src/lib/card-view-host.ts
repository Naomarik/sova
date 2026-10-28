import { viewAnswerOf, type CardInfo } from "../../shared/transcript-cards";

/**
 * The page's half of the view API (§chat.transcript-cards/view-api): what a card's sealed view
 * asks through its box (src/lib/card-box.ts, `op: "api"`), answered for that card only. The page
 * names the card itself (the box's shell is its own), so a view never reaches another card. DOM-
 * free and Solid-free: CardView wires it to the chat's card controls, the tests to fakes.
 *
 * A call is `{id, call, args}`; its answer `{re: id, ok, value | error}`. `resize` takes no answer.
 */

export interface ViewHostDeps {
  card(): CardInfo;
  canAct(): boolean;
  setState(value: unknown): Promise<void>;
  stage(text: string): void;
  /** An at-once answer, recorded now. */
  answerNow(value: { view: unknown }): Promise<unknown>;
  /** A gathering card's pick, staged for the next message. */
  pick(value: { view: unknown }, text: string): void;
  /** The command, run as the card; the server refuses one that changes something until trusted. */
  run(command: string, params: unknown): Promise<{ ok: boolean; status: number; body: unknown }>;
  resize(height: number | null): void;
}

export type ViewReply = { re: number; ok: true; value?: unknown } | { re: number; ok: false; error: string };

const STATE_MAX = 64 * 1024;

/** One call from a view, answered; null for a call that takes no answer or isn't one. */
export async function answerViewCall(raw: unknown, deps: ViewHostDeps): Promise<ViewReply | null> {
  const m = raw as { id?: unknown; call?: unknown; args?: unknown } | null;
  if (!m || typeof m !== "object" || typeof m.id !== "number" || typeof m.call !== "string") return null;
  const re = m.id;
  const args = (m.args && typeof m.args === "object" && !Array.isArray(m.args) ? m.args : {}) as Record<string, unknown>;
  const no = (error: string): ViewReply => ({ re, ok: false, error });
  try {
    switch (m.call) {
      case "resize": {
        const h = args.height;
        deps.resize(typeof h === "number" && Number.isFinite(h) ? Math.round(h) : null);
        return null;
      }
      case "state": {
        let json: string | undefined;
        try {
          json = JSON.stringify(args.value ?? null);
        } catch {
          json = undefined;
        }
        if (json === undefined) return no("state must be JSON.");
        if (new TextEncoder().encode(json).length > STATE_MAX) return no("state is larger than 64 KB.");
        await deps.setState(JSON.parse(json));
        return { re, ok: true };
      }
      case "stage": {
        if (typeof args.text !== "string" || !args.text.trim()) return no("text must be some text.");
        if (!deps.canAct()) return no("This view can't act on its chat: nothing was staged.");
        deps.stage(args.text);
        return { re, ok: true };
      }
      case "answer": {
        const card = deps.card();
        if (card.answerMode === "none") return no(`${card.id} takes no answer.`);
        if (!deps.canAct()) return no("This view can't act on its chat: no answer was recorded.");
        if (card.state !== "open") return no(card.answer ? `${card.id} is already answered: ${card.answer.text}.` : `${card.id} is closed.`);
        const a = viewAnswerOf({ text: args.text, ...(args.value !== undefined ? { value: args.value } : {}) });
        if (!a.ok) return no(a.error);
        const value = a.value as { view: unknown };
        if (card.answerMode === "gather") deps.pick(value, a.text);
        else await deps.answerNow(value);
        return { re, ok: true };
      }
      case "run": {
        if (typeof args.command !== "string") return no("command must be a catalogue id.");
        const r = await deps.run(args.command, args.params ?? {});
        return { re, ok: true, value: r };
      }
      default:
        return no(`${m.call} is not something a view can ask.`);
    }
  } catch (err) {
    return no(err instanceof Error ? err.message : String(err));
  }
}

/** The px a view's box takes: what it drew (or asked for), from 32 to 1200; past that it scrolls inside. */
export const boxHeight = (h: number): number => Math.min(1200, Math.max(32, Math.round(h)));
