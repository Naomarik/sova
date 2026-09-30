import { createSignal } from "solid-js";
import type { Profile } from "../../shared/profiles";
import type { SessionSummary } from "../../shared/protocol";

/**
 * The start sheet (§app.session-list/profile-shelf): which profile it starts, app-wide, so the
 * shelf's Run and Start, New Session's menu and the head chip's Run Again all open the same one.
 */
const [sheet, setSheet] = createSignal<{ profile: Profile; cwd?: string } | null>(null);
export const profileStartSheet = sheet;
export const openProfileStart = (profile: Profile, cwd?: string): void => void setSheet({ profile, ...(cwd ? { cwd } : {}) });
export const closeProfileStart = (): void => void setSheet(null);

/** What opens a session the sheet made (App's adopt: route, list refresh, composer focus). */
let adopt: ((s: SessionSummary) => void) | null = null;
export function setProfileStartAdopt(fn: (s: SessionSummary) => void): void {
  adopt = fn;
}
export const adoptStarted = (s: SessionSummary): void => adopt?.(s);
