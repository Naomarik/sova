import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR } from "../shared/baton";
import { MEMORY_TOOLS } from "../shared/memory";
import type { RunStartAnswer, SpecialSpec } from "../shared/chat-runtime";
import type { HEntry } from "../shared/harness";
import { declOfTool, RefusedError, registerSpecialHost, serveTools } from "./chat-handle";
import { assistantOffers, hiddenTools, offerLines, offeredKeys, offersNote, toolWordsOf, type AssistantOffers, type ToolWords } from "./project-assistant-offers";
import { catchUpConversationDraft, projectsWithRecord } from "./conversation-draft-tools";
import { PROJECT_ASSISTANT } from "./harness/state-kinds";
import { operatorName, orgDir } from "./orgs";
import { assistantOfPath, endAssistantStream, ownerFirstName, refreshAssistant, streamAssistant } from "./project-assistant";
import { effectiveAssistantModel } from "./project-assistant-store";
import { ASSISTANT_TOOL_NAMES, assistantProjects, assistantTools, ownerNow } from "./project-assistant-tools";
import { OUTSIDER_LOOKUP_RULES, projectOverview } from "./spec-lookup";
import { ASSISTANT_VIS_GUIDE } from "./baton-vis-guide";
import { inlineOperatorImages } from "./baton-images";
import { readBatonSettings } from "./baton-settings";

/**
 * The Project Assistant's loadout (§app.project-assistant/chat), the baton's pattern: its own system
 * prompt (project-assistant-prompt.md, with each shown project's outsider overview), none of the
 * operator's setup, no shell and no file tools, the served tools of project-assistant-tools.ts, its
 * memory on (its switch is project-assistant.json's `memory`, absent = on). What it offers (its
 * prompt's lines, its tool list, deploy's and start_version's words) is worked out again as each reply
 * starts, from the question Home's card asks (server/project-assistant-offers.ts,
 * §app.project-assistant/offers); no turn is attended, the operator's own included.
 */

const PROMPT_FILE = join(import.meta.dirname, "project-assistant-prompt.md");
const EVERY_MESSAGE = "Every message in the Project Assistant's conversation is someone's: it can't be rewound or regenerated.";
const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** Each open chat's branch as its run started (a tool's fallback when its call carries none). */
const branchOf = new Map<string, readonly HEntry[]>();
/** Per open chat: the offers this server last worked out for it (offeredKeys, for the change note) and the tool
    words its process's declarations carry (null: unknown, as after the server reconnected). */
const offered = new Map<string, readonly string[]>();
const declared = new Map<string, string | null>();
/** customType of the hidden note a reply starts with when its offers changed (§app.project-assistant/offers). */
export const OFFERS_NOTE = "sova-assistant-offers";

/** Photos (§app.project-assistant/photos): whether the owner can send them now, and what the model does with one. */
export const ASSISTANT_PHOTOS_ON =
  "{{OWNER}} can attach photos and screenshots to their messages, and you see them. When they report a problem, you may ask for a screenshot of what they see when that would help. Say in words what a photo shows that matters (the screen, the message, the step): you remember the words, and a photo far back in the conversation is no longer seen. Never describe a person's face or looks, and never read personal numbers in a document (account, ID, card or phone numbers) back.";
export const ASSISTANT_PHOTOS_OFF = "{{OWNER}} can't send photos here. If they offer one, ask them to describe what it shows in words.";

/** The system prompt now: who it talks to, the projects with their overviews, the draft notes. `photos`:
    the owner can send photos now (photos on, and the run's model sees images). */
export async function assistantPrompt(orgId: string, personId: string, sessionId: string, template = readFileSync(PROMPT_FILE, "utf8"), photos = false, offers?: AssistantOffers): Promise<string> {
  const projects = assistantProjects(orgId);
  const lines = offerLines(offers ?? (await assistantOffers(projects, orgId)));
  // A line offered nowhere goes whole, its line break with it: the assistant hears nothing of it.
  const fill = (t: string, key: string, text: string) => t.replace(text ? `{{${key}}}` : `{{${key}}}\n`, () => text);
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
  const withOffers = (["FIX", "PLANNING", "REQUIREMENTS", "RELEASE", "VERSIONS"] as const).reduce((t, k) => fill(t, k, lines[k.toLowerCase() as keyof typeof lines]), template);
  const body = withOffers
    .replace("{{PHOTOS}}", photos ? ASSISTANT_PHOTOS_ON : ASSISTANT_PHOTOS_OFF)
    .replace("{{DRAWING}}", `\n${ASSISTANT_VIS_GUIDE()}\n`)
    .replaceAll("{{OWNER}}", ownerFirstName(orgId, personId))
    .replaceAll("{{OPERATOR}}", firstOf(operatorName()))
    .replace("{{LOOKUP_RULES}}", `- ${OUTSIDER_LOOKUP_RULES}`)
    .replace("{{PROJECTS}}", projectsText);
  return notes.length ? `${body}\n\n# Check again with ${ownerFirstName(orgId, personId)}\n\n${notes.map((n) => `- ${n}`).join("\n")}\n` : body;
}

function toolsFor(path: string, orgId: string, personId: string, sessionId: string, words?: ToolWords) {
  const tools = assistantTools({
    orgId,
    sessionId,
    owner: () => ownerNow(orgId, personId),
    branch: () => branchOf.get(path) ?? [],
    ...(words ? { words } : {}),
  });
  serveTools(path, tools);
  return tools;
}

/** The tools this reply's model has: every allowed one but those offered nowhere (start_fix, start_feature_chat). */
const activeFor = (offers: AssistantOffers): string[] => {
  const hidden = new Set(hiddenTools(offers));
  return [...ASSISTANT_TOOL_NAMES.filter((n) => !hidden.has(n)), ...MEMORY_TOOLS];
};
/** The tools whose words follow the offers, registered again in the chat when they change. */
const WORDED_TOOLS = new Set(["deploy", "start_version"]);

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
    const offers = await assistantOffers(assistantProjects(a.orgId), a.orgId);
    const words = toolWordsOf(offers);
    const tools = toolsFor(path, a.orgId, a.personId, a.sessionId, words);
    offered.set(path, offeredKeys(offers));
    declared.set(path, JSON.stringify(words));
    // The resolved reply model (the org's pick, else the host's default, §app.project-assistant/models).
    const reply = effectiveAssistantModel(a.orgId, "reply")?.pick ?? null;
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
      start: { prompt: promptOptions(await assistantPrompt(a.orgId, a.personId, a.sessionId, undefined, false, offers)), activeTools: activeFor(offers) },
      // A drawing that can't be drawn gets one hidden retry in the same run (§app.project-assistant/drawings).
      visRetry: true,
    };
  },
  async adopt(path) {
    const a = assistantOfPath(path);
    if (!a) return;
    // The chat's declarations were made by an earlier server: its first reply registers the worded tools again.
    const offers = await assistantOffers(assistantProjects(a.orgId), a.orgId);
    toolsFor(path, a.orgId, a.personId, a.sessionId, toolWordsOf(offers));
    offered.set(path, offeredKeys(offers));
    declared.set(path, null);
  },
  async runStart(path, ctx, { images }) {
    const a = assistantOfPath(path);
    if (!a) throw new Error("Not a Project Assistant conversation.");
    branchOf.set(path, ctx.branch());
    // Photos as this run can take them: on in Settings, and its model sees images.
    const photos = readBatonSettings().photos.enabled && images;
    // What it offers now (§app.project-assistant/offers): the prompt's lines, its tool list, two tools' words.
    const offers = await assistantOffers(assistantProjects(a.orgId), a.orgId);
    const answer: RunStartAnswer = { prompt: promptOptions(await assistantPrompt(a.orgId, a.personId, a.sessionId, undefined, photos, offers)) };
    const words = toolWordsOf(offers);
    if (declared.get(path) !== JSON.stringify(words)) {
      declared.set(path, JSON.stringify(words));
      const tools = toolsFor(path, a.orgId, a.personId, a.sessionId, words);
      answer.reregister = tools.filter((t) => WORDED_TOOLS.has(t.name)).map(declOfTool);
    }
    // Set after any re-registering (which turns every allowed tool on again).
    answer.activeTools = activeFor(offers);
    const before = offered.get(path);
    offered.set(path, offeredKeys(offers));
    const note = before ? offersNote(before, offers, ownerFirstName(a.orgId, a.personId)) : null;
    if (note) answer.message = { customType: OFFERS_NOTE, content: note, display: false };
    return answer;
  },
  runEvent(path, e) {
    const a = assistantOfPath(path);
    if (!a) return;
    if (e.type === "reply.text") streamAssistant(a.orgId, path, e.text);
    else if (e.type === "run.settled") endAssistantStream(a.orgId, path); else if (e.type === "message.end" || e.type === "entry.appended") refreshAssistant(a.orgId);
  },
  clientSend(path, msg) {
    const a = assistantOfPath(path);
    if (!a) throw new RefusedError("Not a Project Assistant conversation.");
    // The operator's attached images reach the model as images, never as a path the owner would see
    // (§app.project-assistant/photos). The operator's own composer: their turn, attended.
    const inlined = inlineOperatorImages(a.sessionId, msg.text);
    return { by: OPERATOR, ...(inlined.images.length ? { text: inlined.text, images: inlined.images } : {}) };
  },
  closed(path) {
    branchOf.delete(path);
    offered.delete(path);
    declared.delete(path);
  },
  died(path) {
    const a = assistantOfPath(path);
    if (a) endAssistantStream(a.orgId, path);
  },
});
