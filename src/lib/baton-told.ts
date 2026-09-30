// Who started a gathering session, and what it is told (§app.baton/told): the strip's Started by line and
// the What It's Told document, composed as markdown for the markdown viewer. Pure, so every starter kind and
// every prompt state is pinned by tsx --test.

import type { BatonStarted, BatonStartedFor, BatonTold } from "../../shared/baton";
import { relativeTime, stampTime } from "./format";
import { projectOverseerHref } from "./orgs-route";
import { OVERSEER_HASH, overseerHistoryHref } from "./overseer";

/** Who, as the strip names them: "you", "the {project} overseer", "you, via the Overseer". */
export function starterName(s: Pick<BatonStarted, "who">, projectName: string): string {
  if (s.who === "project-overseer") return projectName ? `the ${projectName} overseer` : "the project's overseer";
  if (s.who === "overseer") return "you, via the Overseer";
  return "you";
}

/** Where the overseer part links: the project's overseer page, or the Overseer (its current conversation,
    else that one read-only from its History); null for the operator's own start, or an Overseer
    conversation not recorded. */
export function starterHref(s: Pick<BatonStarted, "who" | "overseer">, orgId: string, projectId: string): string | null {
  if (s.who === "project-overseer") return projectOverseerHref(orgId, projectId);
  if (s.who === "overseer" && s.overseer) return s.overseer.current ? OVERSEER_HASH : overseerHistoryHref(s.overseer.id);
  return null;
}

/** The strip's line: "Started by the Portal overseer · 5m ago". */
export const startedLine = (s: BatonStarted, projectName: string, now: number): string => `Started by ${starterName(s, projectName)} · ${relativeTime(s.at, now)}`;

/** The folded Why: the overseer's reason, or what is known when none was recorded. */
export function whyText(s: Pick<BatonStarted, "who" | "why">): string {
  const why = s.why?.trim();
  if (why) return why;
  return s.who === "operator" ? "Not recorded: you started it." : "Not recorded.";
}

/** A fence that no run of backticks inside `text` can close. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Text as a quote, its line breaks kept. */
const quoted = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((l) => `> ${l}  `)
    .join("\n");

/** The link text of a markdown link, with the characters that would end it escaped. */
const linkText = (t: string): string => t.replace(/[[\]\\]/g, (c) => `\\${c}`);

function startedForLine(f: BatonStartedFor): string {
  switch (f.kind) {
    case "gap":
      return `For the gap \`${f.id}\`${f.title ? `: ${linkText(f.title)}` : ""}.`;
    case "conflict":
      return `To settle a conflict about ${linkText(f.area)}.`;
    case "parent":
      return `From the session [${linkText(f.title || "it came from")}](sova://s/${f.sessionId}).`;
    case "todo":
      return `From the to-do: ${linkText(f.text)}.`;
    case "idea":
      return `From the idea: ${linkText(f.text)}.`;
  }
}

/** When, as the document says it: "Sep 30 1:43 PM (5m ago)". */
const when = (iso: string, now: number): string => `${stampTime(iso, now)} (${relativeTime(iso, now)})`;

/** What It's Told, as one markdown document (§app.baton/told). */
export function toldMarkdown(t: BatonTold, now: number): string {
  const who = starterName(t.started, t.projectName);
  const href = starterHref(t.started, t.orgId, t.projectId);
  const whoText = href ? `[${linkText(who)}](${href})` : who;
  const out: string[] = ["## Started by", "", `Started by ${whoText} · ${when(t.started.at, now)}.`];
  if (t.startedFor) out.push("", startedForLine(t.startedFor));
  out.push("", "## Why", "", t.started.why?.trim() ? quoted(t.started.why) : whyText(t.started));
  out.push("", "## Goal", "", t.goal.trim() ? quoted(t.goal) : "None.");
  out.push("", "## Prompt", "");
  if (t.prompt.kind === "recorded") out.push(`Last changed ${when(t.prompt.at, now)}, sent with every reply since.`);
  else out.push("**Not sent yet: what the next reply would get.**");
  out.push("", fenced(t.prompt.text, "text"));
  if (t.wrapup) out.push("", "## Wrap-up prompt", "", `Sent ${when(t.wrapup.at, now)}, for the wrap-up only.`, "", fenced(t.wrapup.text, "text"));
  out.push("", "## Tools");
  for (const tool of t.tools) {
    out.push("", `### \`${tool.name}\``, "", tool.description.trim() || "No description.");
    if (tool.ability) out.push("", `Turned on by **${tool.ability}**.`);
    out.push("", fenced(JSON.stringify(tool.parameters, null, 2), "json"));
  }
  if (!t.tools.length) out.push("", "None.");
  if (t.inactive.length) out.push("", `Not active now: ${t.inactive.map((x) => `\`${x.name}\` (${x.when})`).join(", ")}.`);
  out.push("", "## Model", "", `${t.model ? `\`${t.model}\`` : "The new-session default"}${t.thinking ? `, thinking ${t.thinking}` : ""}.`);
  out.push("", `Message limit: ${t.budget.messagesUsed} of ${t.budget.messagesMax} used.`);
  out.push("", "---", "", "Only you see this. It's never on their page.");
  return out.join("\n");
}
