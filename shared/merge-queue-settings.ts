/**
 * The merge queue's settings as its Settings tab shows them (§app.merge-queue/settings): every value the queue uses,
 * where each is kept (the project's file on the target, this computer, or fixed by Sova), the per-project review and
 * merge-thread models, and the saves the tab may make. Carried on the queue's view (`MergeQueueView.settings`).
 * Pure types, imported by the server and the web app.
 */
import type { FolderSource } from "./folder-read";

export type { FolderSource } from "./folder-read";

/** Project file / This computer / Set by Sova. */
export type SettingSource = "project" | "computer" | "sova";

/** A model as the pickers name it: "provider/model", and its effort. */
export interface ModelChoice {
  model: string;
  thinking?: string | null;
}

export interface EffectiveModel {
  /** Picked for this project on this computer; null: Same as new chats. */
  picked: ModelChoice | null;
  /** What the next chat starts on. */
  effective: ModelChoice;
  /** Why the picked model isn't the one used (off in Settings → Models, not signed in). */
  fallbackWhy?: string;
}

export interface MergeCheckSetting {
  id: string;
  label: string;
  timeoutSec: number;
  rerun: boolean;
  /** Runs only when the merge thread picks it. */
  optional: boolean;
  requires?: string[];
}

/** One labelled group of the folder viewer. */
export interface FolderRef {
  label: string;
  source: FolderSource;
  /** The project's merge-queue playbook only: the main checkout's working copy, which the merge thread reads, isn't
   *  the target's (the viewer shows the target's). */
  differsFromFolder?: boolean;
}

/** The values a save may change (q3): push, review on or off, each check's time limit, rerun and optional. */
export interface MergeSettingsChange {
  push?: boolean;
  review?: boolean;
  /** How it lands, in the project file (`merge.land`; "local" removes the key, the default). */
  land?: import("./merge-queue").LandHow;
  checks?: Record<string, { timeoutSec?: number; rerun?: boolean; optional?: boolean }>;
  /** Reuse passes from identical code (`merge.reuse`; true removes the key, the default). */
  reuse?: boolean;
  /** Automatic cleanup deletes the branch too (`merge.deleteBranches`; false removes the key, the default). */
  deleteBranches?: boolean;
}

/** Sova's fixed values: shown, never changed here. */
export interface MergeFixedValues {
  reviewTimeoutMin: number;
  reviewTries: number;
  setupRetrySec: number;
  threadMaxAgeH: number;
  threadMaxContext: number;
  checkMaxMin: number;
  /** Where the merge copy lives. */
  mergeCopy: string;
}

export interface MergeQueueSettings {
  /** The target's commit the project-file values come from. */
  at: string;
  /** The main checkout's .sova/project.json isn't the target's (an edit not committed yet). */
  projectFileDiffers: boolean;
  /** Why saves are refused now ("Commit or discard the edit in the project folder first"). */
  editBlocked?: string;
  /** A save waiting for the branch checking now, or for the release holding the queue. `release`: that release, as
   *  shown ("release v0.4.0"), read from the hold now, so it goes when the hold lifts (settingsWaitingWords). */
  pendingSave?: { at: string; changes: MergeSettingsChange; failed?: string; release?: string };
  landing: {
    target: string;
    /** null: absent, so it pushes when origin exists. */
    push: boolean | null;
    /** Never the names themselves. */
    names: { setUp: boolean; count: number };
  };
  checks: { mode: "declared" | "test-command" | "none" | "unset"; list: MergeCheckSetting[] };
  /** Checks may reuse passes from identical code (`merge.reuse` isn't false). Absent: on. */
  reuse?: boolean;
  /** Automatic cleanup deletes a landed branch as well as its folder (`merge.deleteBranches`). Absent: off. */
  deleteBranches?: boolean;
  setup: { steps: { id: string; label?: string }[] };
  install?: { inputs: string[]; timeoutSec: number };
  review: {
    on: boolean;
    /** The kit's folder, when declared. */
    kit?: string;
    /** The kit's files on the target, inside its folder. */
    files: string[];
    /** The kit as the folder viewer opens it. */
    folder?: FolderRef;
    model: EffectiveModel;
    /** Review can be turned on: the kit's folder is there on the target. */
    canTurnOn: boolean;
  };
  thread: {
    model: EffectiveModel;
    /** Sova's method first, then the project's own. */
    playbooks: FolderRef[];
  };
  fixed: MergeFixedValues;
  /** How it lands (al_3): the choice in effect and where it comes from (server/merge-queue/strategy.ts landHowSetting). */
  how?: LandHowSetting;
}

/** How a branch lands: this computer's choice ?? the project file's `merge.land` ?? local. */
export interface LandHowSetting {
  effective: import("./merge-queue").LandHow;
  from: "computer" | "project" | "default";
  project?: import("./merge-queue").LandHow;
  computer?: import("./merge-queue").LandHow;
  /** What origin's host suggests ("Suggested from origin: GitHub"); never applied by itself. */
  suggested?: { how: import("./merge-queue").LandHow; why: string };
  /** The effective host's sign-in on this computer (request strategies only). */
  signIn?: { ok: boolean; why?: string };
}

/** What a save answers. */
/** What a save answers: committed on the target; waiting for the branch checking now, or for the release holding the
 *  queue (`release`, as shown); or, on a project that lands by request or by pushing a branch, published that way (the
 *  change applies once the host merges it). */
export type MergeSettingsSaveResult =
  | { state: "saved"; commit: string; pushed: false }
  | { state: "waiting"; release?: string }
  | { state: "requested"; commit: string; branch: string; url: string; number: number }
  | { state: "pushed"; commit: string; branch: string };

/** The words a refused save says while the settings file has uncommitted edits. */
export const SETTINGS_DIRTY_WORDS = "Commit or discard the edit in the project folder first";
/** The words while a save waits for the branch checking now. */
export const SETTINGS_WAITING_WORDS = "Saves when the current branch finishes";
/** The words for a waiting save: the release holding it when one does (`release`, as shown), else the branch's. */
export const settingsWaitingWords = (release?: string): string => `Saves ${settingsWaitingClause(release)}`;
/** The same, as a clause for a sentence of its own ("{how} saves to the project file {clause}."). */
export const settingsWaitingClause = (release?: string): string => (release ? `once ${release} is published or abandoned` : "when the current branch finishes");
