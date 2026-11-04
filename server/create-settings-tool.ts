import type { ToolSpec } from "../shared/harness";
import { CLAUDE_LOGIN_SETTING, SETTING_IDS } from "../shared/settings-reference";
import { SOVA_SETTING_IDS } from "../shared/sova-settings-reference";

/**
 * `sova_settings` in an ordinary chat: declared for every chat so the tool list is the same across a mode switch,
 * active only while the chat is in Create (§chat.create-mode/settings-cards). The server checks the mode on every
 * call, so a chat that isn't in Create can't reach it by name. A worker never gets it (servedWorkerTools).
 */

export const CREATE_SETTINGS_TOOL = "sova_settings";

export const CREATE_SETTINGS_TOOL_DESCRIPTION =
  "Every setting Sova has: this project's, its merge queue's and the Sova-wide ones. You only prepare a card; the person applies it with a click on Sova's own page, and you can neither apply nor undo one. Even a change that narrows waits for them. " +
  "get: every setting with its state, the cards waiting. reference {setting}: one setting's keys and what needs the person's approval. " +
  'propose {why, edits}: prepare a card. A project edit is as the reference says; a merge queue edit is {setting: "merge-queue", changes?, models?}, on a card of its own; which existing Claude login a project uses is {setting: "claude-login", login}; a Sova-wide edit is {setting: "sova", id, value}, on a card of its own. ' +
  "withdraw {card}: drop a card you prepared (sc_… or sw_…). Keys, tokens and sign-ins never go on a card: a card that carries one is refused, and the person signs in the supported way.";

export const CREATE_SETTINGS_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["get", "reference", "propose", "withdraw"], description: "get | reference | propose | withdraw" },
    setting: { type: "string", enum: [...SETTING_IDS, CLAUDE_LOGIN_SETTING, ...SOVA_SETTING_IDS], description: "reference: the setting." },
    why: { type: "string", description: "propose: one or two sentences for the person, shown on the card." },
    edits: {
      type: "array",
      description: "propose: the changes, each an object naming its setting (see the description).",
      items: { type: "object", properties: { setting: { type: "string", enum: ["overseer", "memory", "project", "copies", "profile", "playbook", "mode", "offers", "services", "merge-queue", "claude-login", "sova"] } }, required: ["setting"] },
    },
    card: { type: "string", description: "withdraw: the card's id (sc_… or sw_…)." },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

export interface CreateSettingsHost {
  sessionId: string;
  /** The chat's major mode now, or undefined when it isn't open here. */
  mode(): string | undefined;
  cwd(): string;
}

/** The server's run of a call (server/create-settings-run.ts): set at start, so this module stays a declaration. */
type CreateSettingsRun = (host: CreateSettingsHost, params: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
let run: CreateSettingsRun | null = null;
export const setCreateSettingsRun = (r: CreateSettingsRun | null): void => void (run = r);

export function createSettingsTool(host: CreateSettingsHost): ToolSpec {
  return {
    name: CREATE_SETTINGS_TOOL,
    label: "Settings",
    description: CREATE_SETTINGS_TOOL_DESCRIPTION,
    promptSnippet: "every setting: get, reference, propose a card the person applies, withdraw",
    parameters: CREATE_SETTINGS_TOOL_PARAMETERS as never,
    async execute(_id, params) {
      if (host.mode() !== "create") throw new Error("sova_settings is Create's: this chat isn't in Create.");
      if (!run) throw new Error("This server runs no settings cards.");
      return run(host, params as Record<string, unknown>);
    },
  };
}
