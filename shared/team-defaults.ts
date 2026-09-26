import type { DelegateBackendId, WorkerChoice } from "./protocol";

// Settings → Teams (server/team-defaults.ts). Their own file, outside protocol.ts on purpose: its
// hash is the mesh's compatibility fingerprint, and these types are one host's local settings
// screen, never sent between hosts, so a change here must not make hosts refuse each other.
//
// GET /api/settings/team                -> TeamDefaultsInfo (~/.pi/agent/team-defaults.json; missing → the built-in
//                                          defaults with both roles off, `stored: false`; malformed → `error`)
// GET /api/settings/team/options        -> DelegateOptions (the same discovery as delegate/options)
// PUT /api/settings/team TeamDefaults   -> TeamDefaultsSaveResult (replaces the whole file. 400 bad shape, or a
//                                          CHANGED tuple its backend answered it can't run; unverifiable or
//                                          policy-denied tuples save with a warning. 409 while the stored file is
//                                          malformed: it is never overwritten. The subagents extension reads it
//                                          at team_create / team_add)

/** Team defaults (pi-config/extensions/subagents/team-defaults.ts, ~/.pi/agent/team-defaults.json):
    the standing coordinator and monitor every new team gets, unless a team opts out
    (team_create `defaults.coordinator` / `defaults.monitor` false). A missing file means both off.
    `fallback: null` = none. */
export interface TeamCoordinatorDefaults {
  enabled: boolean;
  role: string;
  primary: WorkerChoice;
  fallback: WorkerChoice | null;
  instructions: string;
}

export interface TeamMonitorDefaults {
  enabled: boolean;
  role: string;
  primary: WorkerChoice;
  fallback: WorkerChoice | null;
  /** A teammate's context fill, percent of its window, past which the monitor starts a handover. */
  contextPct: number;
  /** How often the monitor wakes itself to check. */
  everyMinutes: number;
  /** Provider usage: pause the whole team at `pausePct`, resume `resumeMarginMinutes` after the reset. */
  usage: { enabled: boolean; pausePct: number; resumeMarginMinutes: number };
  instructions: string;
}

export interface TeamDefaults {
  version: 1;
  coordinator: TeamCoordinatorDefaults;
  monitor: TeamMonitorDefaults;
  /** How long a member being replaced has to write its handoff before it is stopped. */
  handover: { retireTimeoutMinutes: number };
}

/** GET /api/settings/team. `settings` is the file, or — when there is none (`stored: false`) — the
    built-in defaults with both roles off. `error`: the file exists but can't be read; `settings`
    is then those same defaults and every save is refused until the file is fixed or removed. */
export interface TeamDefaultsInfo {
  settings: TeamDefaults;
  defaults: TeamDefaults;
  stored: boolean;
  error?: string;
  backends: { id: DelegateBackendId; label: string; efforts: string[] }[];
  /** Absolute path of the file, for the screen's footnote. */
  file: string;
}

/** PUT /api/settings/team: what is now stored, plus anything saved that could not be verified or
    that the policy refuses, one sentence each. */
export interface TeamDefaultsSaveResult extends TeamDefaultsInfo {
  warnings: string[];
}
