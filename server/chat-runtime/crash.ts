// The one crash rule for every chat process, a chat's and a worker's alike (§app.chat-processes/crash,
// §app.chat-processes/worker-crash): a process that died with a run in flight, that run not itself a
// resume, is continued once, with Settings → Overseer's "Resume interrupted sessions" on.
import { readOverseerSettings } from "../overseer-store";
import type { InflightMarker } from "./inflight";

/** Why a dead chat process's run is not continued. */
export type CrashSkip = "no run in flight" | "already a resume" | "setting off";

/** Null: continue it once; else why not. */
export function crashSkip(marker: InflightMarker | null, settingOn: boolean = crashResumeOn()): CrashSkip | null {
  return !marker ? "no run in flight" : marker.auto ? "already a resume" : !settingOn ? "setting off" : null;
}

/** The setting both crash resumes and a restart's resume go by (§app.overseer/auto-resume). */
export const crashResumeOn = (): boolean => readOverseerSettings().autoResume !== false;
