import type { ToolSpec } from "../shared/harness";
import { SETTING_IDS } from "../shared/settings-reference";
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
  'propose {why, edits}: prepare a card. A project edit is as the reference says; a merge queue edit is {setting: "merge-queue", changes?, models?}, on a card of its own; a Sova-wide edit is {setting: "sova", id, value}, on a card of its own. ' +
  "withdraw {card}: drop a card you prepared (sc_… or sw_…). Keys, tokens and sign-ins never go on a card: a card that carries one is refused, and the person signs in the supported way.";

export const CREATE_SETTINGS_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["get", "reference", "propose", "withdraw"], description: "get | reference | propose | withdraw" },
    setting: { type: "string", enum: [...SETTING_IDS, ...SOVA_SETTING_IDS], description: "reference: the setting." },
    why: { type: "string", description: "propose: one or two sentences for the person, shown on the card." },
    edits: {
      type: "array",
      description: "propose: the changes, each an object naming its setting (see the description).",
      items: { type: "object", properties: { setting: { type: "string", enum: ["overseer", "memory", "project", "copies", "profile", "playbook", "mode", "offers", "services", "merge-queue", "sova"] } }, required: ["setting"] },
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

/** The project of a chat's folder, or the sentence that says why a project card can't be made here. */
async function chatProject(cwd: string): Promise<{ projectId: string | null; noProject: string | null }> {
  const { parseTargetCwd } = await import("./targets");
  if (parseTargetCwd(cwd)) return { projectId: null, noProject: "A chat on a remote machine can't prepare a project's card: open this project's chat on its own computer." };
  const [{ listProjects }, { folderMatcher }, { agentRoot }] = await Promise.all([import("./projects/spaces"), import("./project-folder"), import("./state-root")]);
  const projects = listProjects().filter((p) => !p.archived);
  const projectId = cwd ? folderMatcher(projects, agentRoot())(cwd) : null;
  return { projectId, noProject: projectId ? null : "This folder isn't a project yet: Add as Project first, then its settings can go on a card." };
}

export function createSettingsTool(host: CreateSettingsHost): ToolSpec {
  return {
    name: CREATE_SETTINGS_TOOL,
    label: "Settings",
    description: CREATE_SETTINGS_TOOL_DESCRIPTION,
    promptSnippet: "every setting: get, reference, propose a card the person applies, withdraw",
    parameters: CREATE_SETTINGS_TOOL_PARAMETERS as never,
    async execute(_id, params) {
      if (host.mode() !== "create") throw new Error("sova_settings is Create's: this chat isn't in Create.");
      const { runCreateSettingsTool } = await import("./project-settings-tool");
      const { OrgError } = await import("./org-error");
      const { SettingsRefusal } = await import("./project-settings");
      const { SovaSettingsRefusal } = await import("./sova-settings");
      try {
        return await runCreateSettingsTool({ sessionId: host.sessionId, ...(await chatProject(host.cwd())) }, params as Record<string, unknown>);
      } catch (err) {
        if (err instanceof SettingsRefusal || err instanceof SovaSettingsRefusal || err instanceof OrgError) throw new Error(err.message);
        throw err;
      }
    },
  };
}
