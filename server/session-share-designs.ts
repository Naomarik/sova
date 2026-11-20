import { existsSync } from "node:fs";
import { DESIGN_TOOL, isDesignCardDetails, isDesignLabel, type DesignRecord } from "../shared/design";
import type { HEntry } from "../shared/harness";
import {
  SESSION_SHARE_DESIGN_KINDS,
  SESSION_SHARE_DESIGN_MAX_BYTES,
  SESSION_SHARE_DESIGN_NAME_MAX,
  SESSION_SHARE_DESIGN_VIEWS_MAX,
  type SessionShareDesign,
  type SessionShareDesignKind,
  type SessionShareDesignVersion,
  type SessionShareLookbook,
} from "../shared/session-share";
import { designPageDoc, designShellDoc, designStreamDoc, DESIGN_SHARE_SHELL_CSP, DESIGN_STREAM_CSP } from "../src/lib/design-frame";
import { assetNamesIn, readAssets, showAssets } from "./design/assets";
import { pageFile, readDesigns, readPage } from "./design/store";
import { DESIGN_RUN } from "./harness/state-kinds";
import { redactShareLinks } from "./link-tokens";
import { redactPreviewLinks } from "./preview-kept";

/**
 * A share's Lookbooks (§app.session-share/lookbook): the designs of each Lookbook run whose card
 * sits on the shared part of the branch, reduced to what a link's holder may see. An ALLOWLIST,
 * built field by field from the chat's design store (server/design/store.ts): a design's letter,
 * its style and layout names, its model's display name, and each shown version's number, finish
 * time and view names. Nothing else of a run, a design or the Creative Director is ever read into
 * it: no status, error, fix, cost, usage, session, session file, model id, skills, brief, setup,
 * history, internal or pending field, still, or removed design.
 *
 * A run is anchored by the first entry on the share's whole branch that names it: the `lookbook`
 * tool result carrying its card, or its DESIGN_RUN record. It shows only when that entry is inside
 * the slice, and its block rides beside the items (`after`: the item it follows), so items are
 * never renumbered. A design shows with its finished versions only: up to the snapshot's design
 * cut (`designsAt`), or every one while following live; never a page being written, and only a
 * version whose page is on disk. A design with none, or removed, is left out, and so is a run
 * with none.
 *
 * A version's page is served as a walled document (`designDocument`): its text through the page
 * scrub (a message's, its name guesses only where the swap keeps code valid, since unguarded they
 * broke a page's scripts: the caller's `scrubPage`) and both link filters, then its pictures put in (never scrubbed, never
 * read as text), then the app's wall (src/lib/design-frame.ts) around it.
 */

/** A run's anchor on the slice: its id and the item it follows (-1: before the first). */
export interface LookbookAnchor {
  runId: string;
  after: number;
}

/** The run a branch entry anchors, or null: a successful `lookbook` result's card, or a DESIGN_RUN record. */
export function anchoredRun(e: HEntry): string | null {
  if (e.kind === "tool-result") return e.tool === DESIGN_TOOL && !e.isError && isDesignCardDetails(e.details) ? e.details.designCard.runId : null;
  if (e.kind === "state" && e.key === DESIGN_RUN.type) {
    const d = DESIGN_RUN.parse(e.data);
    return d ? d.runId : null;
  }
  return null;
}

/**
 * The anchors of the runs whose FIRST anchor on `branch` lies in its suffix `slice`, in order, each
 * with the item it follows: `itemOf` maps an entry the view shows to its item's `n`. A run anchored
 * before the slice's start is left out whole (its card isn't shared). Pure.
 */
export function lookbookAnchors(branch: readonly HEntry[], slice: readonly HEntry[], itemOf: ReadonlyMap<HEntry, number>): LookbookAnchor[] {
  const before = new Set<string>();
  for (const e of branch.slice(0, branch.length - slice.length)) {
    const r = anchoredRun(e);
    if (r) before.add(r);
  }
  const seen = new Set<string>();
  const out: LookbookAnchor[] = [];
  let after = -1;
  for (const e of slice) {
    const n = itemOf.get(e);
    if (n !== undefined) after = n;
    const r = anchoredRun(e);
    if (!r || before.has(r) || seen.has(r)) continue;
    seen.add(r);
    out.push({ runId: r, after });
  }
  return out;
}

const canonical = (t: unknown): number | null => {
  if (typeof t !== "string") return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
};

/** A name as it goes out: scrubbed, one line, cut to SESSION_SHARE_DESIGN_NAME_MAX. */
function nameOut(raw: unknown, scrub: (s: string) => string): string {
  if (typeof raw !== "string") return "";
  const one = redactShareLinks(redactPreviewLinks(scrub(raw.slice(0, 4 * SESSION_SHARE_DESIGN_NAME_MAX)))).replace(/\s+/g, " ").trim();
  return one.length > SESSION_SHARE_DESIGN_NAME_MAX ? `${one.slice(0, SESSION_SHARE_DESIGN_NAME_MAX - 1).trimEnd()}…` : one;
}

/** Labels in label order: A … Z, then AA …. */
const byLabel = (a: { label: string }, b: { label: string }): number => a.label.length - b.label.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/** The versions of a design a share shows: finished, with a time, by the cut (null: every one), with a page on disk. */
function shownVersions(sessionId: string, d: DesignRecord, designsAt: string | null): DesignRecord["versions"] {
  const until = designsAt === null ? null : canonical(designsAt);
  if (designsAt !== null && until === null) return [];
  return (Array.isArray(d.versions) ? d.versions : []).filter((v) => {
    if (!v || !Number.isSafeInteger(v.n) || v.n < 1) return false;
    const at = canonical(v.at);
    if (at === null || (until !== null && at > until)) return false;
    return existsSync(pageFile(sessionId, d.label, v.n));
  });
}

/** The designs of one run a share shows, by label, before any field leaves the store. */
function shownDesigns(sessionId: string, runId: string, designsAt: string | null): { d: DesignRecord; versions: DesignRecord["versions"] }[] {
  const s = readDesigns(sessionId);
  const run = s.runs.find((r) => r.id === runId);
  if (!run) return [];
  const out: { d: DesignRecord; versions: DesignRecord["versions"] }[] = [];
  for (const d of s.designs) {
    if (d.runId !== run.id || d.removed || !isDesignLabel(d.label)) continue;
    const versions = shownVersions(sessionId, d, designsAt);
    if (versions.length) out.push({ d, versions });
  }
  return out.sort((a, b) => byLabel(a.d, b.d));
}

/** One design as it goes out: the allowlist, field by field. */
function designOut(d: DesignRecord, versions: DesignRecord["versions"], scrub: (s: string) => string): SessionShareDesign {
  const layout = nameOut(d.layout, scrub);
  return {
    label: d.label,
    style: nameOut(d.direction, scrub),
    ...(layout ? { layout } : {}),
    modelName: nameOut(d.modelName, scrub),
    versions: versions.map((v): SessionShareDesignVersion => {
      const views = (Array.isArray(v.views) ? v.views : [])
        .slice(0, SESSION_SHARE_DESIGN_VIEWS_MAX)
        .map((x) => nameOut(x?.name, scrub))
        .filter(Boolean);
      return { n: v.n, at: new Date(canonical(v.at)!).toISOString(), ...(views.length ? { views } : {}) };
    }),
  };
}

/** The Lookbooks of a view, in anchor order: each run's shown designs, a run with none left out. */
export function shareLookbooks(sessionId: string, anchors: readonly LookbookAnchor[], designsAt: string | null, scrub: (s: string) => string): SessionShareLookbook[] {
  const out: SessionShareLookbook[] = [];
  for (const a of anchors) {
    const designs = shownDesigns(sessionId, a.runId, designsAt).map(({ d, versions }) => designOut(d, versions, scrub));
    if (designs.length) out.push({ id: `lb${out.length + 1}`, after: a.after, designs });
  }
  return out;
}

/** Whether any shown version's page uses a picture captured from a signed-in page (the operator's preview says so). */
export function lookbooksUseSignedIn(sessionId: string, anchors: readonly LookbookAnchor[], designsAt: string | null): boolean {
  const signedIn = new Set<string>();
  for (const c of readAssets(sessionId).captures ?? []) if (c?.signedIn) for (const n of c.names ?? []) signedIn.add(n);
  if (!signedIn.size) return false;
  for (const a of anchors)
    for (const { d, versions } of shownDesigns(sessionId, a.runId, designsAt))
      for (const v of versions) if (assetNamesIn(readPage(sessionId, d.label, v.n) ?? "").some((n) => signedIn.has(n))) return true;
  return false;
}

export const isShareDesignKind = (k: unknown): k is SessionShareDesignKind => typeof k === "string" && (SESSION_SHARE_DESIGN_KINDS as readonly string[]).includes(k);

/** A design document's header policy: the wall's own policy, under a sandbox (an opaque origin, whatever host serves it), framable by its own host only.
    A running page's shell is the share variant: its page is a `blob:` document, so nothing the page can read (its
    address, base URL, referrer) holds the link the shell is served under. */
export function designDocumentCsp(kind: SessionShareDesignKind): string {
  return kind === "page" || kind === "tile" ? `sandbox allow-scripts allow-forms; ${DESIGN_SHARE_SHELL_CSP}; frame-ancestors 'self'` : `sandbox; ${DESIGN_STREAM_CSP}; frame-ancestors 'self'`;
}

/** Every header a design document is served with (the share listener and the operator's preview alike). */
export const designDocumentHeaders = (kind: SessionShareDesignKind): Record<string, string> => ({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": designDocumentCsp(kind),
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
});

/**
 * The walled document of version `n` of design `label`, when this view shows it (the anchors and
 * the cut it was built at), else null. `page` and `tile` run the page's scripts inside the app's
 * two frames; `still` and `tile-still` run none. Tiles get small pictures and hold motion. A
 * document past SESSION_SHARE_DESIGN_MAX_BYTES falls back to small pictures, then to none (null).
 */
export function designDocument(
  sessionId: string,
  anchors: readonly LookbookAnchor[],
  designsAt: string | null,
  label: string,
  n: number,
  kind: SessionShareDesignKind,
  scrubPage: (s: string) => string,
): string | null {
  if (!isDesignLabel(label) || !Number.isSafeInteger(n) || n < 1 || !isShareDesignKind(kind)) return null;
  const shown = anchors.some((a) => shownDesigns(sessionId, a.runId, designsAt).some(({ d, versions }) => d.label === label && versions.some((v) => v.n === n)));
  if (!shown) return null;
  const raw = readPage(sessionId, label, n);
  if (raw === null) return null;
  // The author's text is scrubbed as code (its scripts must still parse); the pictures, put in after, never are.
  const text = redactShareLinks(redactPreviewLinks(scrubPage(raw)));
  const tile = kind === "tile" || kind === "tile-still";
  const wrap = (html: string): string => (kind === "page" || kind === "tile" ? designShellDoc(designPageDoc(html, { motion: !tile }), { share: true }) : designStreamDoc(html));
  for (const size of tile ? (["small"] as const) : (["full", "small"] as const)) {
    const doc = wrap(showAssets(sessionId, text, size));
    if (Buffer.byteLength(doc) <= SESSION_SHARE_DESIGN_MAX_BYTES) return doc;
  }
  return null;
}
