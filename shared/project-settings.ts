/**
 * Wire types of a project's settings (§app.project-overseer/settings). Imported by the server and the web app.
 *
 * GET  /api/projects/:pid/settings                      -> ProjectSettingsInfo (project.settings.get)
 * GET  /api/projects/:pid/settings/history              -> SettingsHistoryRow[] newest first (project.settings.history)
 * POST /api/projects/:pid/settings/undo  {id}           -> {undone?: SettingsHistoryRow, card?: SettingsCardView} (project.settings.undo)
 * POST /api/projects/:pid/settings/cards/:card/withdraw -> ProjectSettingsInfo (project.settings.propose.withdraw; "local": Discard)
 * POST /api/projects/:pid/settings/apply {card, fingerprint} -> SettingsApplyResult (a trust grant: Sova's own page only)
 */

import type { SettingId } from "./settings-reference.ts";

/** Who made a change. `via`: through what. */
export interface SettingsBy {
  kind: "operator" | "project-overseer" | "overseer";
  via?: "page" | "card" | "script" | "tool" | "undo";
}

/** One line of settings-history.jsonl. A file's `from`/`to` are blob ids (null: absent), with the commit that landed it. */
export interface SettingsHistoryRow {
  id: string;
  at: string;
  field: string;
  from: unknown;
  to: unknown;
  by: SettingsBy;
  revertOf?: string;
  commit?: string;
  card?: string;
  /** The field and its values in words (GET …/settings/history adds them). */
  label?: string;
  fromText?: string;
  toText?: string;
}

/** A grant the card holds: what it allows, keyed like its approval (`project:<root>#<id>` for a profile). */
export interface SettingsGrant {
  key: string;
  setting: SettingId;
  what: string;
}

/** One Sova-kept field's change, in words. */
export interface KeptChange {
  field: string;
  label: string;
  from: unknown;
  to: unknown;
  fromText: string;
  toText: string;
  /** What it allows, when it is a grant. */
  grant?: string;
}

/** One file's change. */
export interface FileChangeView {
  setting: SettingId;
  id?: string;
  /** Relative to the project root. */
  path: string;
  change: "added" | "changed" | "removed";
  /** In plain words: "Profile Reviewer: may also read other sessions". */
  summary: string;
}

export type SettingsCardState = "waiting" | "applied" | "dismissed";

export interface SettingsCardView {
  /** `sc_<n>`, or "local" for the uncommitted edits in the project folder. */
  id: string;
  state: SettingsCardState;
  title: string;
  why: string;
  by: SettingsBy;
  createdAt: string;
  kept: KeptChange[];
  files: FileChangeView[];
  grants: SettingsGrant[];
  /** Where the file changes land: "<branch> in <folder>". */
  lands: string | null;
  /** The exact file changes (a unified diff, cut at 64 KB). */
  diff: string;
  /** What Apply must send back. */
  fingerprint: string;
  /** Applied at once in the operator's turn (history ids, each with Undo). */
  appliedNow?: SettingsHistoryRow[];
  appliedAt?: string;
  commit?: string;
  dismissedAt?: string;
}

/** One row of the Settings tab's All Settings. */
export interface SettingsRow {
  setting: SettingId;
  label: string;
  /** A profile's, playbook's or mode's id. */
  name?: string;
  state: string;
  detail?: string;
  where: "sova" | "file";
  /** Where it is changed or approved: an in-app link. */
  href: string;
  /** On the project's Settings tab: the id of its section's heading (the page scrolls to it). */
  anchor?: string;
  hrefLabel: string;
}

export interface ProjectSettingsInfo {
  rows: SettingsRow[];
  /** Cards waiting, oldest first. */
  cards: SettingsCardView[];
  /** The uncommitted settings edits in the project folder, as one card, or null. */
  local: SettingsCardView | null;
  /** The project root is in Git (file edits need it). */
  git: boolean;
  /** Recently applied or dismissed cards (the chat's card reads its end). */
  recent: SettingsCardView[];
}

export interface SettingsApplyResult {
  card: SettingsCardView;
  /** The approvals recorded, by key. */
  approved: string[];
  commit?: string;
}

/** The tool's result details for a propose (the chat draws the card from them). */
export interface SettingsToolDetails {
  kind: "settings-card";
  projectId: string;
  card: SettingsCardView | null;
  appliedNow: SettingsHistoryRow[];
}

export const isSettingsToolDetails = (v: unknown): v is SettingsToolDetails =>
  !!v && typeof v === "object" && (v as { kind?: unknown }).kind === "settings-card" && typeof (v as { projectId?: unknown }).projectId === "string";
