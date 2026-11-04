import type { MergeQueueSettings, MergeSettingsChange, MergeSettingsSaveResult, ModelChoice } from "../../shared/merge-queue-settings";

/**
 * What a merge queue card (§chat.create-mode/settings-cards) reaches of a project's queue: the same save the
 * Settings tab's Save makes (§app.merge-queue/settings-save), with its commit, refusals and waits, and the models
 * kept on this computer. Set by the live routes; a project the queue doesn't serve answers null.
 */
export interface QueueCardPort {
  settings(projectId: string): Promise<MergeQueueSettings | null>;
  save(projectId: string, changes: MergeSettingsChange): Promise<MergeSettingsSaveResult>;
  models(projectId: string, patch: { review?: ModelChoice | null; thread?: ModelChoice | null }): Promise<void>;
  /** Why this model can't be picked, or null. */
  modelDenial(ref: string): Promise<string | null>;
}

let port: QueueCardPort | null = null;
export const setQueueCardPort = (p: QueueCardPort | null): void => void (port = p);
export const queueCardPort = (): QueueCardPort | null => port;
