/**
 * The Sova-wide settings a Create chat's card can hold (§chat.create-mode/settings-cards): every setting Sova keeps
 * for itself or for this computer, with its own reader and the writer its screen uses, or the file's own parser when
 * it has no screen. `sova_settings reference {setting}` gives one entry; server/sova-settings.ts holds the readers and
 * writers, and a test fails when an entry has none, or when `sync` isn't a document sync carries.
 * Pure, imported by the server and the web app. Credentials are not settings here: no entry holds one.
 */

export const SOVA_SETTING_IDS = [
  "models.policy",
  "models.limits",
  "models.default",
  "models.providers",
  "models.image-fallback",
  "models.pi-defaults",
  "remote.targets",
  "sandbox.policy",
  "workers.priority",
  "workers.profiles",
  "workers.default-profile",
  "alignment.style",
  "alignment.review",
  "memory",
  "summaries.model",
  "summaries.limits",
  "summaries.titles",
  "decisions",
  "overseer.global",
  "assistant.default",
  "notifications",
  "outreach",
  "modes.default",
  "models.favorites",
] as const;

export type SovaSettingId = (typeof SOVA_SETTING_IDS)[number];

export interface SovaSettingEntry {
  id: SovaSettingId;
  label: string;
  /** Where it is kept, relative to the agent dir (`~a`) or Sova's state dir (`~s`). */
  file: string;
  summary: string;
  /** What `value` holds in `{setting: "sova", id, value}`. */
  value: string;
  /** What makes a change of it a grant, or null: never one. */
  grant: string | null;
  /** The sync document that carries it to other computers, or null: it stays on this one. */
  sync: string | null;
  /** When a change shows, in an entry's words. */
  live: string;
  /** Where the person changes it by hand, or null: no screen has it. */
  screen: string | null;
}

const e = (entry: SovaSettingEntry): SovaSettingEntry => entry;

export const SOVA_SETTINGS: Record<SovaSettingId, SovaSettingEntry> = {
  "models.policy": e({ id: "models.policy", label: "Models turned off", file: "~a/model-policy.json", summary: "Which models and providers may be used at all, and which workers may be given.", value: "{disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: []}, each provider a name and each model \"provider/modelId\"", grant: "Models turned back on.", sync: "settings:model-policy.json", live: "next turn or spawn", screen: "Settings → Models" }),
  "models.limits": e({ id: "models.limits", label: "Requests at once", file: "~a/provider-limits.json", summary: "How many of each provider's requests may run at once on each device.", value: "{limits: {<provider>: <whole number>}}", grant: null, sync: "settings:provider-limits.json", live: "next request", screen: "Settings → Models (At once)" }),
  "models.default": e({ id: "models.default", label: "What new chats start on", file: "~s/defaults.json", summary: "The model and thinking level of a new chat.", value: "{model?: \"provider/model\", thinking?: level}", grant: null, sync: "settings:sova/defaults.json", live: "next new chat", screen: "the model menu of a chat with no messages yet" }),
  "models.providers": e({ id: "models.providers", label: "Custom providers", file: "~a/models.json", summary: "Extra endpoints and models. A key is never set here: name its environment variable as $NAME (a bare name is read as the key itself), and the person sets it the supported way.", value: "the whole file: {providers: {<name>: {baseUrl, api, apiKey: \"$ENV_VAR_NAME\", models: [...]}}}", grant: "It sends chats to that endpoint.", sync: null, live: "after Sova restarts", screen: null }),
  "models.image-fallback": e({ id: "models.image-fallback", label: "Image fallback", file: "~a/vision-delegate.json", summary: "Which models look at images for a model that can't.", value: "{fallbacks: [\"provider/modelId\", …], exhaustedAbovePct: 1–100, contextChars: <whole number>}", grant: null, sync: null, live: "a new chat", screen: null }),
  "models.pi-defaults": e({ id: "models.pi-defaults", label: "pi's defaults", file: "~a/settings.json", summary: "pi's own default provider, model and thinking level. Packages and add-ons in that file stay out of a card.", value: "{defaultProvider?, defaultModel?, defaultThinkingLevel?}", grant: null, sync: null, live: "a new chat", screen: null }),
  "remote.targets": e({ id: "remote.targets", label: "Remote targets", file: "~a/targets.json", summary: "The machines chats can run on over SSH, SSM, Docker or Incus.", value: "the whole list: [{name, kind, …}]", grant: "Chats can run on that machine.", sync: null, live: "a new chat", screen: null }),
  "sandbox.policy": e({ id: "sandbox.policy", label: "Sandbox policy", file: "~a/sandbox-policy/<platform>/policy.json", summary: "What a sandboxed chat may read, write and reach on this computer.", value: "the whole file", grant: "It changes what every sandboxed chat may touch.", sync: null, live: "next tool call of every chat", screen: null }),
  "workers.priority": e({ id: "workers.priority", label: "Worker priority", file: "~s/settings.json (workerNice)", summary: "How far workers are lowered so they don't starve the machine: 0 is not at all, 19 the lowest. SOVA_WORKER_NICE wins when it is set.", value: "a whole number, 0–19", grant: null, sync: "settings:sova/settings.json", live: "next worker", screen: null }),
  "workers.profiles": e({ id: "workers.profiles", label: "Subagent profiles", file: "~a/subagent-profiles.json", summary: "The named sets of worker models, and their routing, team and reviewer sections.", value: "the whole library, as settings.subagents.get shows it", grant: null, sync: "settings:subagent-profiles.json", live: "each chat on that profile, from its next turn", screen: "Settings → Subagents" }),
  "workers.default-profile": e({ id: "workers.default-profile", label: "Default subagent profile", file: "~a/subagent-profiles-default.json", summary: "Which subagent profile new chats on this device start with.", value: "a profile's id", grant: null, sync: null, live: "next new chat", screen: "Settings → Subagents (Make Default)" }),
  "alignment.style": e({ id: "alignment.style", label: "Alignment", file: "~a/mode-align.json", summary: "How readily align plans, in what voice, and whether it draws.", value: "{version: 1, style, visuals, eagerness?}", grant: null, sync: "settings:mode-align.json", live: "open chats' next message; Visuals in chats started after", screen: "Settings → Alignment" }),
  "alignment.review": e({ id: "alignment.review", label: "Adversarial review", file: "~s/settings.json (alignment.review)", summary: "A read-only reviewer on risky plans.", value: "true or false", grant: null, sync: "settings:sova/settings.json", live: "chats started after", screen: "Settings → Alignment" }),
  memory: e({ id: "memory", label: "Memory", file: "~a/mode-memory.json", summary: "Which small model summarizes, and how much summary a chat keeps.", value: "{version: 1, summarizer, sizes?, default?}", grant: null, sync: null, live: "next summary", screen: "Settings → Memory" }),
  "summaries.model": e({ id: "summaries.model", label: "Summary line's model", file: "~a/topic-outline.json", summary: "Which model writes the sidebar summary, and its fallback.", value: "{primary: {backend, model}, fallback: {backend, model} | null}", grant: null, sync: null, live: "chats started after", screen: "Settings → Summaries" }),
  "summaries.limits": e({ id: "summaries.limits", label: "Summary time and budget limits", file: "~a/topic-outline.json", summary: "Each summarizer's timeout and spending limit, in the order of the chain.", value: "[{timeoutMs?, maxBudgetUsd?}, …], one per summarizer", grant: null, sync: null, live: "chats started after", screen: null }),
  "summaries.titles": e({ id: "summaries.titles", label: "Session titles", file: "~s/session-titles-settings.json", summary: "Whether Sova names sessions, how often, and with which model.", value: "{version: 1, enabled, intervalMinutes, quietMinutes, primary, fallback}", grant: null, sync: null, live: "the sweep's next run", screen: "Settings → Summaries" }),
  decisions: e({ id: "decisions", label: "Decisions", file: "~s/decisions.json", summary: "The opt-in classifier that flags sessions needing you. Its key is never on a card: it stays on Settings → Decisions.", value: "{version: 1, jev, fallback, features, exclusions, neverSendTui}", grant: "It sends session content to a provider.", sync: null, live: "next check", screen: "Settings → Decisions" }),
  "overseer.global": e({ id: "overseer.global", label: "The Overseer", file: "~s/overseer.json", summary: "The Overseer's model, extra instructions, proactivity, quick actions, limits and explorer.", value: "{version: 1, model, thinking, extraSystemPrompt, proactivity, quickActions, caps, explorer}", grant: "It changes what the Overseer is told and may do.", sync: null, live: "its next turn", screen: "Settings → Overseer" }),
  "assistant.default": e({ id: "assistant.default", label: "The Project Assistant's default model", file: "~s/baton-settings.json", summary: "The model every organization's Project Assistant uses unless it picks its own.", value: "{model: \"provider/model\", thinking?} or null", grant: null, sync: null, live: "its next session", screen: "Settings" }),
  notifications: e({ id: "notifications", label: "Phone notifications", file: "~s/push.json", summary: "Whether Sova notifies at all, its contact address, one switch per kind, and quiet hours. Each device still turns them on in its own browser.", value: "{enabled, contact, kinds: {<kind>: true|false}, quietHours}, as Settings → Notifications shows it", grant: null, sync: null, live: "next notification", screen: "Settings → Notifications" }),
  outreach: e({ id: "outreach", label: "Outreach", file: "~s/outreach.json", summary: "Which number sends, the numbers and their labels, which computers may send through it, and whether it is paused. Pairing a phone stays on the screen.", value: "{sender, acceptFrom, paused, numbers?, labels?, authDir?}", grant: "It changes which number sends, or who may send through it.", sync: null, live: "next send", screen: "Settings → Outreach" }),
  "modes.default": e({ id: "modes.default", label: "What new chats start in", file: "~a/mode.json", summary: "The mode, strict flag and minor modes new chats start with. Normal or Delegate: Create is chosen in each chat, so no default holds it.", value: "{mode: \"normal\"|\"delegate\", strict, minorModes: [...]}, all three", grant: null, sync: "settings:mode.json", live: "next new chat", screen: "a chat's mode menu (Save as Default)" }),
  "models.favorites": e({ id: "models.favorites", label: "Favourite models", file: "~a/model-favorites.json", summary: "The starred models every picker shows first.", value: "the whole list: [\"provider/id\", …]", grant: null, sync: "settings:model-favorites.json", live: "at once", screen: "the star in the model picker" }),
};

/**
 * What stays on its own screen (§chat.create-mode/settings-cards): the words a card that names one is refused with,
 * so a chat is never at a dead end. An edit may name one as its `setting`, or as a Sova-wide `id`.
 */
export const SCREEN_ONLY_SETTINGS: Record<string, string> = {
  "public-links": "Public links stay on their own screen, so no card holds them. Name it for the person: Settings → Public Links, Where links open.",
  voice: "Voice stays on its own screen, so no card holds it. Name it for the person: Settings → Voice, Set Up Voice.",
  updates: "Updates stay on their own screen, so no card holds them. Name it for the person: Settings → General, Update from.",
  mesh: "Mesh stays on its own screen, so no card holds it yet. Name it for the person: Settings → Mesh.",
};

export const isSovaSettingId = (v: unknown): v is SovaSettingId => typeof v === "string" && (SOVA_SETTING_IDS as readonly string[]).includes(v);

/** The short index `get` carries: one line per setting. */
export const sovaSettingsIndex = (): string =>
  SOVA_SETTING_IDS.map((id) => {
    const s = SOVA_SETTINGS[id];
    return `- ${id}: ${s.label}.${s.grant ? ` Grant: ${s.grant}` : ""}${s.sync ? " Spreads by sync." : ""}`;
  }).join("\n");

/** One entry in full, for `sova_settings reference`. */
export function sovaReferenceText(id: SovaSettingId): string {
  const s = SOVA_SETTINGS[id];
  return [
    `${s.label} (${id}): ${s.summary}`,
    `Where: ${s.file} (~a is this chat's own agent folder, ~s Sova's folder in it; a card names the setting, never a path). Changed at: ${s.screen ?? "no screen: only a card, or the file"}.`,
    `Propose: {setting: "sova", id: "${id}", value: ${s.value}}`,
    `Needs the person's approval: ${s.grant ?? "never"}`,
    `Shows: ${s.live}.`,
    `Spreads: ${s.sync ? "to the person's other computers, when sync is on" : "no, it stays on this computer"}.`,
  ].join("\n");
}
