import type { ClaudeLoginOption } from "../../shared/projects";

/**
 * What a Claude login card (§app.claude-logins/project-login) offers: on a project, "Same as organization"
 * while placed, then "No preference", then each login of the host that holds it; on an organization, the same
 * without the first. Pure: the card draws these.
 */
export interface CardChoice {
  value: string;
  label: string;
}

const nameOf = (options: readonly ClaudeLoginOption[], id: string | null | undefined): string | null => (id ? (options.find((o) => o.id === id)?.name ?? id) : null);

export function cardChoices(input: { kind: "project" | "org"; placed?: boolean; orgLogin?: string | null; setting: string; options: readonly ClaudeLoginOption[] }): CardChoice[] {
  const out: CardChoice[] = [];
  if (input.kind === "project" && input.placed) {
    const org = nameOf(input.options, input.orgLogin);
    out.push({ value: "org", label: org ? `Same as organization (${org})` : "Same as organization (no preference)" });
  }
  out.push({ value: "none", label: "No preference (this computer's order)" });
  for (const o of input.options) out.push({ value: o.id, label: o.name });
  // A saved login this host no longer lists stays visible, so the select never shows something else.
  if (!out.some((c) => c.value === input.setting)) out.push({ value: input.setting, label: `${input.setting} (not on this computer)` });
  return out;
}

/** The toast after a save: what new chats now start on. */
export function savedText(kind: "project" | "org", choice: string, options: readonly ClaudeLoginOption[]): string {
  const who = kind === "project" ? "this project" : "this organization's projects";
  if (choice === "none") return `New chats in ${who} follow this computer's order.`;
  if (choice === "org") return "New chats in this project follow its organization.";
  return `New chats in ${who} start on ${nameOf(options, choice)}.`;
}
