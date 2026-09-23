// /explain artifacts: what the report row, the per-session strip and the gallery need to know
// about them. No fetching here — the transcript carries `explain`, the sidebar polls the store.

import type { ExplanationInfo, ReportInfo, TranscriptItem } from "../../shared/protocol";
import { relativeTime, shortModel } from "./format";

/** Inner width the standalone page is laid out at before a thumbnail scales it down. */
export const THUMB_WIDTH = 1280;

/**
 * The theme the app is wearing. Sova is dark unless `<html data-theme="light">` (tokens.css
 * §3), so this reads the element, not prefers-color-scheme.
 */
export const appTheme = (): "dark" | "light" => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

/** The standalone page for one explanation, in the theme the app is wearing. */
export const explainHref = (id: string) => `/explain/${encodeURIComponent(id)}?theme=${appTheme()}`;

/** The explanation a report row carries, when it is an explain-doc row. */
export const explainOf = (r: ReportInfo): ExplanationInfo | undefined => r.explain;

/** Newest first, the order every surface lists them in (the server sends this order too). */
export const newestFirst = (list: readonly ExplanationInfo[]): ExplanationInfo[] =>
  [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/**
 * How a row should read. `running` comes first — the explainer is still writing, there is no page
 * yet, and whatever else the entry carries is not its verdict. `error` is fatal — the run wrote no
 * servable page, so nothing may link to it. `note` is advisory — the page is complete and good,
 * but the run then errored or was aborted; the page is the deliverable, so the link stays and the
 * note explains itself. Fatal wins if both are somehow set.
 *
 * Structural parameter, like `explainModel`: `status` is newer than the rest of `ExplanationInfo`.
 */
export type ExplainState = "running" | "ok" | "failed" | "noted";

export function explainState(info: { status?: string; error?: string; note?: string }): ExplainState {
  if (info.status === "running") return "running";
  if (info.error) return "failed";
  if (info.note) return "noted";
  return "ok";
}

/** The explain id a transcript row carries, when it is an explain-doc row. */
const explainIdOf = (item: TranscriptItem): string | undefined => item.report?.explain?.id;

/**
 * Live-appended rows onto a transcript. An /explain run writes two entries with the same id — a
 * running one at spawn, a finished one at settle — and live appends arrive undeduped, so an
 * explain row replaces the row already carrying its id, where that row sits: the card upgrades in
 * place instead of jumping to the bottom. Every other row is appended, as before.
 */
export function appendItems(list: readonly TranscriptItem[], incoming: readonly TranscriptItem[]): TranscriptItem[] {
  const next = [...list];
  for (const item of incoming) {
    const id = explainIdOf(item);
    const at = id === undefined ? -1 : next.findIndex((row) => explainIdOf(row) === id);
    if (at === -1) next.push(item);
    else next[at] = item;
  }
  return next;
}

/**
 * The model that wrote the page, without its provider ("zai/glm-5.3" → "glm-5.3"); null when the
 * entry doesn't name one (an older extension, or an older stored meta.json).
 *
 * Structural parameter, not `ExplanationInfo`: `model` is the newest field on that interface, and
 * this keeps the frontend compiling against a protocol that doesn't carry it yet.
 */
export const explainModel = (info: { model?: string }): string | null => shortModel(info.model);

/** A gallery tile's caption: "2h ago · glm-5.3", the model dropped when the entry doesn't name one. */
export const explainCaption = (info: { createdAt: string; model?: string }, now: number): string =>
  [relativeTime(info.createdAt, now), explainModel(info)].filter(Boolean).join(" · ");

/** "3 explanations from this session" / "1 explanation across all sessions". */
export const galleryTitle = (n: number, scope: "session" | "all") =>
  `${n} ${n === 1 ? "explanation" : "explanations"} ${scope === "session" ? "from this session" : "across all sessions"}`;
