import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { checkExtCard, CARD_TYPES_MAX, type CardDecl } from "../shared/transcript-cards";
import { checkExtDrawing, EXT_DRAWINGS_MAX, GUIDE_MAX_BYTES, PROJECT_OWNER, type DrawingDecl } from "../shared/drawing-kinds";
import type { ExtensionDrawingOffer, ExtensionOffers } from "../shared/protocol";

/**
 * An extension's transcript card types and drawing kinds (§app.extensions/views, ext-contract-v1.17):
 * its manifest entry's `cards` and `drawings`, each checked on its own (a bad one is left out and
 * logged, never the entry or its other declarations), with every `view` and `guide` a file inside
 * its `dist`. They ride in the entry's `offers`, beside its commands and screens, and a chat's
 * snapshot takes them from there (server/transcript-cards.ts).
 */

/** A path inside `dist`, followed through links: the file, or null when it isn't one there. */
export function distFile(dist: string, rel: string): string | null {
  try {
    const root = realpathSync(dist);
    const real = realpathSync(join(root, rel));
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** An entry's `cards` and `drawings` → what it validly declares, and what was left out (for the once-per-process log). */
export function viewOffersOf(ext: { id: string; title: string; dist: string }, raw: { cards?: unknown; drawings?: unknown }): { offers: Pick<ExtensionOffers, "cards" | "drawings">; dropped: string[] } {
  const dropped: string[] = [];
  const offers: Pick<ExtensionOffers, "cards" | "drawings"> = {};
  if (raw.cards === undefined && raw.drawings === undefined) return { offers, dropped };
  // Its namespace is its id: one that is a project's would read as the chat's own project's.
  if (ext.id.toLowerCase() === PROJECT_OWNER) {
    dropped.push(`its cards and drawings: "${PROJECT_OWNER}" is the namespace of a project's own`);
    return { offers, dropped };
  }
  const there = (p: string) => distFile(ext.dist, p) !== null;
  if (raw.cards !== undefined) {
    if (!Array.isArray(raw.cards)) dropped.push("cards is not an array");
    else {
      const cards: CardDecl[] = [];
      for (const c of raw.cards) {
        const r = checkExtCard(ext, c, there);
        if (!r.ok) dropped.push(r.error);
        else if (cards.some((x) => x.type === r.decl.type)) dropped.push(`a second card named ${r.decl.type}`);
        else if (cards.length >= CARD_TYPES_MAX) dropped.push(`${r.decl.type}: past the first ${CARD_TYPES_MAX} cards`);
        else cards.push(r.decl);
      }
      if (cards.length) offers.cards = cards;
    }
  }
  if (raw.drawings !== undefined) {
    if (!Array.isArray(raw.drawings)) dropped.push("drawings is not an array");
    else {
      const drawings: ExtensionDrawingOffer[] = [];
      for (const d of raw.drawings) {
        const r = checkExtDrawing(ext.id, d);
        if (!r.ok) dropped.push(r.error);
        else if (!there(r.view)) dropped.push(`drawing ${r.decl.kind}: view ${r.view} isn't in dist`);
        else if (!there(r.guide)) dropped.push(`drawing ${r.decl.kind}: guide ${r.guide} isn't in dist`);
        else if (drawings.some((x) => x.kind === r.decl.kind)) dropped.push(`a second drawing named ${r.decl.kind}`);
        else if (drawings.length >= EXT_DRAWINGS_MAX) dropped.push(`${r.decl.kind}: past the first ${EXT_DRAWINGS_MAX} drawings`);
        else drawings.push({ ...r.decl, view: r.view, guide: r.guide });
      }
      if (drawings.length) offers.drawings = drawings;
    }
  }
  return { offers, dropped };
}

/** An offered drawing kind as a chat's snapshot takes it: its guide's text read now, so the chat's tool text never changes. */
export function extDrawingDecl(ext: { id: string; title: string; dist: string }, d: ExtensionDrawingOffer): DrawingDecl | null {
  const file = distFile(ext.dist, d.guide);
  if (!file) return null;
  let guide: string;
  try {
    guide = readFileSync(file, "utf8").slice(0, GUIDE_MAX_BYTES);
  } catch {
    return null;
  }
  const { view, guide: _g, ...decl } = d;
  return { ...decl, guide, ext: { id: ext.id, title: ext.title, view } };
}
