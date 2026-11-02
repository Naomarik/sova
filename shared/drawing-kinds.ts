/**
 * A project's or an extension's own drawing kinds (§chat.transcript-cards/drawing-kinds): the
 * declaration (a project's `.sova/drawings/<name>/kind.json`, an extension manifest's `drawings`
 * entry, §app.extensions/views), checked strictly; the kind as a session's snapshot holds it; and a
 * `vis <owner>.<name>` fence's body read against it. Pure and DOM-free: the server, the vis retry
 * and the page all read it.
 *
 * An own kind's fence word always has a dot (`<owner>.<name>`), and none of Sova's kinds has one,
 * so an own kind can never be read as, replace or change one of Sova's (ownKindWordError).
 */

import { checkViewData, schemaError } from "./card-schema.ts";
import { cardDataErrorText } from "./view-cards.ts";

export const DRAWINGS_DIR = ".sova/drawings";
export const KIND_FILE = "kind.json";
export const DRAWING_VIEW_FILE = "view.tsx";
export const GUIDE_FILE = "GUIDE.md";
/** At most this many of a project's kinds count; an extension declares at most 8. */
export const PROJECT_DRAWINGS_MAX = 8;
export const EXT_DRAWINGS_MAX = 8;
export const KIND_FILE_MAX_BYTES = 64 * 1024;
/** A kind's guide, as the agent reads it, at most. */
export const GUIDE_MAX_BYTES = 16 * 1024;
/** A fence's body, at most (its data is a card's, §chat.transcript-cards/files). */
export const DRAWING_BODY_MAX = 64 * 1024;
/** A kind's name after its owner: as a card type's. */
export const KIND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** The owner a project's kinds and cards are namespaced under. */
export const PROJECT_OWNER = "project";

export type DrawingAccepts = "text" | "data";

/** One drawing kind, as a session's snapshot holds it. */
export interface DrawingDecl {
  /** The fence word: `<owner>.<name>`, lowercase. */
  kind: string;
  accepts: DrawingAccepts;
  /** accepts data: the shape its data must have (shared/card-schema.ts). */
  data?: unknown;
  /** Its box's reserved height in px. */
  height?: number;
  toolkit: number;
  /** The guide the agent reads (GUIDE.md, or the extension's guide file), as it was when the chat started. */
  guide: string;
  /** An extension's: its id and title, and its view's path inside `dist`. */
  ext?: { id: string; title: string; view: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why a namespaced fence word can't be an own kind's (no dot, an empty owner, a bad name), or null.
 * Sova's kinds have no dot: a word without one is never an own kind.
 */
export function ownKindWordError(word: string): string | null {
  const dot = word.lastIndexOf(".");
  if (dot < 0) return "an own kind is named <owner>.<name>; a name without a dot is one of Sova's kinds";
  const owner = word.slice(0, dot);
  const name = word.slice(dot + 1);
  if (!owner || !/^[a-z0-9._-]+$/.test(owner) || owner === "." || owner === "..") return "its owner must be project or an extension's id";
  if (!KIND_NAME_RE.test(name)) return "its name must be lowercase letters, digits and hyphens starting with a letter, at most 32 characters";
  return null;
}

/** The body checks a kind's declaration shares, wherever it was declared; the first wrong thing, or the kind. */
function checkKind(raw: Record<string, unknown>, kind: string): { ok: true; decl: Omit<DrawingDecl, "guide" | "ext"> } | { ok: false; error: string } {
  if (typeof raw.toolkit !== "number" || !Number.isInteger(raw.toolkit) || raw.toolkit < 1) return { ok: false, error: "toolkit must be the toolkit version its view was built for (this Sova runs 1)." };
  if (raw.accepts !== "text" && raw.accepts !== "data") return { ok: false, error: 'accepts must be "text" or "data".' };
  if (raw.accepts === "data") {
    if (!isObject(raw.data)) return { ok: false, error: "A kind that accepts data needs data, the shape its data must have." };
    const bad = schemaError(raw.data);
    if (bad) return { ok: false, error: bad };
  } else if (raw.data !== undefined) return { ok: false, error: "data is only for a kind that accepts data." };
  if (raw.height !== undefined && (typeof raw.height !== "number" || !Number.isInteger(raw.height) || raw.height < 32 || raw.height > 1200)) return { ok: false, error: "height must be a whole number of px from 32 to 1200." };
  return {
    ok: true,
    decl: {
      kind,
      accepts: raw.accepts,
      ...(raw.accepts === "data" ? { data: raw.data } : {}),
      ...(typeof raw.height === "number" ? { height: raw.height } : {}),
      toolkit: raw.toolkit,
    },
  };
}

const KIND_FILE_KEYS = ["version", "toolkit", "accepts", "data", "height"];

/** A project folder's `kind.json`, checked strictly: its kind as `project.<name>` (guide still to add), or what is wrong. */
export function parseKindFile(name: string, text: string, hasView: boolean, hasGuide: boolean): { ok: true; decl: Omit<DrawingDecl, "guide" | "ext"> } | { ok: false; error: string } {
  if (!KIND_NAME_RE.test(name)) return { ok: false, error: "The folder's name isn't lowercase letters, digits and hyphens starting with a letter, at most 32 characters." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${KIND_FILE} isn't JSON.` };
  }
  if (!isObject(raw)) return { ok: false, error: `${KIND_FILE} isn't a JSON object.` };
  for (const k of Object.keys(raw)) if (!KIND_FILE_KEYS.includes(k)) return { ok: false, error: `"${k}" is not a key ${KIND_FILE} has.` };
  if (raw.version !== 1) return { ok: false, error: "version must be 1." };
  if (!hasView) return { ok: false, error: `${DRAWING_VIEW_FILE} is missing.` };
  if (!hasGuide) return { ok: false, error: `${GUIDE_FILE} is missing: the agent reads it to draw this kind.` };
  return checkKind(raw, `${PROJECT_OWNER}.${name}`);
}

const EXT_DRAWING_KEYS = ["name", "accepts", "data", "height", "view", "guide", "toolkit"];

/**
 * An extension manifest's `drawings` entry (§app.extensions/views), checked on its own: its kind as
 * `<extension id>.<name>` with its `view` and `guide` paths inside `dist` (still to be found there),
 * or what is wrong.
 */
export function checkExtDrawing(extId: string, raw: unknown): { ok: true; decl: Omit<DrawingDecl, "guide" | "ext">; view: string; guide: string } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "a drawing isn't an object" };
  const label = typeof raw.name === "string" ? `drawing ${JSON.stringify(raw.name)}` : "a drawing";
  for (const k of Object.keys(raw)) if (!EXT_DRAWING_KEYS.includes(k)) return { ok: false, error: `${label}: "${k}" is not a key a drawing has` };
  if (typeof raw.name !== "string" || !KIND_NAME_RE.test(raw.name)) return { ok: false, error: `${label}: name must be lowercase letters, digits and hyphens starting with a letter, at most 32 characters` };
  const view = distPathError(raw.view);
  if (view) return { ok: false, error: `${label}: view ${view}` };
  const guide = distPathError(raw.guide);
  if (guide) return { ok: false, error: `${label}: guide ${guide}` };
  const c = checkKind(raw, `${extId.toLowerCase()}.${raw.name}`);
  if (!c.ok) return { ok: false, error: `${label}: ${c.error.replace(/\.$/, "")}` };
  return { ok: true, decl: c.decl, view: raw.view as string, guide: raw.guide as string };
}

/** Why a manifest path isn't a plain relative path inside `dist`, or null. Whether it is there is the server's to check. */
export function distPathError(p: unknown): string | null {
  if (typeof p !== "string" || !p) return "must be a path inside dist";
  if (p.startsWith("/") || p.includes("\\") || /^[a-z]+:/i.test(p)) return "must be a relative path inside dist";
  if (p.split("/").some((s) => s === ".." || s === "")) return "must stay inside dist";
  return null;
}

/** A stored kind read back; anything that isn't one reads as none. */
export function normalizeDrawingDecl(v: unknown): DrawingDecl | null {
  if (!isObject(v) || typeof v.kind !== "string" || ownKindWordError(v.kind)) return null;
  if ((v.accepts !== "text" && v.accepts !== "data") || typeof v.toolkit !== "number" || typeof v.guide !== "string") return null;
  const ext = isObject(v.ext) && typeof v.ext.id === "string" && typeof v.ext.title === "string" && typeof v.ext.view === "string" ? { id: v.ext.id, title: v.ext.title, view: v.ext.view } : undefined;
  return {
    kind: v.kind,
    accepts: v.accepts,
    ...(v.data !== undefined ? { data: v.data } : {}),
    ...(typeof v.height === "number" ? { height: v.height } : {}),
    toolkit: v.toolkit,
    guide: v.guide,
    ...(ext ? { ext } : {}),
  };
}

/** What an own kind's fence gives its view: the body as text, or its data; and the figure's title and caption. */
export interface OwnDrawing {
  kind: string;
  title?: string;
  caption?: string;
  /** The body: the text (accepts text), or the parsed, checked JSON (accepts data). */
  data: unknown;
}

/**
 * A `vis <owner>.<name>` fence's body read against its kind: an optional `title:` first line and
 * `caption:` last line (as Sova's kinds have), then the text, or JSON that fits the kind's shape.
 * The error says the line and what to write instead, as parseVis's do.
 */
export function parseOwnDrawing(decl: Pick<DrawingDecl, "kind" | "accepts" | "data">, body: string): { ok: true; drawing: OwnDrawing } | { ok: false; line: number; message: string } {
  if (body.length > DRAWING_BODY_MAX) return { ok: false, line: 0, message: `the block is over ${DRAWING_BODY_MAX / 1024} KB` };
  const lines = body.replace(/\n$/, "").split("\n");
  let first = 0;
  let last = lines.length;
  let title: string | undefined;
  let caption: string | undefined;
  const t = /^title:\s*(.*)$/.exec(lines[0] ?? "");
  if (t) {
    title = t[1]!.trim().slice(0, 200) || undefined;
    first = 1;
  }
  const c = last > first ? /^caption:\s*(.*)$/.exec(lines[last - 1] ?? "") : null;
  if (c) {
    caption = c[1]!.trim().slice(0, 200) || undefined;
    last -= 1;
  }
  const text = lines.slice(first, last).join("\n");
  const head = { kind: decl.kind, ...(title ? { title } : {}), ...(caption ? { caption } : {}) };
  if (decl.accepts === "text") {
    if (!text.trim()) return { ok: false, line: 0, message: `write what to draw as this ${decl.kind} block's body` };
    return { ok: true, drawing: { ...head, data: text } };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const m = /position (\d+)/.exec(err instanceof Error ? err.message : "");
    const line = m ? text.slice(0, Number(m[1])).split("\n").length + first : 0;
    return { ok: false, line, message: `the body must be JSON in the shape vis_guide gives for ${decl.kind}` };
  }
  const checked = checkViewData(decl.data, data);
  if (!checked.ok) return { ok: false, line: 0, message: `its data doesn't fit ${decl.kind}: ${cardDataErrorText(checked.error)}` };
  return { ok: true, drawing: { ...head, data: checked.data } };
}

/** The own kind a fence word names in a chat's kinds, matched as written (fence words are lowercase). */
export const ownKindOf = <K extends Pick<DrawingDecl, "kind">>(kinds: readonly K[] | undefined, word: string): K | undefined => kinds?.find((k) => k.kind === word.toLowerCase());

/** One line per own kind for the vis_guide tool's words: its fence and what it takes. */
export const ownKindLine = (d: DrawingDecl): string => `vis ${d.kind} (${d.accepts === "data" ? "JSON data" : "text"}${d.ext ? `, from ${d.ext.title}` : ", this project's"})`;
