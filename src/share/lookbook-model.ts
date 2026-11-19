/**
 * A shared session's Lookbooks (§app.session-share/content): DOM-free helpers the share page, its
 * design page and the tests use. Each Lookbook in the view sits in the conversation after the item
 * whose reply carried its card (`after`), and shows each design's finished versions only. Nothing
 * here knows of the Creative Director, a design's chat, its cost or its status: none of it is on
 * the wire.
 */
import type { SessionShareDesign, SessionShareDesignKind, SessionShareLookbook, SessionShareView } from "../../shared/session-share";
import { versionLabel } from "../lib/design-frame";

export { versionLabel };

/** The block's title. */
export const lookbookTitle = (n: number): string => `Lookbook · ${n} ${n === 1 ? "design" : "designs"}`;

/** A design's direction: its style and layout, as far as it has them. */
export const designDirection = (d: Pick<SessionShareDesign, "style" | "layout">): string => [d.style, d.layout].filter((s): s is string => !!s && !!s.trim()).join(" · ");

/** The newest finished version (versions arrive ascending). */
export const latestVersion = (d: SessionShareDesign): number => d.versions.at(-1)?.n ?? 0;

/** The version on show: the one asked for while the design still has it, else its newest. */
export const versionShown = (d: SessionShareDesign, asked: number | null | undefined): number =>
  asked != null && d.versions.some((x) => x.n === asked) ? asked : latestVersion(d);

/** The one quiet line where a browser can't wall off a page's code (§chat.design-mode/prototype-frame). */
export const STILL_LINE = "Shown still: this browser can't run designs safely. They run in Chrome and Edge.";

/** Whether this browser can wall off a running page (CSP Embedded Enforcement, Chrome-family):
    then a design runs; elsewhere it is a still page with no scripts. */
export const runsDesigns = (iframeProto: object | undefined): boolean => !!iframeProto && "csp" in iframeProto;

// ---- placement ----------------------------------------------------------------------------------

export interface LookbookPlacement {
  /** Lookbooks before the first item shown (their card sat before it, and nothing earlier is left to load). */
  top: SessionShareLookbook[];
  /** Lookbooks by the item `n` they follow. */
  after: Map<number, SessionShareLookbook[]>;
}

/**
 * Where each Lookbook goes among the items on show. A Lookbook after an item not on show waits for
 * that page (Show Earlier); one anchored before the first item shows on top only when no earlier
 * page is left to read. Items are never renumbered.
 */
export function placeLookbooks(view: Pick<SessionShareView, "items" | "before"> & { lookbooks?: SessionShareLookbook[] }): LookbookPlacement {
  const top: SessionShareLookbook[] = [];
  const after = new Map<number, SessionShareLookbook[]>();
  const shown = new Set(view.items.map((i) => i.n));
  const first = view.items[0]?.n ?? Infinity;
  for (const lb of view.lookbooks ?? []) {
    if (!lb.designs.length) continue;
    if (shown.has(lb.after)) after.set(lb.after, [...(after.get(lb.after) ?? []), lb]);
    else if (lb.after < first && view.before === undefined) top.push(lb);
  }
  return { top, after };
}

// ---- the address --------------------------------------------------------------------------------

/** The open design. A label is unique in the session, so it names the design. */
export interface DesignAddress {
  label: string;
  /** Absent: the newest version (it follows a newer one in). */
  v?: number;
}

const LABEL = /^[A-Z]{1,4}$/;
const NUM = /^[1-9][0-9]{0,5}$/;

/** On the conversation, the open design is in the address so Back and reload keep it: `#design=<label>[/<n>]`. */
export function designHash(a: DesignAddress): string {
  return `#design=${a.label}${a.v ? `/${a.v}` : ""}`;
}

export function parseDesignHash(hash: string): DesignAddress | null {
  const m = /^#design=([^/]+)(?:\/([^/]+))?$/.exec(hash);
  if (!m || !LABEL.test(m[1]!) || (m[2] !== undefined && !NUM.test(m[2]))) return null;
  return m[2] ? { label: m[1]!, v: Number(m[2]) } : { label: m[1]! };
}

/** A design's own page under the share link (Open in New Tab): `/s/<token>?design=<label>[&v=<n>]`. */
export function designPagePath(token: string, a: DesignAddress): string {
  return `/s/${token}?design=${a.label}${a.v ? `&v=${a.v}` : ""}`;
}

/** The design a `/s/` page's query names (its own page), or null for the conversation. */
export function parseDesignQuery(search: string): DesignAddress | null {
  const p = new URLSearchParams(search);
  const label = p.get("design");
  if (label === null || !LABEL.test(label)) return null;
  const v = p.get("v");
  return v !== null && NUM.test(v) ? { label, v: Number(v) } : { label };
}

// ---- where a design is drawn from -----------------------------------------------------------------

/**
 * Where a page draws its designs from: the share link's own addresses, or the operator's Preview's.
 *   doc   a version's document: `page` runs its code (Chrome-family only), `still` runs none,
 *         `tile` / `tile-still` the same with small pictures and motion held
 *   page  the design's own page under the share link (Open in New Tab); absent in a Preview
 *   load  the document's text, to frame as `srcdoc` instead of by address: the operator's Preview of
 *         a peer's share, whose relay never answers HTML as a page. Absent: framed by `doc`'s address.
 */
export interface DesignUrls {
  doc(label: string, n: number, kind: SessionShareDesignKind): string;
  page?(a: DesignAddress): string;
  load?(label: string, n: number, kind: SessionShareDesignKind): Promise<string>;
}

/** The kind a frame asks for. */
export const designKind = (runs: boolean, tile: boolean): SessionShareDesignKind => (tile ? (runs ? "tile" : "tile-still") : runs ? "page" : "still");

/** A share link's design addresses, all under its token (server/share/session-routes.ts). */
export function shareDesignUrls(token: string): DesignUrls {
  return {
    doc: (label, n, kind) => `/api/s/${token}/d/${encodeURIComponent(label)}/${n}/${kind}`,
    page: (a) => designPagePath(token, a),
  };
}

/** Every design of the view, and the Lookbook it is in, by label. */
export function findDesign(lookbooks: readonly SessionShareLookbook[] | undefined, label: string): { lookbook: SessionShareLookbook; design: SessionShareDesign } | null {
  for (const lookbook of lookbooks ?? []) {
    const design = lookbook.designs.find((d) => d.label === label);
    if (design) return { lookbook, design };
  }
  return null;
}

// ---- stepping -----------------------------------------------------------------------------------

/** The design before or after one in its Lookbook, wrapping; null when it has no other. */
export function stepDesign(lb: SessionShareLookbook, label: string, by: -1 | 1): SessionShareDesign | null {
  const n = lb.designs.length;
  if (n < 2) return null;
  const i = lb.designs.findIndex((d) => d.label === label);
  return lb.designs[(((i < 0 ? 0 : i) + by) % n + n) % n] ?? null;
}

/** A version's name in the picker: "Version 2 · Nov 3, 2:06 PM". */
export function versionOption(v: { n: number; at: string }): string {
  const t = new Date(v.at);
  const when = Number.isNaN(t.getTime()) ? "" : ` · ${t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  return `Version ${v.n}${when}`;
}
