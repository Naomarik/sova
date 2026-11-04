/**
 * Wire types of a project's settings (§app.project-overseer/settings). Imported by the server and the web app.
 *
 * GET  /api/projects/:pid/settings                      -> ProjectSettingsInfo (project.settings.get)
 * GET  /api/projects/:pid/settings/history              -> SettingsHistoryRow[] newest first (project.settings.history)
 * POST /api/projects/:pid/settings/undo  {id}           -> {undone?: SettingsHistoryRow, card?: SettingsCardView} (project.settings.undo)
 * POST /api/projects/:pid/settings/cards/:card/withdraw -> ProjectSettingsInfo (project.settings.propose.withdraw; "local": Discard)
 * POST /api/projects/:pid/settings/apply {card, fingerprint} -> SettingsApplyResult (a trust grant: Sova's own page only)
 *
 * Sova-wide cards (§chat.create-mode/settings-cards) have no project:
 * GET  /api/settings/cards                              -> SovaCardsInfo (settings.cards.get)
 * POST /api/settings/cards/:card/withdraw               -> SovaCardsInfo (settings.cards.withdraw)
 * POST /api/settings/apply {card, fingerprint}          -> SettingsApplyResult (a trust grant: Sova's own page only)
 */

import type { SettingId } from "./settings-reference.ts";
import type { SovaSettingId } from "./sova-settings-reference.ts";

/** The keys `{setting: "project", …}` takes in sova_settings propose (root and archived only to refuse in words). */
export const PROJECT_EDIT_KEYS = ["name", "root", "archived", "stakeholder", "ownerHidden", "frozen"] as const;

/** The keys `{setting: "copies", …}` takes in sova_settings propose: this machine's copy limit (§app.project-services/instances). */
export const COPIES_EDIT_KEYS = ["limit"] as const;
/** The history field of this machine's copy limit (its value: 1–16, or null for the project's file's). */
export const COPIES_FIELD = "copies";

/** Who made a change. `via`: through what. */
export interface SettingsBy {
  kind: "operator" | "project-overseer" | "overseer" | "create";
  via?: "page" | "card" | "script" | "tool" | "undo";
  /** kind "create": the session id of the Create chat that prepared it. */
  chat?: string;
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
  setting: SettingId | SovaSettingId;
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

/** One computer in a mesh card's whole access after the change. */
export interface MeshAccessRow {
  peer: string;
  label: string;
  /** "sessions: presence, sessions, links, llm"; "none yet" for a computer being added. */
  before: string;
  /** "removed" for a computer being removed. */
  after: string;
  changed: boolean;
  /** Said plainly on the card: it can run anything here. */
  shell: boolean;
}

export type SettingsCardState = "waiting" | "applied" | "dismissed";

/** What a card changes: a project's settings, the Sova-wide settings, or a project's merge queue. */
export type SettingsCardKind = "project" | "sova" | "queue";

export interface SettingsCardView {
  /** `sc_<n>`, "local" for the uncommitted edits in the project folder, or `sw_<n>` for a Sova-wide card. */
  id: string;
  /** Absent: "project". */
  kind?: SettingsCardKind;
  /** Where a Sova-wide or merge queue card lands, in words, drawn as given: "Sova-wide", "Sova-wide, and your other computers by sync", ".sova/project.json on main". */
  place?: string;
  /** A merge queue card Applied while a branch checks: the save waits (state stays "waiting"); Cancel Save cancels it. */
  saveWaits?: boolean;
  /** The waiting save failed when its turn came (the queue keeps it, not retried). */
  saveFailed?: string;
  /** What to read before Apply, drawn as given: a mesh.resync card's confirm sentences. Read live while it waits. */
  notes?: string[];
  /** A field the person fills at Apply, sent only with it: `POST /api/settings/apply {…, input}`. Its value is never kept, nor shown back. */
  input?: { field: string; label: string };
  /** A mesh card: every computer's access to this one as it would be after the change. */
  access?: MeshAccessRow[];
  /** Applied, but these grants weren't recorded, each in words with where to approve it: it must not read as approved. */
  stillNeeds?: string[];
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
  /** null: a Sova-wide card, which has no project. */
  projectId: string | null;
  card: SettingsCardView | null;
  appliedNow: SettingsHistoryRow[];
  /** Prepared by a Create chat: its card's buttons stand in that chat. */
  create?: boolean;
}

export const isSettingsToolDetails = (v: unknown): v is SettingsToolDetails => {
  if (!v || typeof v !== "object") return false;
  const d = v as { kind?: unknown; projectId?: unknown };
  return d.kind === "settings-card" && (typeof d.projectId === "string" || d.projectId === null);
};

/** The Sova-wide cards (`GET /api/settings/cards`). */
export interface SovaCardsInfo {
  /** Waiting, oldest first. */
  cards: SettingsCardView[];
  /** Recently applied or dismissed (the chat's card reads its end). */
  recent: SettingsCardView[];
}
