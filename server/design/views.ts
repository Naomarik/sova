// A design's views (al_1 step 17): what each version's page names (server/design/view-marks.ts), the browser pass that
// clicks its way to each one after the version is kept, the pictures that pass leaves for later looks, and a look at one
// view of one version at one width. The pass only warns: a view it can't reach, or one whose click changes nothing, is
// marked on the version and never sends the page back.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignVersion, DesignView } from "../../shared/design";
import type { TourSize } from "../../shared/tour";
import type { TourWalkAction } from "../tours/runner-protocol";
import { pageTokens } from "./lint";
import { pngDifference } from "./png-diff";
import { DesignWalkFailure, lookAtDesign, walkDesign, type DesignLookDeps, type DesignWalkStep } from "./look";
import type { BrowseParent } from "./browse";
import { showAssets } from "./assets";
import { changeDesign, designChatDeleted, designDirOf, designOf, readPage } from "./store";
import { readViews, viewKey, viewPath, viewTestId, withViewIds, type PageView } from "./view-marks";

/** The views a page names and what is wrong with how it names them. */
export const pageViews = (html: string): { views: PageView[]; problems: string[] } => readViews(pageTokens(html), html);

/** The views a version keeps when it is made: each still to be clicked. Absent when the page names none. */
export function versionViews(html: string): DesignView[] | undefined {
  const { views } = pageViews(html);
  return views.length ? views.map((v) => ({ name: v.name, ...(v.via ? { via: v.via } : {}), source: v.source, state: "unchecked" as const })) : undefined;
}

/** One line naming a version's views for a model's read: "" when it names none. */
export function viewsLine(v: Pick<DesignVersion, "views">): string {
  const views = v.views ?? [];
  if (!views.length) return "";
  const start = views.find((x) => x.start);
  const one = (x: DesignView): string => {
    const notes = [x.via ? `via ${x.via}` : "", x.start ? "the first screen" : "", x.state === "unreachable" ? `unreachable: ${x.problem ?? "its control couldn't be clicked"}` : x.state === "unchanged" ? "unchanged: clicking it left the screen as it was" : ""].filter(Boolean);
    return notes.length ? `${x.name} (${notes.join("; ")})` : x.name;
  };
  const names = [...(start ? [] : ["the first screen"]), ...views.map(one)];
  const found = views[0]!.source === "found" ? " (found from its tabs; the page declares none)" : "";
  const unchecked = views.every((x) => x.state === "unchecked") ? " · not yet checked in a browser" : "";
  return `Views${found}: ${names.join(" · ")}${unchecked}`;
}

/** A read's views line for a version whose page is `html`: its kept views, or for a version saved before views were
    kept, the ones its page names (not yet checked in a browser). */
export const viewsLineFor = (v: Pick<DesignVersion, "views">, html: string | null): string => viewsLine(v.views || html === null ? v : { views: versionViews(html) });

/** The view a look asks for, by name whatever its case; throws naming the views there are. */
export function pickView(views: readonly DesignView[], asked: string, what: string): DesignView {
  const v = views.find((x) => viewKey(x.name) === viewKey(asked));
  if (v) return v;
  const there = views.length ? `Its views: the first screen, ${views.map((x) => x.name).join(", ")}.` : "Its page names no views: only its first screen (look without view, or walk there with actions).";
  throw new Error(`${what} has no view "${asked}". ${there}`);
}

/** The clicks from a fresh load to a view: each control on its path, by the test id the served copy gives it. */
function clicksTo(views: readonly PageView[], name: string): TourWalkAction[] | null {
  const path = viewPath(views, name);
  if (!path) return null;
  return path.map((n) => ({ op: "click", target: { kind: "testId", testId: viewTestId(views.findIndex((v) => viewKey(v.name) === viewKey(n))) } }) as TourWalkAction);
}

// ---- kept pictures ------------------------------------------------------------------------------

const keptDir = (sid: string, label: string, n: number): string => join(designDirOf(sid), label, "views", `v${n}`);
/** The file name of one view's kept picture: the first screen, or a view by its place in the version's list. */
const keptName = (view: number | "start", size: TourSize): string => `${view === "start" ? "start" : `view-${view}`}.${size}`;

function keep(sid: string, label: string, n: number, view: number | "start", size: TourSize, png: Uint8Array, outline: string): void {
  if (designChatDeleted(sid)) return;
  const dir = keptDir(sid, label, n);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [ext, data] of [["png", png], ["txt", outline]] as const) {
    const f = join(dir, `${keptName(view, size)}.${ext}`);
    writeFileSync(`${f}.tmp`, data, { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }
}

function kept(sid: string, label: string, n: number, view: number | "start", size: TourSize): { png: Uint8Array; outline: string } | null {
  const base = join(keptDir(sid, label, n), keptName(view, size));
  if (!existsSync(`${base}.png`)) return null;
  try {
    return { png: new Uint8Array(readFileSync(`${base}.png`)), outline: readFileSync(`${base}.txt`, "utf8") };
  } catch {
    return null;
  }
}

// ---- the pass after a version is kept -------------------------------------------------------------

/** Two pictures of the same screen: next to nothing differs (the walk pictures each screen with the mouse off the page,
    so no control is drawn hovered). A menu or a panel that opens changes far more. */
export const VIEW_UNCHANGED_SHARE = 0.001;
const same = (a: Uint8Array, b: Uint8Array): boolean => pngDifference(a, b) <= VIEW_UNCHANGED_SHARE;

/** How long one pass may take: a fresh load per screen. */
const passMs = (screens: number): number => Math.min(240_000, 30_000 + 8_000 * screens);

/**
 * Click the way to each view of one version at desktop width, from a fresh load each time, and mark what was found:
 * unreachable when a control on the way couldn't be clicked; unchanged when the screen after the click is the screen
 * before it. One browser for the whole version; when a view can't be reached, the walk goes again without it (and
 * without the views reached through it). The pictures are kept for later looks.
 */
export async function checkVersionViews(parent: BrowseParent, label: string, n: number, deps: DesignLookDeps = {}): Promise<DesignView[] | null> {
  const sid = parent.sessionId;
  const html = (deps.readPage ?? readPage)(sid, label, n);
  if (!html) return null;
  const { views } = pageViews(html);
  if (!views.length) return null;
  const served = (deps.showAssets ?? showAssets)(sid, withViewIds(html, views), "full");
  const found = new Map<number, Pick<DesignView, "state" | "problem">>();
  const pictures = new Map<number | "start", { png: Uint8Array; outline: string }>();
  let left = views.map((_, i) => i);
  for (let tries = 0; tries <= views.length && (left.length || !pictures.has("start")); tries++) {
    const steps: DesignWalkStep[] = [...(pictures.has("start") ? [] : [{ id: "start", actions: [] }]), ...left.map((i) => ({ id: `view-${i}`, actions: clicksTo(views, views[i]!.name) ?? [] }))];
    try {
      const out = await walkDesign(parent, label, served, ["desktop"], steps, deps, passMs(steps.length));
      for (const [id, r] of out) pictures.set(id === "start" ? "start" : Number(id.slice(5)), { png: r.shots[0]!.png, outline: r.outline });
      left = [];
    } catch (err) {
      const id = err instanceof DesignWalkFailure ? err.stepId : undefined;
      const i = id?.startsWith("view-") ? Number(id.slice(5)) : NaN;
      // The first screen itself, or the browser: nothing more can be learned on this pass.
      if (!Number.isInteger(i) || !left.includes(i)) {
        console.error(`[design] ${label}${n}'s views couldn't be checked:`, err instanceof Error ? err.message : err);
        return null;
      }
      const message = (err as Error).message;
      found.set(i, { state: "unreachable", problem: message });
      // A view reached through it can't be reached either.
      for (const j of left) if (j !== i && viewPath(views, views[j]!.name)?.some((x) => viewKey(x) === viewKey(views[i]!.name))) found.set(j, { state: "unreachable", problem: `its way there goes through ${views[i]!.name}, which couldn't be opened` });
      left = left.filter((j) => !found.has(j));
    }
  }
  const start = pictures.get("start");
  if (!start) return null;
  const byKey = new Map(views.map((v, i) => [viewKey(v.name), i] as const));
  for (const [i, v] of views.entries()) {
    if (found.has(i)) continue;
    const mine = pictures.get(i);
    if (!mine) continue;
    const before = v.via === undefined ? start : pictures.get(byKey.get(viewKey(v.via)) ?? -1);
    found.set(i, before && same(mine.png, before.png) ? { state: "unchanged" } : { state: "ok" });
  }
  // A tab already selected as the page opens leaves it unchanged: when exactly one view on the first screen does (or,
  // of several, exactly one says it is selected), it is the first screen, and gives it its name.
  const unchangedTop = views.flatMap((v, i) => (v.via === undefined && found.get(i)?.state === "unchanged" ? [i] : []));
  const marked = unchangedTop.filter((i) => views[i]!.selected);
  const startAt = unchangedTop.length === 1 ? unchangedTop[0] : marked.length === 1 ? marked[0] : undefined;
  const result: DesignView[] = views.map((v, i) => {
    const f = found.get(i) ?? { state: "unchecked" as const };
    const isStart = startAt === i;
    return { name: v.name, ...(v.via ? { via: v.via } : {}), source: v.source, ...(isStart ? { state: "ok" as const, start: true as const } : { state: f.state, ...(f.problem ? { problem: f.problem } : {}) }) };
  });
  for (const [view, p] of pictures) keep(sid, label, n, view, "desktop", p.png, p.outline);
  return result;
}

/** Record a pass's findings on its version, if it is still there. */
function record(sid: string, label: string, n: number, views: DesignView[]): void {
  if (designChatDeleted(sid) || !designOf(sid, label)?.versions.some((v) => v.n === n)) return;
  changeDesign(sid, label, (d) => {
    const v = d.versions.find((x) => x.n === n);
    if (v) v.views = views;
  });
}

// One pass at a time on this computer: each is a browser, and a batch of designs lands its versions together.
const queue: { parent: BrowseParent; label: string; n: number }[] = [];
let busy = false;

/** Check a just-kept version's views in the background. A pass for a version a newer one of the same design has
    overtaken in the queue is skipped: its views stay unchecked. */
export function queueViewsCheck(parent: BrowseParent, label: string, n: number, deps: DesignLookDeps = {}): Promise<void> {
  queue.push({ parent, label, n });
  return drain(deps);
}

async function drain(deps: DesignLookDeps): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { parent, label, n } = job;
      if (queue.some((x) => x.parent.sessionId === parent.sessionId && x.label === label && x.n > n)) continue;
      try {
        const views = await checkVersionViews(parent, label, n, deps);
        if (views) record(parent.sessionId, label, n, views);
      } catch (err) {
        console.error(`[design] ${label}${n}'s views couldn't be checked:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    busy = false;
  }
}

// ---- a look at one view ---------------------------------------------------------------------------

/**
 * Pictures of one version of a design (its newest unless named), on its first screen or on one of its views, at the
 * widths asked for; or after the clicks `actions` names, for a screen the page doesn't declare. A view the pass
 * already pictured at that width comes from what it kept.
 */
export async function lookAtDesignPage(parent: BrowseParent, label: string, a: { version?: number; view?: string; sizes?: TourSize[]; actions?: TourWalkAction[] } = {}, deps: DesignLookDeps = {}): Promise<{ shots: { size: TourSize; png: Uint8Array }[]; outline: string; view?: string }> {
  const sid = parent.sessionId;
  const n = a.version ?? designOf(sid, label)?.versions.at(-1)?.n;
  const sizes: TourSize[] = a.sizes?.length ? [...new Set(a.sizes)] : ["desktop", "phone"];
  const view = a.view?.trim() ? a.view.trim() : undefined;
  if (view === undefined && !a.actions?.length && n !== undefined) {
    const have = sizes.map((s) => kept(sid, label, n, "start", s));
    if (have.every(Boolean)) return { shots: sizes.map((size, i) => ({ size, png: have[i]!.png })), outline: have.map((h) => h!.outline).filter(Boolean).join("\n") };
  }
  if (view === undefined) return lookAtDesign(parent, label, { ...(n !== undefined ? { version: n } : {}), sizes, ...(a.actions?.length ? { actions: a.actions } : {}) }, deps);
  const html = n === undefined ? null : (deps.readPage ?? readPage)(sid, label, n);
  if (!html || n === undefined) throw new Error(`Design ${label} has no finished page to look at.`);
  const { views } = pageViews(html);
  const what = `Design ${label}'s version ${n}`;
  const stored = designOf(sid, label)?.versions.find((x) => x.n === n)?.views;
  const named = pickView(stored?.length ? stored : views.map((v) => ({ name: v.name, ...(v.via ? { via: v.via } : {}), source: v.source, state: "unchecked" as const })), view, what);
  const i = views.findIndex((v) => viewKey(v.name) === viewKey(named.name));
  const clicks = i < 0 ? null : clicksTo(views, views[i]!.name);
  if (!clicks) throw new Error(`${what}'s view "${named.name}" can't be reached by clicks from its first screen.`);
  if (!a.actions?.length) {
    const have = sizes.map((s) => kept(sid, label, n, i, s));
    if (have.every(Boolean)) return { shots: sizes.map((size, k) => ({ size, png: have[k]!.png })), outline: have.map((h) => h!.outline).filter(Boolean).join("\n"), view: named.name };
  }
  const r = await lookAtDesign(parent, label, { version: n, sizes, actions: [...clicks, ...(a.actions ?? [])], prepare: (page) => withViewIds(page, views) }, deps);
  // Kept only when its outline is that one width's, so a later look gets both right.
  if (!a.actions?.length && sizes.length === 1) keep(sid, label, n, i, sizes[0]!, r.shots[0]!.png, r.outline);
  return { ...r, view: named.name };
}
