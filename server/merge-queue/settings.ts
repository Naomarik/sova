import type { ChecksDeclared } from "../../shared/merge-queue";
import type { EffectiveModel, FolderRef, MergeFixedValues, MergeQueueSettings } from "../../shared/merge-queue-settings";
import { HOOK_TIMEOUT_MAX, type ProjectDef } from "../../shared/project-contract";
import { mergeCopyPath } from "./copy";
import type { Git } from "./guard";
import { PROJECT_PLAYBOOK, THREAD_MAX_AGE_MS, THREAD_MAX_CONTEXT } from "./thread";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveModel, type ModelCheck, readModels } from "./models";
import { QueueStore } from "./store";
import { landHowSetting } from "./strategy";
import { REVIEW_KIT_DIR } from "./settings-edit";

/**
 * The settings block of the queue's view (§app.merge-queue/settings): what the queue uses, read from the target's
 * definition (never the working tree), the values kept on this computer, and Sova's fixed ones. Pure: the queue
 * hands in what it read.
 */

/**
 * Whether the main checkout's merge-queue playbook (which the merge thread reads) differs from the target's at `head`
 * (which the viewer shows): a tracked change, or a file the target hasn't.
 */
export async function playbookDiffers(git: Git, root: string, head: string): Promise<boolean> {
  const dir = PROJECT_PLAYBOOK.split("\\").join("/");
  const tracked = await git(["diff", "--quiet", head, "--", dir], root);
  if (tracked.code === 1) return true;
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "--", dir], root);
  return untracked.code === 0 && untracked.stdout.trim() !== "";
}

/** Sova's fixed values for `root`. */
export function fixedValues(root: string, o: { reviewTimeoutMs?: number; reviewTries?: number; retryDelayMs?: number } = {}): MergeFixedValues {
  return {
    reviewTimeoutMin: Math.round((o.reviewTimeoutMs ?? 20 * 60_000) / 60_000),
    reviewTries: o.reviewTries ?? 2,
    setupRetrySec: Math.round((o.retryDelayMs ?? 60_000) / 1000),
    threadMaxAgeH: Math.round(THREAD_MAX_AGE_MS / 3_600_000),
    threadMaxContext: THREAD_MAX_CONTEXT,
    checkMaxMin: Math.round(HOOK_TIMEOUT_MAX / 60),
    mergeCopy: mergeCopyPath(root),
  };
}

export interface SettingsInput {
  root: string;
  /** The registered project's id (folder sources need it); null: not registered. */
  projectId: string | null;
  /** The target's head the values come from. */
  head: string;
  target: string;
  def: ProjectDef | null;
  checks: ChecksDeclared;
  /** The kit is declared and readable. */
  review: boolean;
  /** The kit's files on the target, inside its folder. */
  kitFiles: string[];
  /** The default kit folder is there on the target (review can be turned on). */
  kitOnTarget: boolean;
  /** The project's own merge-queue playbook folder is there. */
  projectPlaybook: boolean;
  /** The main checkout's copy of that playbook isn't the target's (playbookDiffers). */
  projectPlaybookDiffers?: boolean;
  names: { setUp: boolean; count: number };
  models: { review: EffectiveModel; thread: EffectiveModel };
  projectFileDiffers: boolean;
  editBlocked?: string;
  pendingSave?: MergeQueueSettings["pendingSave"];
  fixed: MergeFixedValues;
  /** How a branch lands (strategy.ts landHowSetting). */
  how?: MergeQueueSettings["how"];
}

export function buildSettings(a: SettingsInput): MergeQueueSettings {
  const m = a.def?.merge;
  const declared = Array.isArray(m?.checks) ? m.checks : null;
  const list = declared
    ? declared.map((c) => ({ id: c.id, label: c.label, timeoutSec: c.timeout, rerun: c.rerun, optional: !!c.optional, ...(c.requires.length ? { requires: [...c.requires] } : {}) }))
    : a.checks === "test-command" && a.def?.test
      ? [{ id: "tests", label: "Tests", timeoutSec: a.def.test.timeout, rerun: false, optional: false, ...(a.def.test.requires?.length ? { requires: [...a.def.test.requires] } : {}) }]
      : [];
  const kit = a.review && m?.review ? m.review : undefined;
  const folder = (label: string, dir: string): FolderRef | null => (a.projectId ? { label, source: { kind: "project", project: a.projectId, ref: a.head, dir } } : null);
  const kitFolder = kit ? folder("Review instructions", kit) : null;
  const book = a.projectPlaybook ? folder("This project's playbook", PROJECT_PLAYBOOK.split("\\").join("/")) : null;
  const projectBook = book ? { ...book, differsFromFolder: !!a.projectPlaybookDiffers } : null;
  return {
    at: a.head,
    projectFileDiffers: a.projectFileDiffers,
    ...(a.editBlocked ? { editBlocked: a.editBlocked } : {}),
    ...(a.pendingSave ? { pendingSave: structuredClone(a.pendingSave) } : {}),
    landing: { target: a.target, push: typeof m?.push === "boolean" ? m.push : null, names: { ...a.names } },
    checks: { mode: a.checks, list },
    reuse: m?.reuse !== false,
    setup: { steps: (a.def?.setup ?? []).map((s) => ({ id: s.id })) },
    ...(m?.install ? { install: { inputs: [...m.install.inputs], timeoutSec: m.install.timeout } } : {}),
    review: {
      on: !!kit,
      ...(kit ? { kit } : {}),
      files: kit ? [...a.kitFiles] : [],
      ...(kitFolder ? { folder: kitFolder } : {}),
      model: a.models.review,
      canTurnOn: !!kit || a.kitOnTarget,
    },
    thread: {
      model: a.models.thread,
      playbooks: [{ label: "Sova's method", source: { kind: "builtin", id: "merge-queue-method" } }, ...(projectBook ? [projectBook] : [])],
    },
    fixed: a.fixed,
    ...(a.how ? { how: a.how } : {}),
  };
}

// ---- a project the queue doesn't serve yet ------------------------------------------------------

export interface BareSettingsDeps {
  /** The queues' records folder (`<state>/merge-queue`): only read here. */
  base: string;
  git: Git;
  /** The served rule's reading of the root (served.ts setupOf): its target, the target's head, what it declares. */
  setupOf: (root: string) => Promise<{ target: string; head: string; checks: ChecksDeclared }>;
  definitionAt: (root: string, ref: string) => Promise<{ def: ProjectDef | null; error: string | null }>;
  projectIdOf: (root: string) => string | null;
  modelCheck: ModelCheck;
  legacyNames?: { root: string; file: string };
  hosts?: Parameters<typeof landHowSetting>[0]["hosts"];
}

/**
 * The settings of a listed project the queue doesn't serve yet (the not-set-up screen: How it lands with its
 * suggestion from origin, the models, Sova's fixed values), read from Git, the definition and this computer's files
 * alone: no queue is made and nothing is written (the served rule's promise). Null: its target has no commit yet.
 */
export async function bareSettings(root: string, d: BareSettingsDeps): Promise<MergeQueueSettings | null> {
  const s = await d.setupOf(root);
  if (!s.head) return null;
  const at = await d.definitionAt(root, s.head);
  const def = at.def;
  const store = new QueueStore(d.base, root);
  const names = store.namesFileOf(d.legacyNames);
  let count = 0;
  if (names.exists)
    try {
      const raw = JSON.parse(readFileSync(names.file, "utf8")) as { privateNames?: unknown[] };
      count = Array.isArray(raw.privateNames) ? raw.privateNames.length : 0;
    } catch {}
  const has = async (path: string) => (await d.git(["cat-file", "-e", `${s.head}:${path}`], root)).code === 0;
  const shown = await d.git(["show", `${s.head}:.sova/project.json`], root);
  let local: string | null = null;
  try {
    local = readFileSync(join(root, ".sova/project.json"), "utf8");
  } catch {}
  const picks = readModels(store.dir);
  const playbook = existsSync(join(root, PROJECT_PLAYBOOK, "PLAYBOOK.md"));
  return buildSettings({
    root,
    projectId: d.projectIdOf(root),
    head: s.head,
    target: s.target,
    def,
    checks: s.checks,
    review: false,
    kitFiles: [],
    kitOnTarget: await has(REVIEW_KIT_DIR),
    projectPlaybook: playbook,
    ...(playbook ? { projectPlaybookDiffers: await playbookDiffers(d.git, root, s.head) } : {}),
    names: { setUp: names.exists, count },
    models: { review: await effectiveModel(picks.review, d.modelCheck), thread: await effectiveModel(picks.thread, d.modelCheck) },
    projectFileDiffers: (shown.code === 0 ? shown.stdout : null) !== local,
    fixed: fixedValues(root),
    how: await landHowSetting({ dir: store.dir, root, projectHow: def?.merge?.land, ...(d.hosts ? { hosts: d.hosts } : {}) }),
  });
}
