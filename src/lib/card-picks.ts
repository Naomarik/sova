// Picks on a gathering transcript card (§chat.transcript-cards/answering): staged per session in this
// browser, like the draft and an alignment card's picks, until the composer sends them. They show in
// the composer's staged answers row ("cd_4 b") and go out as one line per card, "cd_4: b: Parquet.";
// each is recorded as its card's answer once the send succeeds.

import { createSignal } from "solid-js";
import type { CardAnswerValue, CardInfo } from "../../shared/transcript-cards";
import { cardPickLine } from "../../shared/transcript-cards";
import { optionLetter } from "../../shared/view-cards";

export interface CardPick {
  value: CardAnswerValue;
  /** The answer in words, as the line sends it: "b: Parquet". */
  text: string;
}

/** One session's picks, by card id, in the order they were picked. */
export type CardPicks = Readonly<Record<string, CardPick>>;
const NONE: CardPicks = {};

const [byPath, setByPath] = createSignal<Record<string, CardPicks>>({});

export const cardPicksOf = (path: string): CardPicks => byPath()[path] ?? NONE;

/** Stage `pick` for card `id`, or with null clear it. */
export function pickCard(path: string, id: string, pick: CardPick | null): void {
  setByPath((m) => {
    const { [id]: _, ...rest } = m[path] ?? NONE;
    const next = pick ? { ...rest, [id]: pick } : rest;
    const { [path]: __, ...others } = m;
    return Object.keys(next).length ? { ...others, [path]: next } : others;
  });
}

export const clearCardPicks = (path: string) => setByPath(({ [path]: _, ...rest }) => rest);

/** The picks still open: a card answered or replaced since drops its pick. */
export const liveCardPicks = (picks: CardPicks, card: (id: string) => CardInfo | undefined): CardPicks => {
  const out: Record<string, CardPick> = {};
  for (const [id, p] of Object.entries(picks)) if (card(id)?.state === "open") out[id] = p;
  return out;
};

/** A pick in the staged row's short form: "cd_4 b", "cd_5 Deploy", "cd_6 3/4". */
export const cardPickShort = (id: string, p: CardPick): string => {
  const v = p.value;
  const short = "option" in v ? optionLetter(v.option) : "items" in v ? `${v.items.filter(Boolean).length}/${v.items.length}` : p.text;
  return `${id} ${short}`;
};

export const cardPicksLabel = (picks: CardPicks): string => Object.entries(picks).map(([id, p]) => cardPickShort(id, p)).join("; ");
/** What the picks send: one line per card. */
export const cardPicksMessage = (picks: CardPicks): string => Object.entries(picks).map(([id, p]) => cardPickLine(id, p.text)).join("\n");
