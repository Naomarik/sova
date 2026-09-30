import { singletonRunningText, titleCase, type ProfileSource } from "../../shared/profiles";
import type { SessionSummary } from "../../shared/protocol";
import { startProfileSession } from "./api";
import { toast } from "./ui-state";

/**
 * Run / Start / Run Again (§app.session-list/profile-shelf): a new session in `cwd` with the profile
 * picked, opened on its empty screen, where the picker (and a linked playbook's card) show it.
 * Nothing is sent. The shelf and the head chip share this one path.
 */

/** What opens a session made here (App's adopt: route, list refresh, composer focus). */
let adopt: ((s: SessionSummary) => void) | null = null;
export function setProfileStartAdopt(fn: (s: SessionSummary) => void): void {
  adopt = fn;
}

export async function runProfile(p: { source: ProfileSource; id: string; label: string }, cwd: string | null | undefined): Promise<void> {
  if (!cwd) {
    toast(`No folder to start ${p.label} in. Open a session in the folder you want, then try again.`);
    return;
  }
  try {
    const s = await startProfileSession(cwd, { source: p.source, id: p.id });
    adopt?.(s);
  } catch (err) {
    const body = (err as { body?: { running?: { id: string; title: string } } }).body;
    const running = body?.running;
    if (running)
      toast(singletonRunningText(p.label), {
        action: { label: `Open the Running ${titleCase(p.label)}`, run: () => void (location.hash = `#/sid/${encodeURIComponent(running.id)}`) },
      });
    else toast(`Couldn't start ${p.label}. ${err instanceof Error ? err.message : String(err)}`);
  }
}
