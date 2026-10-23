import type { SettingsBy, SettingsCardView, SettingsHistoryRow, SettingsToolDetails } from "../shared/project-settings";
import { isSettingId, referenceText, SETTING_IDS } from "../shared/settings-reference";
import { proposeSettings, settingsInfo, SettingsRefusal, withdrawCard } from "./project-settings";

/**
 * sova_settings, the project overseer's one settings tool (§app.project-overseer/settings): get, reference,
 * propose, withdraw. Always allowed (like sova_card): a propose in a run the operator did not start only
 * prepares a card; in their turn what narrows applies at once. Only the project overseer has it.
 */

export const SETTINGS_TOOL_DESCRIPTION =
  "The project's settings, every one of them: yours (Watch, the powers in both columns, models, extra instructions, limits and pace, the hold, abilities, memory), the project's name, in an organization's project its main stakeholder, whether the owner's page shows it and whether its spec is frozen, and the project's files (services .sova/project.json, profiles, playbooks and their schedules, project modes, offers). " +
  "get: every setting with its state, the cards waiting and the folder's uncommitted settings edits. reference {setting}: one setting's keys, what each means and what needs the operator's approval. " +
  "propose {why, edits}: change settings; each edit names a setting, never a path: {setting: \"overseer\", patch: {…}}, {setting: \"memory\", on}, {setting: \"project\", name?, stakeholder?, ownerHidden?, frozen?}, {setting: \"profile\", id, profile | null}, {setting: \"playbook\", id, text | null}, {setting: \"mode\", id, text | null}, {setting: \"offers\", file | null}, {setting: \"services\", file | null} (whole files; null removes). " +
  "In a turn the operator started, a change that narrows what you may do (a power Off, a limit lowered, a model, the spec frozen, the project hidden from the owner's page, the main stakeholder) applies at once, with Undo. Everything that widens (a grant) and every file change goes on a Settings change card the operator applies with one click (Apply and Approve); you never approve a grant. In a run the operator did not start, propose only prepares the card. Archiving is the operator's own, with its own confirm on the project page. withdraw {card}: drop a card of yours (sc_…).";

export const SETTINGS_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["get", "reference", "propose", "withdraw"], description: "get | reference | propose | withdraw" },
    setting: { type: "string", enum: SETTING_IDS, description: "reference: the setting (from the index in your prompt)." },
    why: { type: "string", description: "propose: one or two sentences for the operator, shown on the card." },
    edits: {
      type: "array",
      description: "propose: the changes, each an object naming its setting (see the description).",
      items: { type: "object", properties: { setting: { type: "string", enum: ["overseer", "memory", "project", "profile", "playbook", "mode", "offers", "services"] } }, required: ["setting"] },
    },
    card: { type: "string", description: "withdraw: the card's id (sc_…)." },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

type Out = { content: { type: "text"; text: string }[]; details: unknown };
const text = (t: string) => [{ type: "text" as const, text: t }];

function cardWords(c: SettingsCardView): string {
  const lines = [
    `${c.id} "${c.title}" · ${c.state}${c.grants.length ? ` · needs the operator's approval (${c.grants.length} grant${c.grants.length === 1 ? "" : "s"})` : ""}`,
    ...c.kept.map((k) => `  - ${k.label}: ${k.fromText} → ${k.toText}${k.grant ? ` (grant: ${k.grant})` : ""}`),
    ...c.files.map((f) => `  - ${f.summary}`),
    ...c.grants.filter((g) => !c.kept.some((k) => k.grant === g.what)).map((g) => `  - grant: ${g.what}`),
  ];
  return lines.join("\n");
}

const rowWords = (r: SettingsHistoryRow) => `${r.id} ${r.field}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`;

export async function runSettingsTool(projectId: string, q: Record<string, unknown>, attended: boolean): Promise<Out> {
  const op = q.op;
  if (op === "get") {
    const info = await settingsInfo(projectId);
    const rows = info.rows.map((r) => `- ${r.setting}${r.name ? ` ${r.name}` : ""}: ${r.state}${r.detail ? ` (${r.detail})` : ""} · changed at ${r.hrefLabel}`);
    const parts = [`Settings (${info.git ? "the project folder is in Git" : "the project folder is not in Git: its files change by hand"}):`, ...rows];
    if (info.cards.length) parts.push("", "Cards waiting for the operator:", ...info.cards.map(cardWords));
    if (info.local) parts.push("", "Uncommitted settings edits in the project folder (one card, local: the operator lands or discards them):", cardWords(info.local));
    return { content: text(parts.join("\n")), details: { rows: info.rows.length, cards: info.cards.map((c) => c.id), local: !!info.local } };
  }
  if (op === "reference") {
    if (!isSettingId(q.setting)) throw new SettingsRefusal(`Name a setting: ${SETTING_IDS.join(", ")}.`);
    return { content: text(referenceText(q.setting)), details: { setting: q.setting } };
  }
  if (op === "propose") {
    const by: SettingsBy = { kind: "project-overseer", via: "tool" };
    const r = await proposeSettings(projectId, { edits: q.edits, why: q.why }, { attended, by });
    const said: string[] = [];
    if (r.appliedNow.length) said.push(`Applied now (each has Undo on the card and in the Settings history):\n${r.appliedNow.map((x) => `  - ${rowWords(x)}`).join("\n")}`);
    if (r.card)
      said.push(
        `Card ${r.card.id} waits for the operator${r.card.grants.length ? "'s Apply and Approve" : "'s Apply"}; nothing in it applies until they click. Tell them in a sentence what it changes and why; never claim it is applied.\n${cardWords(r.card)}`,
      );
    if (!attended && r.card) said.push("This run wasn't started by the operator, so nothing applied: the card waits.");
    if (!said.length) said.push("Nothing changed: every edit is already as asked.");
    const details: SettingsToolDetails = { kind: "settings-card", projectId, card: r.card, appliedNow: r.appliedNow };
    return { content: text(said.join("\n\n")), details };
  }
  if (op === "withdraw") {
    if (typeof q.card !== "string" || !/^sc_\d+$/.test(q.card)) throw new SettingsRefusal("Name the card to withdraw (sc_…). The folder's uncommitted edits are the operator's to land or discard.");
    await withdrawCard(projectId, q.card, { operator: false });
    return { content: text(`Withdrew ${q.card}.`), details: { card: q.card } };
  }
  throw new SettingsRefusal("op is get, reference, propose or withdraw.");
}
