// record_tour `look` (§app.tours/look): before its first dry run the agent asks the recorder what a few pages
// show. A look runs as a no-image dry run of a script Sova builds from the request (one step per page, both
// sizes), plus, when a sign-in route is known, one signed-out visit to that page. This module holds the
// request's checks, that script, the answer's bounded shape and the in-page lists the child reads.
import type { Page } from "playwright-core";
import { isTourRoute, normalizeTourScriptRequest, tourOnSignInRoute, tourScriptProblem, tourSignInProblem, tourSourceProblem, TOUR_ROLES, TOUR_SIZES, type TourAction, type TourNearby, type TourScriptRequest, type TourSignIn, type TourSize, type TourSourceRequest, type TourTarget } from "../../shared/tour";
import { tourControls, tourControlTarget, tourLocator, type TourControl } from "./targets";

export const TOUR_LOOK_LIMITS = Object.freeze({ pages: 10, controls: 40, links: 40 });
/** One page to look at: its route, and the actions to run first (one list for both sizes, or per size). */
export interface TourLookPageRequest { route: string; actions?: TourAction[] | Partial<Record<TourSize, TourAction[]>> }
/** `signInRoute`: the sign-in page's route before `signIn` is known (the look then lists that page only signed out). */
export interface TourLookRequest { source: TourSourceRequest; sites?: string[]; signIn?: TourSignIn; signInRoute?: string; pages: TourLookPageRequest[] }
/** A control as the look lists it: one target field set ({role, name}, {testId} or {text}) and where it is. */
export interface TourLookControl { role?: string; name?: string; testId?: string; text?: string; input?: string; matches: number; onFirstScreen?: boolean; y?: number; h?: number }
export interface TourLookProblem { message: string; target?: TourTarget; nearby?: TourNearby[] }
/** One page at one size: the address it ended on, its controls in page order, `more` left out, its same-origin links. */
export interface TourLookSize { url: string; controls: TourLookControl[]; more?: number; links: string[]; problem?: TourLookProblem }
export interface TourLookPage { route: string; desktop?: TourLookSize; phone?: TourLookSize }
/** What the child sends back: the signed-out sign-in page (desktop) and each page per size. */
export interface TourLookResult { signInPage?: TourLookSize & { route: string }; pages: TourLookPage[] }
/** What the agent reads: the result, the tour id, and what to do next. */
export interface TourLookAnswer extends TourLookResult { tourId: string; next: string }

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const FIELDS = ["source", "sites", "signIn", "signInRoute", "pages"];
const SHAPE = "look takes {source, sites?, signIn?, signInRoute?, tourId?, credentials?, pages: [{route, actions?}]}";

/** The script a look runs: one step per page, each one page view at both sizes, no marks, no masks. */
export function tourLookScript(v: TourLookRequest): TourScriptRequest {
  const pages = v.pages.length ? v.pages : [];
  return {
    v: 1, title: "A look at the app", summary: "The pages the agent asked the recorder to look at.", audience: "The agent writing the tour", outcome: "The real names on each page.",
    source: v.source, ...(v.sites ? { sites: v.sites } : {}), ...(v.signIn ? { signIn: v.signIn } : {}),
    chapters: [{ id: "look", title: "Look" }],
    steps: pages.length ? pages.map((p, i) => ({ id: `page-${i + 1}`, chapter: "look", title: `Page ${i + 1}`, summary: "A page to look at.", views: [{
      id: "page", title: "Page", kind: "page" as const, note: "", route: p.route, sizes: [...TOUR_SIZES],
      actions: Array.isArray(p.actions) ? { desktop: p.actions, phone: p.actions } : { desktop: p.actions?.desktop ?? [], phone: p.actions?.phone ?? [] }, marks: [], masks: [],
    }] })) : [{ id: "sign-in-only", chapter: "look", title: "Sign-in page", summary: "Only the signed-out sign-in page.", views: [{ id: "none", title: "None", kind: "reference" as const, note: "", reference: "This look lists only the signed-out sign-in page." }] }],
  };
}
/** The named reason a look request is unusable, or null. Page faults name `pages[i]`. */
export function tourLookProblem(v: unknown): string | null {
  if (!object(v)) return `${SHAPE}.`;
  const extra = Object.keys(v).filter(k => !FIELDS.includes(k));
  if (extra.length) return `look doesn't take ${extra.slice(0, 5).join(", ")}. ${SHAPE}.`;
  const source = v.source === undefined ? "look needs source, the same source the tour's script will name." : tourSourceProblem(v.source);
  if (source) return source;
  if (v.signIn !== undefined) { const p = tourSignInProblem(v.signIn); if (p) return p; }
  if (v.signInRoute !== undefined && (!isTourRoute(v.signInRoute))) return "signInRoute must be the sign-in page's path on the source, starting with /.";
  if (v.signIn !== undefined && v.signInRoute !== undefined) return "Give signIn or signInRoute, not both: signIn.route is the sign-in page.";
  if (!Array.isArray(v.pages)) return `look needs pages: a list of up to ${TOUR_LOOK_LIMITS.pages} {route, actions?}.`;
  if (v.pages.length > TOUR_LOOK_LIMITS.pages) return `look takes at most ${TOUR_LOOK_LIMITS.pages} pages; look again for the rest.`;
  if (!v.pages.length && v.signIn === undefined && v.signInRoute === undefined) return "look needs at least one page, or signInRoute to list the signed-out sign-in page alone.";
  for (const [i, p] of v.pages.entries()) {
    if (!object(p) || Object.keys(p).some(k => k !== "route" && k !== "actions")) return `pages[${i}] must be {route, actions?}.`;
    if (!isTourRoute(p.route)) return `pages[${i}]: route must be a path on the source starting with /, such as /settings.`;
    // The look already lists the sign-in page signed out; signed in, the recorder would only sign in there again.
    const signInRoute = typeof v.signInRoute === "string" ? v.signInRoute : object(v.signIn) && typeof v.signIn.route === "string" ? v.signIn.route : undefined;
    if (signInRoute && tourOnSignInRoute(p.route, signInRoute)) return `pages[${i}] is the sign-in page; it is never pictured. The look lists it signed out; leave it out of pages.`;
    if (p.actions !== undefined && !Array.isArray(p.actions) && !(object(p.actions) && Object.keys(p.actions).every(k => (TOUR_SIZES as readonly string[]).includes(k)))) return `pages[${i}]: actions must be a list of actions (for both sizes) or {desktop?, phone?} lists.`;
  }
  const script = tourLookScript(v as unknown as TourLookRequest);
  if (normalizeTourScriptRequest(script)) return null;
  // The script's own named faults, renamed to the request's places.
  const problem = tourScriptProblem(script) ?? "The look request is invalid.";
  return problem.replace(/steps\[(\d+)\] "page-\d+" \u203a views\[0\] "page"/g, (_m, n: string) => `pages[${n}]`);
}

const sizeOk = (v: unknown, signIn = false): boolean => object(v) && typeof v.url === "string" && v.url.length <= 2100 && Array.isArray(v.controls) && v.controls.length <= TOUR_LOOK_LIMITS.controls
  && v.controls.every(c => object(c) && Number.isInteger(c.matches) && JSON.stringify(c).length <= 1200) && (v.more === undefined || Number.isInteger(v.more))
  && Array.isArray(v.links) && v.links.length <= TOUR_LOOK_LIMITS.links && v.links.every(l => typeof l === "string" && l.length <= 2100)
  && (v.problem === undefined || object(v.problem) && typeof v.problem.message === "string" && JSON.stringify(v.problem).length <= 8000)
  && (!signIn || isTourRoute(v.route));
/** The child's look answer, bounded, or undefined. */
export function normalizeTourLookResult(v: unknown): TourLookResult | undefined {
  if (!object(v) || !Array.isArray(v.pages) || v.pages.length > TOUR_LOOK_LIMITS.pages) return undefined;
  if (v.signInPage !== undefined && !sizeOk(v.signInPage, true)) return undefined;
  if (!v.pages.every(p => object(p) && isTourRoute(p.route) && (p.desktop === undefined || sizeOk(p.desktop)) && (p.phone === undefined || sizeOk(p.phone)))) return undefined;
  return JSON.parse(JSON.stringify(v)) as TourLookResult;
}
/** The agent's answer for a finished look. */
export function tourLookAnswer(tourId: string, result: TourLookResult): TourLookAnswer {
  return { tourId, next: `Take targets only from these lists: {role, name} is {kind:"role", role, name}; {testId} is {kind:"testId", testId}; {text} is {kind:"text", text}. Run the dry run with tourId "${tourId}" beside the script, so it starts from this look's sign-in and no second sign-in card appears.`, ...result };
}
/** The answer while the look is still queued or running. */
export const tourLookPending = (tourId: string) => ({ tourId, next: `The look is running. Call status with its jobId: it answers when the look finishes, or when it needs the user. Then run the dry run with tourId "${tourId}".` });

/** Where the page is now, as a route when on `origin` (path, query and hash), else the full address. */
export function tourLookUrl(url: string, origin: string): string {
  try { const u = new URL(url); return (u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : u.href).slice(0, 2000); } catch { return ""; }
}
const PRIORITY = (c: TourControl) => c.role === "heading" ? 0 : ["textbox", "searchbox", "combobox", "checkbox", "radio", "button", "link", "tab", "menuitem"].includes(c.role ?? "") || c.input ? 1 : 2;
/**
 * The page's visible controls in page order, at most 40 (headings and form controls kept first when there are
 * more), each as a target with how many visible controls it matches now, whether it sits fully on the screen
 * as it is, and its top and height on the page. An entry matching nothing as read is left out.
 */
export async function tourLookControls(page: Page, viewport: { w: number; h: number }, max: number = TOUR_LOOK_LIMITS.controls): Promise<{ controls: TourLookControl[]; more?: number }> {
  const found = await tourControls(page);
  const seen = new Set<string>();
  const entries: { c: TourControl; target: TourTarget; i: number }[] = [];
  for (const [i, c] of found.entries()) {
    // A label is listed through the box it names.
    if (c.tag === "label") continue;
    const target = tourControlTarget(c);
    if (!target || (target.kind === "role" && !TOUR_ROLES.includes(target.role))) continue;
    const key = JSON.stringify(target);
    if (seen.has(key)) continue;
    seen.add(key); entries.push({ c, target, i });
  }
  // More than fit: headings and form controls first, then the rest, each in page order; then back to page order.
  const kept = entries.length <= max * 2 ? entries : [...entries].sort((a, b) => PRIORITY(a.c) - PRIORITY(b.c) || a.i - b.i).slice(0, max * 2).sort((a, b) => a.i - b.i);
  const controls: TourLookControl[] = [];
  let dropped = entries.length - kept.length;
  for (const { c, target } of kept) {
    if (controls.length >= max) { dropped++; continue; }
    const matches = await tourLocator(page, target).filter({ visible: true }).count().catch(() => 0);
    if (!matches) continue;
    const onFirstScreen = c.top >= 0 && c.left >= 0 && c.top + c.h <= viewport.h + 0.25 && c.left + c.w <= viewport.w + 0.25 && c.h > 0;
    controls.push({ ...(target.kind === "role" ? { role: target.role, name: target.name } : target.kind === "testId" ? { testId: target.testId } : { text: target.text }), ...(c.input ? { input: c.input } : {}), matches, onFirstScreen, y: c.y, h: c.h });
  }
  return { controls, ...(dropped > 0 ? { more: dropped } : {}) };
}
/** Links to other pages of the page's own origin, as routes (hash routes included), at most 40, in page order. */
export async function tourLookLinks(page: Page, origin: string): Promise<string[]> {
  const hrefs = await page.locator("a[href]").evaluateAll(els => els.filter(el => el.getClientRects().length).map(el => (el as HTMLAnchorElement).href)).catch(() => [] as string[]);
  const here = tourLookUrl(page.url(), origin);
  const out: string[] = [];
  for (const href of hrefs) {
    let u: URL;
    try { u = new URL(href); } catch { continue; }
    if (u.origin !== origin) continue;
    const route = `${u.pathname}${u.search}${u.hash}`.slice(0, 2000);
    if (route === here || out.includes(route)) continue;
    out.push(route);
    if (out.length >= TOUR_LOOK_LIMITS.links) break;
  }
  return out;
}
/** The look's lists without any entry `leaks` flags (a page showing the signed-in username, say): never returned. */
export function tourLookWithout(result: TourLookResult, leaks: (text: string) => boolean): TourLookResult {
  const size = <T extends TourLookSize>(s: T | undefined): T | undefined => {
    if (!s) return s;
    const controls = s.controls.filter(c => !leaks(JSON.stringify(c)));
    const problem = s.problem && (leaks(s.problem.message) || (s.problem.target && leaks(JSON.stringify(s.problem.target))) ? { message: "This page couldn't be looked at (its problem mentions a sign-in detail)." } : s.problem && { ...s.problem, ...(s.problem.nearby ? { nearby: s.problem.nearby.filter(n => !leaks(JSON.stringify(n))) } : {}) });
    const dropped = s.controls.length - controls.length;
    return { ...s, url: leaks(s.url) ? "" : s.url, controls, ...(dropped || s.more ? { more: (s.more ?? 0) + dropped } : {}), links: s.links.filter(l => !leaks(l)), ...(problem ? { problem } : {}) };
  };
  return { ...(result.signInPage ? { signInPage: size(result.signInPage)! } : {}), pages: result.pages.map(p => ({ route: p.route, ...(p.desktop ? { desktop: size(p.desktop)! } : {}), ...(p.phone ? { phone: size(p.phone)! } : {}) })) };
}
