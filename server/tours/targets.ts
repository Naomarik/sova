import type { Locator, Page } from "playwright-core";
import { TOUR_PROBLEM_LIMITS, TOUR_ROLES, tourMarkBoxFits, type TourFailure, type TourMark, type TourNearby, type TourTarget } from "../../shared/tour";

export class TourCaptureFailure extends Error {
  constructor(readonly failure: TourFailure) { super(failure.message); }
}
/** Invisible direction marks (and the zero-width space), ignored on both sides of a text or name match (§app.tours/authoring). */
const MARKS = "\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069";
const MARKS_RE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export const stripTourMarks = (text: string): string => text.replace(MARKS_RE, "");
/**
 * An exact, case-sensitive match of `text` (whitespace collapsed, as Playwright's exact match does) that
 * allows direction marks anywhere: before, after and between its characters.
 */
export function tourTextPattern(text: string): RegExp {
  const clean = stripTourMarks(text).trim().replace(/\s+/g, " ");
  const gap = `[${MARKS}]*`;
  const body = clean.split("").map(c => c === " " ? `[\\s${MARKS}]+` : c.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&")).join(gap);
  return new RegExp(`^[\\s${MARKS}]*${body}[\\s${MARKS}]*$`);
}
export function tourLocator(page: Page, target: TourTarget): Locator {
  if (target.kind === "role") return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: tourTextPattern(target.name) });
  if (target.kind === "text") return page.getByText(tourTextPattern(target.text));
  return page.getByTestId(target.testId);
}
/** A visible control as the page shows it: its role (null when it has no listed one), name, text, test id, input type and box. */
export interface TourControl { role: string | null; name: string; text: string; testId: string; input: string; tag: string; y: number; h: number; top: number; left: number; w: number }
/** The elements a control list looks at, in page order. */
export const TOUR_CONTROL_SELECTOR = "button,a,label,summary,h1,h2,h3,h4,h5,h6,input,textarea,select,img,[role],[aria-label],[data-testid]";
/**
 * Runs in the page (self-contained: serialized by evaluateAll). Names and text read as a reader sees them
 * (innerText, so a link holding a heading and a paragraph reads "A B", never "AB"), whitespace collapsed.
 */
function readControls(els: Element[]): TourControl[] {
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const t = el.tagName;
    if (t === "BUTTON") return "button";
    if (t === "A") return el.hasAttribute("href") ? "link" : null;
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "TEXTAREA") return "textbox";
    if (t === "SELECT") return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? "listbox" : "combobox";
    if (t === "IMG") return el.getAttribute("alt") ? "img" : null;
    if (t === "INPUT") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "search") return "searchbox";
      if (["text", "email", "tel", "url", "password", "number"].includes(type)) return type === "password" ? "textbox" : el.hasAttribute("list") ? "combobox" : "textbox";
    }
    return null;
  };
  const read = (el: Element | null | undefined): string => !el ? "" : (el instanceof HTMLElement ? el.innerText : el.textContent) ?? "";
  const clean = (t: string) => t.trim().replace(/\s+/g, " ").slice(0, 200);
  return els.filter(el => el.getClientRects().length && !(el instanceof HTMLInputElement && el.type === "hidden")).map(el => {
    const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => read(document.getElementById(id))).join(" ").trim();
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    const labels = field ? [...(el as HTMLInputElement).labels ?? []].map(label => read(label)).join(" ") : "";
    const name = clean(el.getAttribute("aria-label") || labelled || labels || (field ? el.getAttribute("placeholder") ?? "" : "") || el.getAttribute("alt") || (field ? "" : read(el)) || "");
    const r = el.getBoundingClientRect();
    return { role: roleOf(el), name, text: field ? "" : clean(read(el)), testId: (el.getAttribute("data-testid") ?? "").slice(0, 200), input: el instanceof HTMLInputElement ? (el.type || "text").toLowerCase() : "", tag: el.tagName.toLowerCase(), y: Math.round(r.top + scrollY), h: Math.round(r.height), top: r.top, left: r.left, w: r.width };
  }).filter(c => c.name || c.text || c.testId).slice(0, 400);
}
/** The page's visible controls in page order (at most 400), names and boxes only: never values, attributes or page source. */
export async function tourControls(page: Page): Promise<TourControl[]> {
  return page.locator(TOUR_CONTROL_SELECTOR).evaluateAll(readControls).catch(() => [] as TourControl[]);
}
/**
 * The smallest visible elements whose text (as a reader sees it, direction marks ignored, any case) contains
 * `wanted`: none of their children holds it too. At most 3, as controls.
 */
async function holdersOf(page: Page, wanted: string): Promise<TourControl[]> {
  const els = await page.locator("body *").evaluateAll((all, want) => {
    const norm = (t: string) => t.replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const w = norm(want);
    if (!w) return [] as number[];
    const holds = (el: Element) => el instanceof HTMLElement && !!el.getClientRects().length && norm(el.innerText ?? "").includes(w);
    const out: number[] = [];
    all.forEach((el, i) => { if (out.length < 3 && holds(el) && ![...el.children].some(holds)) out.push(i); });
    return out;
  }, wanted).catch(() => [] as number[]);
  const found: TourControl[] = [];
  for (const i of els) found.push(...await page.locator("body *").nth(i).evaluateAll(readControls).catch(() => [] as TourControl[]));
  return found;
}
/** A control as a target the script can use: its role and name, else its test id (a nameless box), else its text. */
export function tourControlTarget(c: Pick<TourControl, "role" | "name" | "text" | "testId">): TourTarget | null {
  if (c.role && TOUR_ROLES.includes(c.role) && c.name) return { kind: "role", role: c.role, name: c.name };
  if (c.testId && !c.name) return { kind: "testId", testId: c.testId };
  if (c.text) return { kind: "text", text: c.text };
  return null;
}
/**
 * Up to 8 visible controls near `wanted` (or, with none, the page's first controls, form controls first),
 * each as a target the script can use (its role and name, or its text when it has no listed role) and
 * how many visible controls that target matches now. Names whose start or body holds `wanted` come first,
 * those of the role asked for first of all;
 * for a text target, the smallest element holding its text comes before them. An entry that matches nothing
 * as read is left out. Names only, bounded: never the private DOM, attributes, values or page source.
 */
export async function tourNearby(page: Page, wanted?: string, kind?: TourTarget["kind"], role?: string): Promise<TourNearby[]> {
  const found = await tourControls(page);
  const norm = (t: string) => stripTourMarks(t).replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(wanted ?? "");
  const words = want.split(/\W+/).filter(Boolean);
  const score = (c: TourControl) => {
    const l = norm(c.name || c.text);
    const named = !!c.role && TOUR_ROLES.includes(c.role) && !!c.name;
    const place = !want ? 0 : l === want ? 300 : l.startsWith(want) ? 200 : l.includes(want) ? 150 : 0;
    // The role asked for, named with the words asked for, comes before an exact name on another role.
    return place + (place && named ? 10 : 0) + (place && role && c.role === role ? 150 : 0) + words.filter(w => l.includes(w)).length;
  };
  const FORM = ["textbox", "searchbox", "combobox", "checkbox", "radio", "button", "link", "tab"];
  const candidates: TourTarget[] = [];
  const keys = new Set<string>();
  const add = (t: TourTarget | null) => { if (!t) return; const k = JSON.stringify(t); if (!keys.has(k)) { keys.add(k); candidates.push(t); } };
  // A text target that matches nothing: the smallest element holding that text first, as text, then by its role.
  if (want && kind === "text") for (const c of await holdersOf(page, wanted!)) { if (c.text) add({ kind: "text", text: c.text }); add(tourControlTarget(c)); }
  const ordered = found.map((c, i) => ({ c, i })).sort((a, b) => (wanted ? score(b.c) - score(a.c) : (FORM.includes(a.c.role ?? "") ? 0 : 1) - (FORM.includes(b.c.role ?? "") ? 0 : 1)) || a.i - b.i);
  for (const { c } of ordered) {
    if (c.role && TOUR_ROLES.includes(c.role) && c.name) add({ kind: "role", role: c.role, name: c.name });
    else if (c.text) add({ kind: "text", text: c.text });
    if (candidates.length >= 16) break;
  }
  const out: TourNearby[] = [];
  for (const target of candidates) {
    const matches = await tourLocator(page, target).filter({ visible: true }).count().catch(() => 0);
    // A role guessed wrong, or a name the browser computes differently: offer its text instead.
    if (!matches && target.kind === "role") {
      const text = found.find(c => c.role === target.role && c.name === target.name)?.text;
      const alt: TourTarget | null = text ? { kind: "text", text } : null;
      const n = alt && !keys.has(JSON.stringify(alt)) ? await tourLocator(page, alt).filter({ visible: true }).count().catch(() => 0) : 0;
      if (alt && n) { keys.add(JSON.stringify(alt)); out.push({ target: alt, matches: n }); }
    } else if (matches) out.push({ target, matches });
    if (out.length >= TOUR_PROBLEM_LIMITS.nearby) break;
  }
  return out;
}
export async function uniqueTourTarget(page: Page, target: TourTarget): Promise<Locator> {
  const locator = tourLocator(page, target).filter({ visible: true });
  try { await locator.waitFor({ state: "visible", timeout: 2500 }); } catch { /* report exact count below */ }
  const matches = await locator.count();
  if (matches !== 1) {
    const nearby = await tourNearby(page, target.kind === "role" ? target.name : target.kind === "text" ? target.text : target.testId, target.kind, target.kind === "role" ? target.role : undefined);
    throw new TourCaptureFailure({ message: `Target matched ${matches} visible controls; exactly 1 is required.`, guidance: "Use a unique accessible name or test id, or use reference text. No nearby control was chosen; each nearby entry is a target you can use, with how many visible controls it matches.", target, matches, nearby });
  }
  return locator;
}
/** The two ways a box can't be captured: it never held still, or it held still outside the screen. */
export const TOUR_TARGET_MOVING = "Target kept moving, so it couldn't be marked or captured.";
export const TOUR_TARGET_OUTSIDE = "Target is outside the captured screen.";
const SETTLE_MS = 3000;
type Box = { x: number; y: number; width: number; height: number };
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 0.25);
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
/**
 * Whatever `measure` reports as `still` is the same over two consecutive frames (within 0.25 px), waiting
 * up to about 3 s; then its `box` must sit inside `bounds`. A timeout is never taken as stable, and the
 * last box is never taken as an answer.
 */
export async function settledBox(page: Page, measure: () => Promise<{ box: Box; still: number[] } | null>, bounds: { w: number; h: number }, what: string): Promise<Box> {
  const deadline = Date.now() + SETTLE_MS;
  let previous: number[] | null = null;
  for (;;) {
    const m = await measure();
    const box = m?.box;
    if (m && box && previous && same(m.still, previous)) {
      if (box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.x + box.width > bounds.w + 0.25 || box.y + box.height > bounds.h + 0.25) {
        const r = (n: number) => Math.round(n);
        throw new TourCaptureFailure({ message: TOUR_TARGET_OUTSIDE, guidance: `${what} sits at ${r(box.x)},${r(box.y)}, ${r(box.width)}\u00d7${r(box.height)}, outside the ${r(bounds.w)}\u00d7${r(bounds.h)} screen. Add {op:"reveal", target} before it in this size's actions to bring it into view, or choose a target on the first screen.` });
      }
      return box;
    }
    if (Date.now() >= deadline) break;
    previous = m ? m.still : null;
    await frames(page);
  }
  throw new TourCaptureFailure({ message: TOUR_TARGET_MOVING, guidance: `${what} was still changing after 3 seconds (an animation or content still loading). Wait for it to settle with a wait action, or use a reference view.` });
}
export async function stableTourBox(locator: Locator, viewport: { w: number; h: number }): Promise<Box> {
  return settledBox(locator.page(), async () => { const b = await locator.boundingBox(); return b ? { box: b, still: [b.x, b.y, b.width, b.height] } : null; }, viewport, "The target");
}
/** "Target is covered by \"<name>\", a fixed or sticky bar." */
export const tourTargetCovered = (name: string): string => `Target is covered by "${name}", a fixed or sticky bar.`;
/**
 * The reveal action: scrolls whichever containers hold the target (inner panels and the page) until it
 * is fully inside the screen, centred, so it never sits flush with an edge; then waits for it to hold still
 * there. Under a fixed or sticky bar (or still outside), it gets one more try scrolled only as far as needed;
 * still covered fails, naming the bar.
 */
export async function revealTourTarget(locator: Locator, viewport: { w: number; h: number }): Promise<Box> {
  let cover: string | null = null;
  // Centred first, so the target settles well inside the screen, never flush with its edge; nearest when a bar covers the centre.
  for (const block of ["center", "nearest"] as const) {
    await locator.evaluate((el, block) => el.scrollIntoView({ block, inline: "nearest", behavior: "instant" }), block);
    let box: Box;
    try { box = await stableTourBox(locator, viewport); } catch (error) {
      // Scrolled to the screen's edge, a box can end a fraction of a pixel past it: centred, it is clear.
      if (block === "center" && error instanceof TourCaptureFailure && error.failure.message === TOUR_TARGET_OUTSIDE) continue;
      throw error;
    }
    cover = await coveringBar(locator);
    if (!cover) return box;
  }
  throw new TourCaptureFailure({ message: tourTargetCovered(cover!), guidance: "Reveal or mark a control the bar doesn't cover, or use reference text." });
}
/** The fixed or sticky bar drawn over the target's centre or near its corners, by a short name; null when none is. */
async function coveringBar(locator: Locator): Promise<string | null> {
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]] as const) {
      const top = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      if (!top || el.contains(top) || top.contains(el)) continue;
      for (let n: Element | null = top; n && n !== document.documentElement; n = n.parentElement) {
        const position = getComputedStyle(n).position;
        if ((position === "fixed" || position === "sticky") && !n.contains(el)) {
          const name = (n.getAttribute("aria-label") || n.querySelector("h1,h2,h3,h4,h5,h6")?.textContent || n.textContent || "").trim().replace(/\s+/g, " ");
          return (name.length > 60 ? `${name.slice(0, 60)}\u2026` : name) || n.tagName.toLowerCase();
        }
      }
    }
    return null;
  });
}
/**
 * A settled box in screen fractions, clamped to the screen first: the capture check allows a box a fraction
 * of a pixel past the edge (0.25 px), and a published picture's mark must lie within it.
 */
export function tourMarkBox(box: Box, viewport: { w: number; h: number }): Pick<TourMark, "x" | "y" | "w" | "h"> {
  const x0 = Math.min(Math.max(box.x, 0), viewport.w), y0 = Math.min(Math.max(box.y, 0), viewport.h);
  const x1 = Math.min(Math.max(box.x + box.width, x0), viewport.w), y1 = Math.min(Math.max(box.y + box.height, y0), viewport.h);
  return { x: x0 / viewport.w, y: y0 / viewport.h, w: (x1 - x0) / viewport.w, h: (y1 - y0) / viewport.h };
}
export async function tourMark(page: Page, target: TourTarget, viewport: { w: number; h: number }, detail: Pick<TourMark, "n" | "label" | "side">): Promise<TourMark> {
  const box = await stableTourBox(await uniqueTourTarget(page, target), viewport);
  const mark = { ...detail, ...tourMarkBox(box, viewport) };
  // The dry run builds the same marks the recording would publish, so it refuses what the edition check would.
  if (!tourMarkBoxFits(mark)) throw new TourCaptureFailure({ message: TOUR_TARGET_OUTSIDE, guidance: "The target's box doesn't fit inside the picture. Add {op:\"reveal\", target} before it, or choose a target on the first screen." });
  return mark;
}
