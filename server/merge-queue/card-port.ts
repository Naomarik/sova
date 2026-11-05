import type { MergeQueueSettings, MergeSettingsChange, MergeSettingsSaveResult, ModelChoice } from "../../shared/merge-queue-settings";

/**
 * What a merge queue card (§chat.create-mode/settings-cards) reaches of a project's queue: the same save the
 * Settings tab's Save makes (§app.merge-queue/settings-save), with its commit, refusals and waits, and the models
 * kept on this computer. Set by the live routes; a project the queue doesn't serve answers null.
 */
export interface QueueCardPort {
  settings(projectId: string): Promise<MergeQueueSettings | null>;
  /** The project is known to have no queue: queues are running and its setup reads as not done. Anything unknown: false. */
  noQueue?(projectId: string): Promise<boolean>;
  save(projectId: string, changes: MergeSettingsChange): Promise<MergeSettingsSaveResult>;
  models(projectId: string, patch: { review?: ModelChoice | null; thread?: ModelChoice | null }): Promise<void>;
  /** Why this model can't be picked, or null. */
  modelDenial(ref: string): Promise<string | null>;
  /** The release holding the target, as shown, or undefined: a branch's the wait, if any. */
  heldByRelease?(projectId: string): Promise<string | undefined>;
  /**
   * Run `fn`, a commit on `branch`, at a moment no branch holds the target: true when it ran (the queue takes the
   * commit as its own), false while a branch checks or the target waits for a resume (nothing ran), null when the
   * queue doesn't serve the project.
   */
  whenQuiet?(projectId: string, branch: string, fn: () => Promise<void>): Promise<boolean | null>;
}

let port: QueueCardPort | null = null;
export const setQueueCardPort = (p: QueueCardPort | null): void => void (port = p);
export const queueCardPort = (): QueueCardPort | null => port;

/** What waits for the queue's next quiet point: held cards' Apply (server/project-settings.ts), by the queue's root. */
let quietWork: ((root: string) => Promise<void>) | null = null;
export const setQueueQuietWork = (w: ((root: string) => Promise<void>) | null): void => void (quietWork = w);
export const queueQuietWork = (): ((root: string) => Promise<void>) | null => quietWork;
