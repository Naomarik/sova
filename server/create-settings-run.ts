import type { SettingsBy, SettingsToolDetails } from "../shared/project-settings";
import { CLAUDE_LOGIN_REFERENCE, CLAUDE_LOGIN_SETTING, isSettingId, referenceText } from "../shared/settings-reference";
import { isSovaSettingId, SCREEN_ONLY_SETTINGS, sovaReferenceText, sovaSettingsIndex } from "../shared/sova-settings-reference";
import type { MeshCardState } from "../shared/mesh-access";
import type { CreateSettingsHost } from "./create-settings-tool";
import { meshCardState } from "./mesh";
import { queueCardPort } from "./merge-queue/card-port";
import { OrgError } from "./org-error";
import { folderMatcher } from "./project-folder";
import { proposeSettings, SettingsRefusal, withdrawCard } from "./project-settings";
import { cardWords, runSettingsTool } from "./project-settings-tool";
import { listProjects } from "./projects/spaces";
import { proposeSova, sovaCardsInfo, SovaSettingsRefusal, withdrawSovaCard } from "./sova-settings";
import { agentRoot } from "./state-root";
import { parseTargetCwd } from "./targets";

type Out = { content: { type: "text"; text: string }[]; details: unknown };
const text = (t: string) => [{ type: "text" as const, text: t }];

/** The mesh in words: each host's state and access; `sessions` said plainly, because it is shell-level. */
function meshWords(m: MeshCardState): string[] {
  if (!m.enabled) return [`Mesh: off. This computer (${m.self.label}) has no other computers linked.`];
  return [
    `Mesh: on. This computer: ${m.self.label} (${m.self.id}).`,
    ...m.peers.map((p) => `- ${p.label} (${p.id}): ${p.state}; ${p.preset ?? "default"} access${p.caps.includes("sessions") ? " (shell-level: it can run anything here)" : ""}; can ${p.caps.join(", ") || "nothing"}${p.pairing ? `; paired, this computer ${p.pairing.role === "dial" ? "dials it" : "is dialled"}${p.pairing.internet ? " over the internet" : ""}` : ""}`),
    `Sync: ${Object.entries(m.sync).map(([k, on]) => `${k} ${on ? "on" : "off"}`).join(", ")}.`,
    `Front door: ${m.frontDoor ?? "none"}.`,
    ...(m.relay ? [`This computer is a relay at ${m.relay.host}:${m.relay.port} (${m.relay.exposure}), ${m.relay.listening ? "listening" : "not listening"}.`] : []),
  ];
}

/** What a Create chat reads in a project in Git with no merge queue. */
export const NO_QUEUE = "This project has no merge queue, so it has no Land. Tell the person now, in this reply, and offer Initialize on the project page's Merge Queue tab.";

/** The chat a Create card is prepared from. */
export interface CreateChat {
  sessionId: string;
  /** The project the chat's folder belongs to, or null. */
  projectId: string | null;
  /** Why this folder takes no project card, or null (it has a project). */
  noProject: string | null;
}

const isSovaEdit = (e: unknown): boolean => !!e && typeof e === "object" && (e as { setting?: unknown }).setting === "sova";

/** sova_settings in a Create chat: everything only prepares (`attended: false`), so nothing applies until the page does. */
export async function runCreateSettingsTool(chat: CreateChat, q: Record<string, unknown>): Promise<Out> {
  const op = q.op;
  const by: SettingsBy = { kind: "create", via: "tool", chat: chat.sessionId };
  if (op === "get") {
    const waiting = sovaCardsInfo().cards;
    const parts = [`Sova-wide settings (each changes by a card, {setting: "sova", id, value}):`, sovaSettingsIndex(), "", "On their own screens, no card:", ...Object.values(SCREEN_ONLY_SETTINGS).map((w) => `- ${w}`)];
    if (waiting.length) parts.push("", "Sova-wide cards waiting for the person:", ...waiting.map(cardWords));
    parts.push("", ...meshWords(await meshCardState()));
    if (chat.projectId) {
      const got = (await runSettingsTool(chat.projectId, { op: "get" }, false)).content[0]!.text;
      parts.push("", got);
      // Said where the chat learns it: the block alone left Initialize unoffered (§chat.create-mode/where-offered).
      const port = queueCardPort();
      if (port && got.includes("is in Git") && !(await port.settings(chat.projectId))) parts.push("", NO_QUEUE);
    }
    else parts.push("", chat.noProject ?? "");
    return { content: text(parts.join("\n")), details: { project: chat.projectId, cards: waiting.map((c) => c.id) } };
  }
  if (op === "reference") {
    if (typeof q.setting === "string" && SCREEN_ONLY_SETTINGS[q.setting]) return { content: text(SCREEN_ONLY_SETTINGS[q.setting]!), details: { setting: q.setting } };
    if (q.setting === CLAUDE_LOGIN_SETTING) return { content: text(CLAUDE_LOGIN_REFERENCE), details: { setting: q.setting } };
    if (isSovaSettingId(q.setting)) return { content: text(sovaReferenceText(q.setting)), details: { setting: q.setting } };
    if (isSettingId(q.setting)) return { content: text(referenceText(q.setting, { create: true })), details: { setting: q.setting } };
    throw new SettingsRefusal("Name a setting: sova_settings get lists them.");
  }
  if (op === "propose") {
    const edits = q.edits;
    if (!Array.isArray(edits) || edits.length === 0) throw new SettingsRefusal("edits must list at least one change.");
    for (const e of edits as { setting?: unknown; id?: unknown }[]) {
      const said = SCREEN_ONLY_SETTINGS[String(e?.setting)] ?? (e?.setting === "sova" ? SCREEN_ONLY_SETTINGS[String(e.id)] : undefined);
      if (said) throw new SettingsRefusal(said);
    }
    const sova = edits.filter(isSovaEdit);
    if (sova.length && sova.length !== edits.length) throw new SettingsRefusal("A Sova-wide change goes on a card of its own: propose it apart from the project's.");
    const said = (id: string, grants: number, body: string) => `Card ${id} waits for the person${grants ? "'s Apply and Approve" : "'s Apply"}; nothing in it applies until they click, even what narrows. Tell them in a sentence what it changes and why; never claim it is applied.\n${body}`;
    if (sova.length) {
      const card = await proposeSova({ edits: sova, why: q.why }, by);
      const details: SettingsToolDetails = { kind: "settings-card", projectId: null, card, appliedNow: [], create: true };
      return { content: text(card ? said(card.id, card.grants.length, cardWords(card)) : "Nothing changed: every edit is already as asked."), details };
    }
    if (!chat.projectId) throw new SettingsRefusal(chat.noProject ?? "This chat's folder isn't a project.");
    const r = await proposeSettings(chat.projectId, { edits, why: q.why }, { attended: false, by });
    const details: SettingsToolDetails = { kind: "settings-card", projectId: chat.projectId, card: r.card, appliedNow: [], create: true };
    return { content: text(r.card ? said(r.card.id, r.card.grants.length, cardWords(r.card)) : "Nothing changed: every edit is already as asked."), details };
  }
  if (op === "withdraw") {
    if (typeof q.card === "string" && /^sw_\d+$/.test(q.card)) withdrawSovaCard(q.card, { chat: chat.sessionId });
    else if (typeof q.card === "string" && /^sc_\d+$/.test(q.card)) {
      if (!chat.projectId) throw new SettingsRefusal(chat.noProject ?? "This chat's folder isn't a project.");
      await withdrawCard(chat.projectId, q.card, { operator: false, chat: chat.sessionId });
    } else throw new SettingsRefusal("Name the card to withdraw (sc_… or sw_…).");
    return { content: text(`Withdrew ${q.card}.`), details: { card: q.card } };
  }
  throw new SettingsRefusal("op is get, reference, propose or withdraw.");
}

/** The project of a chat's folder, or the sentence that says why a project card can't be made here. */
function chatProject(cwd: string): { projectId: string | null; noProject: string | null } {
  if (parseTargetCwd(cwd)) return { projectId: null, noProject: "A chat on a remote machine can't prepare a project's card: open this project's chat on its own computer." };
  const projects = listProjects().filter((p) => !p.archived);
  const projectId = cwd ? folderMatcher(projects, agentRoot())(cwd) : null;
  return { projectId, noProject: projectId ? null : "This folder isn't a project yet: Add as Project first, then its settings can go on a card." };
}

/** One sova_settings call of a Create chat, in the server (set by server/app.ts): refusals in their own words. */
export async function runCreateSettings(host: CreateSettingsHost, params: Record<string, unknown>) {
  try {
    return await runCreateSettingsTool({ sessionId: host.sessionId, ...chatProject(host.cwd()) }, params);
  } catch (err) {
    if (err instanceof SettingsRefusal || err instanceof SovaSettingsRefusal || err instanceof OrgError) throw new Error(err.message);
    throw err;
  }
}
