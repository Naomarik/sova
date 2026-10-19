import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR } from "../shared/baton";
import { MEMORY_TOOLS } from "../shared/memory";
import type { RunStartAnswer, SpecialSpec } from "../shared/chat-runtime";
import type { HEntry } from "../shared/harness";
import { declOfTool, RefusedError, registerSpecialHost, serveTools } from "./chat-handle";
import { catchUpConversationDraft, projectsWithRecord } from "./conversation-draft-tools";
import { PROJECT_ASSISTANT } from "./harness/state-kinds";
import { operatorName, orgDir } from "./orgs";
import { assistantOfPath, endAssistantStream, ownerFirstName, refreshAssistant, streamAssistant } from "./project-assistant";
import { readAssistantStore } from "./project-assistant-store";
import { ASSISTANT_TOOL_NAMES, assistantProjects, assistantTools, ownerNow } from "./project-assistant-tools";
import { OUTSIDER_LOOKUP_RULES, projectOverview } from "./spec-lookup";

/**
 * The Project Assistant's loadout (§app.project-assistant/chat), the baton's pattern: its own system
 * prompt (project-assistant-prompt.md, with each shown project's outsider overview), none of the
 * operator's setup, no shell and no file tools, the served tools of project-assistant-tools.ts, its
 * memory on (its switch is project-assistant.json's `memory`, absent = on). A turn the operator
 * started (their composer) is attended; a turn the owner's message started never is (operatorStarted,
 * read by each tool from its call's branch).
 */

const PROMPT_FILE = join(import.meta.dirname, "project-assistant-prompt.md");
const EVERY_MESSAGE = "Every message in the Project Assistant's conversation is someone's: it can't be rewound or regenerated.";
const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Each open chat's branch as its run started (a tool's fallback when its call carries none). */
const branchOf = new Map<string, readonly HEntry[]>();

/** The system prompt now: who it talks to, the projects with their overviews, the draft notes. */
export async function assistantPrompt(orgId: string, personId: string, sessionId: string, template = readFileSync(PROMPT_FILE, "utf8")): Promise<string> {
  const projects = assistantProjects(orgId);
  const parts: string[] = [];
  for (const p of projects) {
    const overview = await projectOverview(p.id, "outsider").catch(() => "");
    parts.push(`## ${p.name}\n\n${overview.trim() || "No written description yet."}`);
  }
  const notes: string[] = [];
  for (const pid of projectsWithRecord(sessionId, projects.map((p) => p.id))) {
    const r = await catchUpConversationDraft(sessionId, pid).catch(() => null);
    if (r?.notes.length) notes.push(...r.notes);
  }
  const projectsText = parts.length ? parts.join("\n\n") : "There are no projects to talk about yet.";
  const body = template
    .replaceAll("{{OWNER}}", ownerFirstName(orgId, personId))
    .replaceAll("{{OPERATOR}}", firstOf(operatorName()))
    .replace("{{LOOKUP_RULES}}", `- ${OUTSIDER_LOOKUP_RULES}`)
    .replace("{{PROJECTS}}", projectsText);
  return notes.length ? `${body}\n\n# Check again with ${ownerFirstName(orgId, personId)}\n\n${notes.map((n) => `- ${n}`).join("\n")}\n` : body;
}

function toolsFor(path: string, orgId: string, personId: string, sessionId: string) {
  const tools = assistantTools({
    orgId,
    sessionId,
    owner: () => ownerNow(orgId, personId),
    branch: () => branchOf.get(path) ?? [],
  });
  serveTools(path, tools);
  return tools;
}

const promptOptions = (customPrompt: string): RunStartAnswer["prompt"] => ({ customPrompt, appendSystemPrompt: "", contextFiles: [], skills: [], cwd: "(none)" });

registerSpecialHost({
  kind: "project-assistant",
  cwd: (path) => {
    const a = assistantOfPath(path);
    return a ? orgDir(a.orgId) : null;
  },
  // The marker AND the org's store naming it: a copy elsewhere opens as an ordinary session.
  matches: (sm, path) => !!sm.state.file().first(PROJECT_ASSISTANT) && !!assistantOfPath(path),
  async spec(path): Promise<SpecialSpec> {
    const a = assistantOfPath(path);
    if (!a) throw new Error("Not a Project Assistant conversation.");
    const tools = toolsFor(path, a.orgId, a.personId, a.sessionId);
    const reply = readAssistantStore(a.orgId).models.reply ?? null;
    return {
      kind: "project-assistant",
      extension: "sova-project-assistant",
      cwd: orgDir(a.orgId),
      tools: tools.map(declOfTool),
      customTools: [],
      allow: [...ASSISTANT_TOOL_NAMES.filter((n) => tools.some((t) => t.name === n)), ...MEMORY_TOOLS],
      // Nothing of the operator's setup reaches the owner's model.
      loader: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, append: "none" },
      model: reply?.model ?? null,
      thinking: reply?.thinking ?? null,
      memory: true,
      memorySettings: join(orgDir(a.orgId), "project-assistant.json"),
      replyText: true,
      hooks: {},
      context: "redact",
      refuses: { mode: "The Project Assistant has no modes.", rewind: EVERY_MESSAGE, regenerate: EVERY_MESSAGE },
      clientSend: true,
      composerClosed: null,
      start: { prompt: promptOptions(await assistantPrompt(a.orgId, a.personId, a.sessionId)) },
    };
  },
  async adopt(path) {
    const a = assistantOfPath(path);
    if (a) toolsFor(path, a.orgId, a.personId, a.sessionId);
  },
  async runStart(path, ctx) {
    const a = assistantOfPath(path);
    if (!a) throw new Error("Not a Project Assistant conversation.");
    branchOf.set(path, ctx.branch());
    return { prompt: promptOptions(await assistantPrompt(a.orgId, a.personId, a.sessionId)) };
  },
  runEvent(path, e) {
    const a = assistantOfPath(path);
    if (!a) return;
    if (e.type === "reply.text") streamAssistant(a.orgId, path, e.text);
    else if (e.type === "run.settled") endAssistantStream(a.orgId, path); else if (e.type === "message.end" || e.type === "entry.appended") refreshAssistant(a.orgId);
  },
  clientSend(path) {
    if (!assistantOfPath(path)) throw new RefusedError("Not a Project Assistant conversation.");
    // The operator's own composer: their turn, attended.
    return { by: OPERATOR };
  },
  closed(path) {
    branchOf.delete(path);
  },
  died(path) {
    const a = assistantOfPath(path);
    if (a) endAssistantStream(a.orgId, path);
  },
});
