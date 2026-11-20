// Release with Options: the panel's rules, pure, so they run under the unit tier and the tab reads them as is.
// What the panel offers comes from the view (the project's release playbook manifest, its release checks and its
// landing checks); Start sends only what was turned off, so a panel left at Full starts what Start Release starts.
import { RELEASE_KINDS, type ReleaseKind, type ReleaseRecord, type ReleaseStartOptions, type ReleaseView } from "../../shared/release";

export const KINDS: readonly ReleaseKind[] = RELEASE_KINDS;
export const KIND_WORD: Record<ReleaseKind, string> = { patch: "Patch", minor: "Minor", major: "Major" };

/** One row of the panel: a release step or a check, with its one line and its rough minutes. */
export interface OptionItem {
  id: string;
  label: string;
  about?: string;
  minutes?: number;
}

/** What the panel lists. `always`: what every release does, never turned off; `steps` and `checks` may be turned off;
    `landing`: the checks every landing runs, shown on and fixed. */
export interface StartPanel {
  next: Record<ReleaseKind, string> | null;
  always: string[];
  steps: OptionItem[];
  checks: OptionItem[];
  landing: OptionItem[];
}

type PanelView = Pick<ReleaseView, "settings" | "manifest" | "landingChecks" | "next">;

const hint = (m: PanelView["manifest"], id: string): { about?: string; minutes?: number } => {
  const h = m?.checks?.[id];
  return { ...(h?.about ? { about: h.about } : {}), ...(typeof h?.minutes === "number" ? { minutes: h.minutes } : {}) };
};

/** The panel's lists from the view; null when the view has no playbook manifest to read (the panel isn't offered). */
export function startPanel(v: PanelView): StartPanel | null {
  const m = v.manifest;
  if (!m) return null;
  const run = m.steps.filter((s) => s.phase !== "withdraw");
  const fixed = (phase: string) => run.filter((s) => !s.skippable && s.phase === phase).map((s) => s.label);
  return {
    next: v.next ?? null,
    always: ["Landings wait until it's published or cancelled", ...fixed("prepare"), ...fixed("check"), "Publish, after your confirm", ...fixed("after")],
    steps: run
      .filter((s) => s.skippable)
      .map((s) => ({ id: s.id, label: s.label, ...(s.about ? { about: s.about } : {}), ...(typeof s.minutes === "number" ? { minutes: s.minutes } : {}) })),
    checks: (v.settings?.checks ?? []).map((c) => ({ id: c.id, label: c.label, ...hint(m, c.id) })),
    landing: (v.landingChecks ?? []).map((c) => ({ id: c.id, label: c.label, ...hint(m, c.id) })),
  };
}

/** What's turned off, by id. */
export interface Off {
  steps: ReadonlySet<string>;
  checks: ReadonlySet<string>;
}
export const NONE_OFF: Off = { steps: new Set(), checks: new Set() };

/** The presets: Full turns everything on, Quick turns off every release step and release-only check. */
export function preset(p: StartPanel, which: "full" | "quick"): Off {
  return which === "full" ? NONE_OFF : { steps: new Set(p.steps.map((s) => s.id)), checks: new Set(p.checks.map((c) => c.id)) };
}

/** Which preset the panel is at, or null (custom) when it matches neither. A panel with nothing to turn off is Full. */
export function presetOf(p: StartPanel, off: Off): "full" | "quick" | null {
  const n = countOff(p, off);
  if (n === 0) return "full";
  return n === p.steps.length + p.checks.length ? "quick" : null;
}

/** How many of the panel's rows are off (ids it doesn't list don't count). */
export const countOff = (p: StartPanel, off: Off): number => p.steps.filter((s) => off.steps.has(s.id)).length + p.checks.filter((c) => off.checks.has(c.id)).length;

/** The panel's Start: "Start Minor Release", or "Start Release" under Auto (no kind), plus " (Custom)" when anything is off. */
export const startLabel = (kind: ReleaseKind | null, custom: boolean): string => `Start ${kind ? `${KIND_WORD[kind]} ` : ""}Release${custom ? " (Custom)" : ""}`;

/** Auto's hint: the numbers the release chat's own rule may pick (a patch or a minor), "0.17.1 or 0.18.0". */
export const autoHint = (next: Record<ReleaseKind, string>): string => `${next.patch} or ${next.minor}`;

/** The rough minutes of what runs: landing checks, then each step and release check left on. Null when nothing it
    runs has a figure. */
export function totalMinutes(p: StartPanel, off: Off): number | null {
  const on = [...p.landing, ...p.steps.filter((s) => !off.steps.has(s.id)), ...p.checks.filter((c) => !off.checks.has(c.id))];
  const known = on.filter((x) => typeof x.minutes === "number");
  return known.length ? known.reduce((n, x) => n + x.minutes!, 0) : null;
}

/** A rough figure in words: "under 1 min", "about 9 min". */
export const minutesWord = (n: number): string => (n < 1 ? "under 1 min" : `about ${Math.round(n)} min`);

/** release.start's body from the panel: the kind unless Auto (null), each list only when something in it is off, in the
    panel's order. Auto with nothing off is {}: exactly a plain Start Release. */
export function startBody(p: StartPanel, kind: ReleaseKind | null, off: Off): ReleaseStartOptions {
  const skipSteps = p.steps.filter((s) => off.steps.has(s.id)).map((s) => s.id);
  const skipChecks = p.checks.filter((c) => off.checks.has(c.id)).map((c) => c.id);
  return { ...(kind ? { kind } : {}), ...(skipSteps.length ? { skipSteps } : {}), ...(skipChecks.length ? { skipChecks } : {}) };
}

/** The release card's line for what its start turned off: "Turned off: Docs pages and Spec replay.", or null. */
export function turnedOffLine(r: Pick<ReleaseRecord, "options">): string | null {
  const off = r.options?.off ?? [];
  if (!off.length) return null;
  const xs = off.map((o) => o.label);
  return `Turned off: ${xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`}.`;
}

/** The release card's line for the kind its start picked: "Minor release, picked at Start.", or null. */
export const kindLine = (r: Pick<ReleaseRecord, "options">): string | null => (r.options?.kind ? `${KIND_WORD[r.options.kind]} release, picked at Start.` : null);

/** A folded group's header line after its name: how many are on and their rough minutes. `off` null: a group nothing
    turns off ("all run", or `fixed`'s words). "3 of 5 on · about 12 min", "all run · about 9 min", "never turned off". */
export function groupSummary(items: readonly OptionItem[], off: ReadonlySet<string> | null, fixed = "all run"): string {
  const on = off ? items.filter((x) => !off.has(x.id)) : items;
  const count = off ? `${on.length} of ${items.length} on` : fixed;
  const known = on.filter((x) => typeof x.minutes === "number");
  return known.length ? `${count} · ${minutesWord(known.reduce((n, x) => n + x.minutes!, 0))}` : count;
}
