/**
 * The settings reference (§app.project-overseer/settings): every setting of a project, Sova-kept and
 * in the project's files, with the keys its parser reads and what needs the operator's approval.
 * The project overseer's prompt carries `settingsIndex()`; `sova_settings reference {setting}` gives
 * one entry in full (`referenceText`). Generated from the parsers' own key lists where they exist
 * (powers, limits, the services contract, profile fields, MODE.md keys, offers keys); the ratchet
 * (shared/settings-reference.test.ts) fails when a parser reads a key no entry names.
 * Pure, imported by the server and the web app.
 */

import { DEFINITION_KEYS, CONTRACT_FILE } from "./project-contract.ts";
import { LIMIT_KEYS, LIMIT_LABEL } from "./profiles.ts";
import { POWERS, POWER_INFO } from "./powers.ts";
import { PO_CAP_LABEL, type ProjectOverseerCaps } from "./project-overseer.ts";
import { OFFERS_FILE } from "./session-offers.ts";
import { COPIES_EDIT_KEYS } from "./project-settings.ts";

export type SettingId =
  | "overseer.watch"
  | "overseer.powers"
  | "overseer.models"
  | "overseer.assistant-models"
  | "overseer.abilities"
  | "overseer.extra"
  | "overseer.limits"
  | "overseer.pace"
  | "overseer.hold"
  | "overseer.brake"
  | "overseer.memory"
  | "project.name"
  | "project.stakeholder"
  | "project.ownerHidden"
  | "project.frozen"
  | "project.archive"
  | "copies"
  | "services"
  | "profile"
  | "playbook"
  | "schedule"
  | "mode"
  | "offers";

export interface ReferenceEntry {
  id: SettingId;
  label: string;
  /** Kept by Sova (applies through the overseer's settings) or in a file of the project's (lands as a commit). */
  where: "sova" | "file";
  /** The file, relative to the project root (`<id>` a profile's, playbook's or mode's id). */
  file?: string;
  /** One line: what it is. */
  summary: string;
  /** How sova_settings propose names it. */
  edit: string;
  /** What makes a change of it a grant (the operator's approval), or null: never one. */
  grant: string | null;
  /** Each key its parser reads, and what it means. */
  keys: Record<string, string>;
  /** Where the operator changes or approves it, in words. */
  changedAt: string;
}

const capKeys = Object.fromEntries((Object.keys(PO_CAP_LABEL) as (keyof ProjectOverseerCaps)[]).map((k) => [`caps.${k}`, PO_CAP_LABEL[k]]));
const powerKeys = Object.fromEntries(
  POWERS.flatMap((p) => [
    [`powers.overseer.${p}`, `${POWER_INFO[p].label} (the overseer on its own)${POWER_INFO[p].placedOnly ? "; only while an organization places the project" : ""}`],
    ...(POWER_INFO[p].assistant ? [[`powers.assistant.${p}`, `${POWER_INFO[p].assistantLabel ?? POWER_INFO[p].label} (the Project Assistant from a client)`]] : []),
  ]),
);
const profileLimitKeys = Object.fromEntries(LIMIT_KEYS.map((k) => [`limits.${k}`, LIMIT_LABEL[k]]));
const serviceKeys = Object.fromEntries(DEFINITION_KEYS.service.map((k) => [`services.<name>.${k}`, `a service's ${k}`]));
const topKeys: Record<string, string> = {
  version: "the contract's version (1)",
  slots: "the project's default for how many copies may run at once ({cap}, 1–16); this machine's copy limit (the copies setting) overrides it",
  host: "where it runs",
  setup: "steps that set a copy up",
  data: "each copy's data (a file copied or a provisioned store)",
  services: "the services by name: each a command or static folder, its ports, readiness, scope and isolation",
  open: "the endpoint the Branches tab opens",
  hooks: "the probe",
  test: "the test verb",
  share: "which endpoints may be shared, for how long",
  deploy: "the deploy targets and their recipe",
  sources: "other checkouts it builds from",
};
const COPIES_KEY_WORDS: Record<(typeof COPIES_EDIT_KEYS)[number], string> = {
  limit: "how many of the project's copies may run at once on this machine, 1–16; null removes this machine's value, so the main checkout's .sova/project.json (its slots {cap}, default 4) applies",
};
const copiesKeys = Object.fromEntries(COPIES_EDIT_KEYS.map((k) => [k, COPIES_KEY_WORDS[k]]));
const serviceTop = Object.fromEntries(DEFINITION_KEYS.top.map((k) => [k, topKeys[k] ?? k]));

export const SETTINGS_REFERENCE: Record<SettingId, ReferenceEntry> = {
  "overseer.watch": {
    id: "overseer.watch",
    label: "Watch",
    where: "sova",
    summary: "Whether the overseer looks at the project on its own.",
    edit: '{setting: "overseer", patch: {watch: true|false}}',
    grant: "Turning it on.",
    keys: { watch: "true: it looks on its own (within the pace and the looks limit); false: only when asked." },
    changedAt: "Settings → Overseer",
  },
  "overseer.powers": {
    id: "overseer.powers",
    label: "What may happen without you",
    where: "sova",
    summary: "One On/Off switch per power, for the overseer on its own and for the Project Assistant from a client.",
    edit: '{setting: "overseer", patch: {powers: {overseer: {<power>: true|false}, assistant: {<power>: true|false}}}}',
    grant: "Any switch turned On, in either column.",
    keys: {
      powers: "the switches, by column (overseer, assistant) and power id",
      powersNoteSeen: "hides the one-time note about levels becoming switches (the page's own)",
      autonomy: "older wording, one release: a level L0–L3 sets the overseer column by the carry-over; use powers",
      confirmKinds: "gone: accepted and ignored",
      ...powerKeys,
    },
    changedAt: "Settings → What may happen without you",
  },
  "overseer.brake": {
    id: "overseer.brake",
    label: "Resume (the brake)",
    where: "sova",
    summary: "Lifts the brake that holds every switch Off (paused by an attach, or an empty roster).",
    edit: '{setting: "overseer", patch: {resume: true}}',
    grant: "Always: it lets the switches act again.",
    keys: { resume: "true lifts the brake" },
    changedAt: "Settings → What may happen without you (Resume)",
  },
  "overseer.models": {
    id: "overseer.models",
    label: "Models",
    where: "sova",
    summary: "The models and thinking levels of the overseer and of the sessions it starts.",
    edit: '{setting: "overseer", patch: {model, thinking, codingModel, codingThinking, gatheringModel, gatheringThinking}}',
    grant: null,
    keys: {
      model: '"provider/model" of the overseer itself, or null for the default',
      thinking: "its thinking level, or null",
      codingModel: "coding sessions' model, or null for its own",
      codingThinking: "coding sessions' thinking, or null",
      gatheringModel: "gathering sessions' model (the one people talk to), or null for its own",
      gatheringThinking: "gathering sessions' thinking, or null",
    },
    changedAt: "Settings → Sessions it starts",
  },
  "overseer.assistant-models": {
    id: "overseer.assistant-models",
    label: "The Project Assistant's models",
    where: "sova",
    summary: "This project's override of the models the Project Assistant's coding and gathering sessions use.",
    edit: '{setting: "overseer", patch: {assistantModels: {coding?: {model, thinking?} | null, gathering?: … } | null}}',
    grant: null,
    keys: { assistantModels: "per kind of work (coding, gathering): {model, thinking?}, or null to inherit the organization's" },
    changedAt: "Settings → What may happen without you (the Project Assistant column)",
  },
  "overseer.abilities": {
    id: "overseer.abilities",
    label: "Gathering sessions' abilities",
    where: "sova",
    summary: "What the gathering sessions it starts can do; null is Automatic.",
    edit: '{setting: "overseer", patch: {gatheringAbilities: {…} | null}}',
    grant: "Any change.",
    keys: { gatheringAbilities: "the abilities object (draw, read links, …), or null for Automatic" },
    changedAt: "Settings → Sessions it starts",
  },
  "overseer.extra": {
    id: "overseer.extra",
    label: "Extra instructions",
    where: "sova",
    summary: "Text added last to the overseer's prompt.",
    edit: '{setting: "overseer", patch: {extraSystemPrompt: "…"}}',
    grant: "Any change: it changes what the overseer is told.",
    keys: { extraSystemPrompt: "at most 8,000 characters; blank removes them" },
    changedAt: "Settings → Extra instructions",
  },
  "overseer.limits": {
    id: "overseer.limits",
    label: "Limits",
    where: "sova",
    summary: "What it may start or send per message the operator sends, per day on its own, and at once.",
    edit: '{setting: "overseer", patch: {caps: {<limit>: <whole number> | null}}}',
    grant: "A limit raised (null, Unlimited, is the highest).",
    keys: { caps: "the limits by name; null is Unlimited (never for the at-once ones)", ...capKeys },
    changedAt: "Settings → Limits",
  },
  "overseer.pace": {
    id: "overseer.pace",
    label: "Pace",
    where: "sova",
    summary: "How often it looks on its own.",
    edit: '{setting: "overseer", patch: {watchGapMin, soonLookSec}}',
    grant: "Looking more often: watchGapMin lowered, soonLookSec turned on or lowered.",
    keys: {
      watchGapMin: "at most one look every this many minutes (1–1440)",
      soonLookSec: "a look this many seconds after something to see soon (30–3600), or null for Off",
    },
    changedAt: "Settings → Limits",
  },
  "overseer.hold": {
    id: "overseer.hold",
    label: "The hold",
    where: "sova",
    summary: "How long an act that reaches a person or the code waits, cancellable, before it goes ahead.",
    edit: '{setting: "overseer", patch: {holdMin: <minutes>}}',
    grant: "Shortened (0 is no hold).",
    keys: { holdMin: "minutes, 0–1440 (0: no hold)" },
    changedAt: "Settings → Limits",
  },
  "overseer.memory": {
    id: "overseer.memory",
    label: "Its memory",
    where: "sova",
    summary: "Whether the overseer keeps a memory across conversations, its type and size.",
    edit: '{setting: "memory", on: true|false, type?: "uniichat"|"zoomable", size?: <bytes>}',
    grant: null,
    keys: { on: "memory on or off", type: '"uniichat" or "zoomable"', size: "its size in bytes" },
    changedAt: "its chat page's memory switch",
  },
  "project.name": {
    id: "project.name",
    label: "The project's name",
    where: "sova",
    summary: "The name Sova shows for the project.",
    edit: '{setting: "project", name: "…"}',
    grant: null,
    keys: { name: "the name", root: "the project's folder: moving it is the operator's own, on the project page" },
    changedAt: "the project page's head",
  },
  "project.stakeholder": {
    id: "project.stakeholder",
    label: "The main stakeholder",
    where: "sova",
    summary: "An organization's project only: the active roster person who decides every area of the project no one else on the roster decides by name (promotions and conflicts there go to them).",
    edit: '{setting: "project", stakeholder: "<person id>" | null}',
    grant: null,
    keys: { stakeholder: "an active roster person's id (p_…), or null for none" },
    changedAt: "the project page's Main stakeholder select",
  },
  "project.ownerHidden": {
    id: "project.ownerHidden",
    label: "Shown on the owner's page",
    where: "sova",
    summary: "An organization's project only, while the org has an owner: whether the project shows on the owner's page (Show this project on {name}'s page).",
    edit: '{setting: "project", ownerHidden: true|false}',
    grant: "Shown again (ownerHidden false after true): it widens who sees the project.",
    keys: { ownerHidden: "true: hidden from the owner's page; false: shown (the default)" },
    changedAt: "the project page's Owner Page card",
  },
  "project.frozen": {
    id: "project.frozen",
    label: "Frozen spec",
    where: "sova",
    summary: "An organization's project only: a frozen spec is written only by the reconciler's promotion; an edit outside it is reported.",
    edit: '{setting: "project", frozen: true|false}',
    grant: "Unfrozen (frozen false after true): its claims may be written outside promotion again.",
    keys: { frozen: "true: only promotion writes the spec; false: not frozen" },
    changedAt: "the project page's Frozen switch",
  },
  "project.archive": {
    id: "project.archive",
    label: "Archived",
    where: "sova",
    summary: "Archiving puts the project away, nothing deleted. It is the operator's own: Archive Project… on the project page, with its own confirm. sova_settings refuses it; say why you'd archive and let the operator do it.",
    edit: "none: refused ({setting: \"project\", archived} is the operator's own, with its own confirm)",
    grant: null,
    keys: { archived: "refused here: Archive Project… on the project page keeps its own confirm" },
    changedAt: "the project page's Danger zone (Archive Project…)",
  },
  copies: {
    id: "copies",
    label: "Copy limit",
    where: "sova",
    summary: "How many of the project's copies may run at once on this machine (only running copies count; the main checkout's and conformance's never do). Kept by Sova for this machine; until it is set, the project's file's value applies. Lowering it stops nothing: new starts wait until fewer run.",
    edit: '{setting: "copies", limit: <1–16> | null}',
    grant: "Raised (a reset to the file's value counts when that is higher).",
    keys: copiesKeys,
    changedAt: "the Branches tab (Change)",
  },
  services: {
    id: "services",
    label: "Services",
    where: "file",
    file: CONTRACT_FILE,
    summary: "The project's software: its services, running copies, tests, sharing and deploy (the services contract).",
    edit: '{setting: "services", file: {…the whole .sova/project.json…} | null}',
    grant: "Any change: it decides what runs on this computer.",
    keys: { ...serviceTop, ...serviceKeys },
    changedAt: "the Branches tab and the Software card",
  },
  profile: {
    id: "profile",
    label: "Session profiles",
    where: "file",
    file: ".sova/profiles/<id>.json",
    summary: "A session profile of the project's: what its sessions can't do, what they may also do, and how they start.",
    edit: '{setting: "profile", id: "<id>", profile: {…the whole file…} | null}',
    grant: "A profile that grants a session power (grant) or that the Overseer may start (overseerMayStart): its approval.",
    keys: {
      id: "its id (the file's name)",
      label: "its name (up to 60 characters)",
      icon: "an icon name",
      description: "one line",
      remove: "capabilities its sessions lose (shell, edit, workers, web, worktrees, timers)",
      grant: "powers its sessions gain (sessions.read, sessions.message, sessions.all): needs approval",
      singleton: "One at a time",
      limits: "its sessions' message limits",
      mode: '"normal" or "delegate"',
      minorModes: "exactly these minor modes (align, spec, vis, codemode)",
      model: '"provider/model"',
      thinking: "a thinking level",
      subagents: 'a subagent profile id, or "off"',
      firstMessage: "the first message its sessions start with",
      overseerMayStart: "the Overseer may start sessions with it: needs approval",
      playbook: "retired: read and ignored",
      ...profileLimitKeys,
    },
    changedAt: "Settings → Profiles (Approve)",
  },
  playbook: {
    id: "playbook",
    label: "Playbooks",
    where: "file",
    file: ".sova/playbooks/<id>/PLAYBOOK.md",
    summary: "A playbook of the project's: frontmatter lines, then its instructions.",
    edit: '{setting: "playbook", id: "<id>", text: "---\\ntitle: …\\n---\\n…" | null}',
    grant: "Only its schedule lines (see schedule).",
    keys: {
      title: "its title",
      name: "a skill's name (title wins)",
      description: "one line",
      promptHint: "the composer's hint",
      proposes: '"definition" or "deploy": what its runs propose',
    },
    changedAt: "the Playbooks dialog",
  },
  schedule: {
    id: "schedule",
    label: "Schedules",
    where: "file",
    file: ".sova/playbooks/<id>/PLAYBOOK.md",
    summary: "A playbook's schedule: its when:, tz:, profile: and task: lines.",
    edit: '{setting: "playbook", id: "<id>", text: …} with the schedule lines in its frontmatter',
    grant: "A change to when:, tz: or profile: (the schedule's pin): its approval.",
    keys: {
      when: 'when it runs ("weekdays 09:00", "every 2h", "claude-limit-reset", "merge-ready")',
      tz: "an IANA time zone",
      profile: "the profile its runs use (required)",
      task: "the first message of each run",
    },
    changedAt: "the Playbooks dialog (Approve)",
  },
  mode: {
    id: "mode",
    label: "Project modes",
    where: "file",
    file: ".sova/minor-modes/<id>/MODE.md",
    summary: "A minor mode of the project's: its instructions, and the tools, commands and hooks it adds.",
    edit: '{setting: "mode", id: "<id>", text: "---\\ndescription: …\\n---\\n…" | null}',
    grant: "A mode with tools, commands or hooks: its version's approval (yours, so its hooks run too).",
    keys: {
      description: "one line for the mode menu",
      workers: "which workers get it",
      tools: "tools it adds (JSON): each a program of the mode's folder",
      commands: "commands it adds (JSON)",
      hooks: "programs that run after turn.started or turn.ended (JSON)",
    },
    changedAt: "a chat's mode menu (Approve)",
  },
  offers: {
    id: "offers",
    label: "Offers",
    where: "file",
    file: OFFERS_FILE,
    summary: "Button cards the project's chats may show.",
    edit: '{setting: "offers", file: {version: 1, offers: {…}} | null}',
    grant: "An offers file with run buttons: its run buttons' approval.",
    keys: {
      version: "1",
      offers: "the offers by name (at most 8)",
      "offers.<name>.when": "when to show it",
      "offers.<name>.why": "why",
      "offers.<name>.title": "its title",
      "offers.<name>.onlyIf": "conditions",
      "offers.<name>.repeat": "how often",
      "offers.<name>.shownBy": "who shows it",
      "offers.<name>.disabled": "off",
      "offers.<name>.buttons": "at most 4 buttons",
      "buttons[].label": "the button's label",
      "buttons[].about": "one line under it",
      "buttons[].send": "a message it sends",
      "buttons[].run": "a command it runs (needs approval)",
      "buttons[].to": "where a send goes",
      "buttons[].onlyIf": "conditions for this button alone",
      "buttons[].confirm": "a question the card asks before the click counts",
      "buttons[].landing": "what the click records: go-ahead, go-ahead-without-specs or not-yet",
    },
    changedAt: "Settings → Offers (Approve Run Buttons)",
  },
};

export const SETTING_IDS = Object.keys(SETTINGS_REFERENCE) as SettingId[];

/** Only an organization's project has these (a standalone project's index leaves them out). */
const PLACED_ONLY: readonly SettingId[] = ["overseer.abilities", "project.stakeholder", "project.ownerHidden", "project.frozen"];

/** The prompt's short index: one line per setting (`placed`: an organization places the project). */
export function settingsIndex(placed = true): string {
  return SETTING_IDS.filter((id) => placed || !PLACED_ONLY.includes(id)).map((id) => {
    const e = SETTINGS_REFERENCE[id];
    return `- ${id}: ${e.label} (${e.where === "sova" ? "Sova-kept" : e.file}).${e.grant ? " Grant: " + e.grant : ""}`;
  }).join("\n");
}

/** One entry in full, for sova_settings reference. */
export function referenceText(id: SettingId): string {
  const e = SETTINGS_REFERENCE[id];
  return [
    `${e.label} (${id}): ${e.summary}`,
    `Where: ${e.where === "sova" ? "kept by Sova" : `the file ${e.file} (lands as a commit when the operator applies the card)`}. Changed at: ${e.changedAt}.`,
    `Propose: ${e.edit}`,
    `Needs the operator's approval: ${e.grant ?? "never"}`,
    "Keys:",
    ...Object.entries(e.keys).map(([k, v]) => `- ${k}: ${v}`),
  ].join("\n");
}

export const isSettingId = (v: unknown): v is SettingId => typeof v === "string" && v in SETTINGS_REFERENCE;
