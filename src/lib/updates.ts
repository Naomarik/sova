import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { UpdateCheckResult, UpdatesState, UpdateTarget } from "../../shared/protocol";
import { getUpdates } from "./api";
import { socketReconnects } from "./socket";

/**
 * This machine's updates as the page knows them: one copy for the Settings section,
 * the dot on the Settings buttons and the "Sova was updated" note
 *. Read at load, every 10 minutes while the page is visible, after every
 * reconnect, and every 1.5 s while a check or an upgrade runs.
 */

const [state, setState] = createSignal<UpdatesState | null>(null);
export const updatesState = state;
export const setUpdatesState = (s: UpdatesState) => setState(() => s);

/** The last check found an update this copy can install: the dot on Settings. */
export const updateAvailable = (): boolean => !!state()?.available;

/** The commit the server ran when this page loaded. */
let loadedHead: string | null | undefined;
const [updated, setUpdated] = createSignal(false);
/** The server now runs another commit than when this page loaded: "Sova was updated · Reload". */
export const updatedSinceLoad = updated;

/** Whether the server's running commit differs from the one this page loaded with. Pure. */
export function headMoved(loaded: string | null | undefined, now: string | null | undefined): boolean {
  return !!loaded && !!now && loaded !== now;
}

export async function refreshUpdates(): Promise<UpdatesState | null> {
  try {
    const s = await getUpdates();
    setUpdatesState(s);
    const head = s.running.startedHead;
    if (loadedHead === undefined) loadedHead = head;
    else if (headMoved(loadedHead, head)) setUpdated(true);
    return s;
  } catch {
    return null;
  }
}

/** Something runs that the section should follow closely. */
export const busy = (s: UpdatesState | null): boolean => !!s && (s.checking || s.job?.state === "running");

/** Watch for the page's lifetime: call once, inside the app's root. */
export function watchUpdates(): void {
  void refreshUpdates();
  const slow = setInterval(() => {
    if (!document.hidden) void refreshUpdates();
  }, 10 * 60_000);
  onCleanup(() => clearInterval(slow));
  createEffect(on(socketReconnects, () => void refreshUpdates(), { defer: true }));
  // Close following while a check or an upgrade runs (the restart drops the server for a moment).
  createEffect(() => {
    if (!busy(state())) return;
    const fast = setInterval(() => void refreshUpdates(), 1500);
    onCleanup(() => clearInterval(fast));
  });
}

/** The source as the section names it. */
export function sourceName(s: UpdatesState["settings"]["source"]): string {
  return s.kind === "stable" ? "Stable" : s.kind === "master" ? "master" : s.branch;
}

/** The button that names the act: "Upgrade to v0.3.3", "Switch to master". Pure. */
export function upgradeLabel(source: UpdatesState["settings"]["source"], target: UpdateTarget, running: UpdatesState["running"]): string {
  if (source.kind === "stable") return `Upgrade to ${target.label}`;
  const on = running.branch === target.label;
  return on ? `Upgrade to Latest ${target.label}` : `Switch to ${target.label}`;
}

/** What runs, as the section's first line says it: "Sova v0.3.2 · stable release", "master · 86 changes past v0.3.2". Pure. */
export function runningLine(r: UpdatesState["running"]): string {
  if (!r.head) return "Sova, not from a git checkout";
  if (r.version) return `Sova ${r.version} · ${r.kind === "installer" ? "stable release" : "release"}`;
  const where = r.branch ?? "detached";
  if (r.baseVersion && r.pastBase !== null) return `${where} · ${r.pastBase} ${r.pastBase === 1 ? "change" : "changes"} past ${r.baseVersion}`;
  return where;
}

export const KIND_LABEL: Record<UpdatesState["running"]["kind"], string> = {
  installer: "Installed copy",
  developer: "Developer copy",
  "check-only": "Check only",
};

/** What the last check found, in a sentence (the button and the notes are separate). Pure. */
export function resultLine(result: UpdateCheckResult, source: UpdatesState["settings"]["source"]): string {
  switch (result.state) {
    case "up-to-date":
      return `Up to date with ${sourceName(source)}.`;
    case "ahead":
      return result.message;
    case "diverged":
      return result.message;
    case "available": {
      const t = result.target;
      if (t.version) return `Update available: ${t.version}`;
      if (t.count !== null) return `${t.count} new ${t.count === 1 ? "commit" : "commits"}${t.subject ? ` · latest: ${t.subject}` : ""}`;
      return `Update available: ${t.label}`;
    }
  }
}
