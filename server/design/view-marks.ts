// A page's views, read from its markup with no browser (al_1 step 17). A designer puts data-sova-view="<name>" on
// the control that opens each view (a tab, a link to another screen, a menu item, a dialog's button), and
// data-sova-via="<view>" on one that is only on screen once another view is open. The page as it first loads is a
// view of its own and is never declared. A page that declares none falls back to its role="tab" controls.
// The problems found here are a page's landing problems, refused as lint's are, each naming its line.
import type { Tag, Token } from "./lint";

export const VIEW_LIMITS = Object.freeze({ views: 20, nameChars: 40, depth: 3 });

/** One view a page names, and the control that opens it. */
export interface PageView {
  name: string;
  /** The view that must be open for this control to be on screen; absent: the first screen. */
  via?: string;
  /** declared: data-sova-view; found: a role="tab" control in a page that declares none. */
  source: "declared" | "found";
  line: number;
  /** Where the control's tag starts in the page, and its element's name. */
  at: number;
  tag: string;
  /** Its control says it is the one showing (aria-selected="true", or aria-current). */
  selected?: true;
}

const isSelected = (t: Tag): boolean => (t.attrs.get("aria-selected") ?? "").trim().toLowerCase() === "true" || (t.attrs.has("aria-current") && (t.attrs.get("aria-current") ?? "").trim().toLowerCase() !== "false");

const CLICK_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "treeitem", "checkbox", "radio"]);
const CLICK_INPUTS = new Set(["button", "submit", "reset", "image", "checkbox", "radio"]);

/** A name as a person reads it: spaces collapsed. */
export const viewName = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Names match whatever their case. */
export const viewKey = (s: string): string => viewName(s).toLowerCase();

function clickable(t: Tag): boolean {
  if (t.attrs.has("disabled") && (t.name === "button" || t.name === "input")) return false;
  const role = (t.attrs.get("role") ?? "").trim().toLowerCase();
  if (CLICK_ROLES.has(role)) return true;
  if (t.name === "button" || t.name === "summary" || t.name === "label") return true;
  if (t.name === "a") return t.attrs.has("href");
  if (t.name === "input") return CLICK_INPUTS.has((t.attrs.get("type") ?? "text").trim().toLowerCase());
  return t.attrs.has("onclick") || t.attrs.has("tabindex");
}

/** A click on it submits its form, which a look never does. */
function submits(t: Tag, inForm: boolean): boolean {
  if (!inForm) return false;
  const type = (t.attrs.get("type") ?? "").trim().toLowerCase();
  if (t.name === "button") return type === "" || type === "submit";
  return t.name === "input" && (type === "submit" || type === "image");
}

/** An element's words as text, its tags dropped: the name a tab is known by when it has no aria-label. */
function textOf(html: string, list: Token[], i: number): string {
  const open = list[i] as Tag;
  let depth = 0;
  for (let j = i + 1; j < list.length; j++) {
    const t = list[j]!;
    if ("close" in t) {
      if (t.close !== open.name) continue;
      if (depth === 0) return decodeText(html.slice(open.end, t.at));
      depth--;
    } else if (t.name === open.name && !t.selfClosing) depth++;
  }
  return "";
}

const decodeText = (s: string): string =>
  viewName(
    s
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'"),
  );

/**
 * The views a page names, in page order, and what is wrong with its declarations. Only declarations are checked: a
 * page that declares nothing has no view problems, and its role="tab" controls are its views.
 */
export function readViews(list: Token[], html: string): { views: PageView[]; problems: string[] } {
  const problems: string[] = [];
  const declared: PageView[] = [];
  const tabs: PageView[] = [];
  let forms = 0;
  for (const [i, t] of list.entries()) {
    if ("close" in t) {
      if (t.close === "form" && forms > 0) forms--;
      continue;
    }
    if (t.name === "form" && !t.selfClosing) forms++;
    const raw = t.attrs.get("data-sova-view");
    const via = t.attrs.has("data-sova-via") ? viewName(t.attrs.get("data-sova-via")!) : undefined;
    if (raw === undefined) {
      if (via !== undefined) problems.push(`line ${t.line}: data-sova-via without data-sova-view on <${t.name}>: put both on the control that opens the view.`);
      const role = (t.attrs.get("role") ?? "").trim().toLowerCase();
      if (role === "tab" && !t.attrs.has("disabled")) {
        const name = viewName(t.attrs.get("aria-label") ?? "") || textOf(html, list, i);
        if (name && name.length <= VIEW_LIMITS.nameChars) tabs.push({ name, source: "found", line: t.line, at: t.at, tag: t.name, ...(isSelected(t) ? { selected: true as const } : {}) });
      }
      continue;
    }
    const name = viewName(raw);
    if (!name) {
      problems.push(`line ${t.line}: data-sova-view on <${t.name}> is empty: name the view as a person would say it.`);
      continue;
    }
    if (name.length > VIEW_LIMITS.nameChars) problems.push(`line ${t.line}: the view name "${name.slice(0, VIEW_LIMITS.nameChars)}..." is longer than ${VIEW_LIMITS.nameChars} characters.`);
    if (!clickable(t)) problems.push(`line ${t.line}: data-sova-view="${name}" is on a <${t.name}>, which can't be clicked: put it on the button, link or tab that opens the view.`);
    else if (submits(t, forms > 0)) problems.push(`line ${t.line}: the control opening the view "${name}" submits its form, and views are opened without submitting anything: give it type="button".`);
    declared.push({ name, ...(via ? { via } : {}), source: "declared", line: t.line, at: t.at, tag: t.name, ...(isSelected(t) ? { selected: true as const } : {}) });
  }
  if (!declared.length) {
    // A found tab's name may repeat (two tab bars): only the first keeps it.
    const seen = new Set<string>();
    const views = tabs.filter((v) => !seen.has(viewKey(v.name)) && !!seen.add(viewKey(v.name))).slice(0, VIEW_LIMITS.views);
    return { views, problems };
  }
  if (declared.length > VIEW_LIMITS.views) problems.push(`this page declares ${declared.length} views; at most ${VIEW_LIMITS.views}.`);
  const byKey = new Map<string, PageView>();
  for (const v of declared) {
    const first = byKey.get(viewKey(v.name));
    if (first) problems.push(`line ${v.line}: a view named "${v.name}" is already declared on line ${first.line}: each view needs a name of its own.`);
    else byKey.set(viewKey(v.name), v);
  }
  for (const v of declared) {
    if (v.via === undefined || byKey.get(viewKey(v.name)) !== v) continue;
    if (!v.via) {
      problems.push(`line ${v.line}: data-sova-via is empty: name the view this control is on, or leave it out for the first screen.`);
      continue;
    }
    if (!byKey.has(viewKey(v.via))) {
      problems.push(`line ${v.line}: data-sova-via="${v.via}" names no view this page declares (the first screen needs none: leave data-sova-via out).`);
      continue;
    }
    const chain = [v.name];
    let at: PageView | undefined = v;
    let loop = false;
    while (at?.via !== undefined) {
      const next = byKey.get(viewKey(at.via));
      if (!next) break;
      if (chain.some((n) => viewKey(n) === viewKey(next.name))) {
        problems.push(`line ${v.line}: data-sova-via goes round in a loop: ${[...chain, next.name].join(" → ")}.`);
        loop = true;
        break;
      }
      chain.push(next.name);
      at = next;
    }
    if (!loop && chain.length > VIEW_LIMITS.depth)
      problems.push(`line ${v.line}: the view "${v.name}" takes ${chain.length} clicks to reach (${[...chain].reverse().join(" → ")}); views go at most ${VIEW_LIMITS.depth} deep.`);
  }
  return { views: declared, problems };
}

/** The views a click path goes through to reach `name`, first click first; null for a name the list doesn't have. */
export function viewPath(views: readonly Pick<PageView, "name" | "via">[], name: string): string[] | null {
  const byKey = new Map(views.map((v) => [viewKey(v.name), v] as const));
  const out: string[] = [];
  let at = byKey.get(viewKey(name));
  if (!at) return null;
  while (at) {
    if (out.includes(at.name) || out.length > VIEW_LIMITS.depth) return null;
    out.unshift(at.name);
    at = at.via === undefined ? undefined : byKey.get(viewKey(at.via));
  }
  return out;
}

/** The test id Sova gives a view's control in the copy it serves to its own browser: never in the stored page. */
export const viewTestId = (i: number): string => `sova-view-${i}`;

/**
 * The page with each view's control carrying its test id, for Sova's browser only. Put first among the tag's
 * attributes, so it wins over one the page may give the same element (a browser keeps the first).
 */
export function withViewIds(html: string, views: readonly PageView[]): string {
  let out = html;
  const order = views.map((v, i) => ({ v, i })).sort((a, b) => b.v.at - a.v.at);
  for (const { v, i } of order) {
    const after = v.at + 1 + v.tag.length;
    out = `${out.slice(0, after)} data-testid="${viewTestId(i)}"${out.slice(after)}`;
  }
  return out;
}
