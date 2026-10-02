import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BatonSession, BatonStarted, BatonStartedFor, BatonStarter, BatonTold, BatonToldTool } from "../shared/baton";
import { batonById, batonSid, sessionPathOf } from "./baton";
import { activeBatonTools, batonTools, BATON_TOOLS, renderBatonPrompt } from "./baton-loadout";
import { photosFor } from "./baton-images";
import { READ_LINK_TOOL, readLinkTool } from "./baton-read-link";
import { WRAPUP_TOOL } from "./baton-wrapup";
import { hostOf, isOrgHostOpen } from "./org-engine";
import { placementSid, readProjects } from "./orgs";
import { readManifest } from "./overseer-ideas";
import { readOverseerState } from "./overseer-store";
import { readTodos } from "./overseer-todos";
import { projectOverseerPaths, readPoState } from "./project-overseer-store";
import { readActiveBranch, type Entry } from "./transcript";

/**
 * Who started a gathering session, and what it is told (§app.baton/told): the strip's Started by line
 * (`BatonInfo.started`) and What It's Told (`GET /api/baton/:sid/told`), both the operator's only.
 *
 * Who started it is the statechart's `started` (§app.baton/goal-and-loadout); a session from before it reads
 * `owner` and `startedVia`, and the overseer's conversation from its start row in the transition log.
 * Nothing else is inferred. The prompt is replayed from the session file's own system entries with
 * pi-ai's replay, so it is what pi sent, not a render of today's roster and profiles; only a session that
 * has never run gets a render, labelled a preview.
 */

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isoOf = (ms: unknown): string => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");

/** Who started it, as its statechart data records it; a session from before `started` by its owner and startedVia. Pure. */
export function starterOf(data: Record<string, unknown>): { who: BatonStarter; overseerId?: string; why?: string } {
  const s = data["started"];
  if (isObj(s) && (s.by === "operator" || s.by === "overseer" || s.by === "project-overseer")) {
    const why = str(s.why).trim();
    const overseerId = str(s.overseerId);
    return { who: s.by, ...(overseerId ? { overseerId } : {}), ...(why ? { why } : {}) };
  }
  if (isObj(data["owner"]) && typeof data["owner"].overseerOf === "string") return { who: "project-overseer" };
  if (data["startedVia"] === "overseer") return { who: "overseer" };
  return { who: "operator" };
}

/** The overseer conversation that started it, from its start row in the transition log (a session from before `started`). */
function overseerIdFromLog(orgId: string, projectId: string, sessionId: string, data: Record<string, unknown>): string | undefined {
  const spawner = str(data["sova/spawnedBy"]) || placementSid(orgId, projectId);
  try {
    const row = hostOf(orgId)
      .log.rows({ session: spawner })
      .find((r) => (r.event === "gather/start" || r.event === "baton/start") && isObj(r.envelope) && r.envelope.sessionId === sessionId);
    const id = row && isObj(row.envelope) ? str(row.envelope.overseerId) : "";
    return id || undefined;
  } catch {
    return undefined;
  }
}

/** The strip's Started by, from the row and its statechart data. */
export function startedOf(row: BatonSession, data: Record<string, unknown> | null): BatonStarted {
  const d = data ?? {};
  const s = starterOf(d);
  const overseerId = s.who === "operator" ? undefined : (s.overseerId ?? overseerIdFromLog(row.orgId, row.projectId, row.sessionId, d));
  let current = false;
  if (overseerId) {
    try {
      current = (s.who === "project-overseer" ? readPoState(projectOverseerPaths(row.orgId, row.projectId))?.current : readOverseerState()?.current) === overseerId;
    } catch {
      current = false;
    }
  }
  return { who: s.who, at: row.createdAt, ...(s.why ? { why: s.why } : {}), ...(overseerId ? { overseer: { id: overseerId, current } } : {}) };
}

/** The statechart data of a gathering session, or null when its org's engine isn't open here. */
export function batonData(row: Pick<BatonSession, "orgId" | "sessionId">): Record<string, unknown> | null {
  if (!isOrgHostOpen(row.orgId)) return null;
  return (hostOf(row.orgId).data(batonSid(row.orgId, row.sessionId)) as Record<string, unknown> | null) ?? null;
}

/** What it was started for, as recorded: a conflict, a gap, the session it came from, a to-do or idea Send to person… linked. */
function startedForOf(row: BatonSession, data: Record<string, unknown>): BatonStartedFor | undefined {
  if (row.conflict) return { kind: "conflict", area: row.conflict.area };
  const paths = projectOverseerPaths(row.orgId, row.projectId);
  const item = str(data["sova/spawnedBy"]);
  if (item.startsWith("item/") && isOrgHostOpen(row.orgId)) {
    const ideaId = str(hostOf(row.orgId).data(item)?.["ideaId"]);
    if (ideaId) {
      let title = "";
      try {
        title = readManifest(paths.ideas).ideas[ideaId]?.title ?? "";
      } catch {
        title = "";
      }
      return { kind: "gap", id: ideaId, title };
    }
  }
  if (row.parent) return { kind: "parent", sessionId: row.parent, title: batonById(row.parent)?.row.publicTitle ?? "" };
  try {
    const todo = readTodos(paths.todos).todos.find((t) => t.sessionId === row.sessionId);
    if (todo) return { kind: "todo", text: todo.text };
  } catch {
    // no to-dos file
  }
  try {
    const idea = Object.values(readManifest(paths.ideas).ideas).find((i) => i.sessionId === row.sessionId);
    if (idea) return { kind: "idea", text: idea.title };
  } catch {
    // no ideas yet
  }
  return undefined;
}

// ---- the prompt, replayed as pi replays it --------------------------------------------------------------

/** A system entry's message, as pi 0.86+ writes it. */
export interface SystemMessage {
  role: "system";
  content: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: { name: string; description?: string; parameters?: unknown }[];
  toolsRemoved?: { name: string }[];
  timestamp?: number;
}

/** pi-ai's transcript replay (the functions pi itself replays system entries with). */
export interface Replay {
  getCurrentSystemPrompt(messages: readonly { role: string }[]): string;
  getCurrentTools(messages: readonly { role: string }[]): { name: string; description?: string; parameters?: unknown }[];
}

let replayLoad: Promise<Replay> | null = null;
/** pi-ai, resolved beside the pi package's real path (pnpm keeps it there, not in Sova's own dependencies). */
export function piReplay(): Promise<Replay> {
  replayLoad ??= (async () => {
    const pi = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    let dir = dirname(pi);
    while (basename(dir) !== "pi-coding-agent" && dirname(dir) !== dir) dir = dirname(dir);
    return (await import(pathToFileURL(join(dirname(dir), "pi-ai", "dist", "utils", "transcript.js")).href)) as Replay;
  })();
  return replayLoad;
}

export interface RecordedPrompt {
  /** The conversation's prompt as last recorded before any wrap-up; null when the file has none yet. */
  prompt: { text: string; at: string; changes: number } | null;
  wrapup?: { text: string; at: string };
  tools: BatonToldTool[];
}

/** The ability that turns a tool on (§app.baton/abilities). */
const abilityOf = (name: string): string | undefined => (name === READ_LINK_TOOL ? "Read links" : undefined);

const toolOf = (t: { name: string; description?: string; parameters?: unknown }): BatonToldTool => {
  const ability = abilityOf(t.name);
  return { name: t.name, description: str(t.description), parameters: t.parameters ?? {}, ...(ability ? { ability } : {}) };
};

/**
 * The prompt and tools as the branch's system entries last recorded them. The wrap-up starts at the first
 * entry that adds its tool: the conversation's prompt and tools are those before it, and the wrap-up's own
 * prompt is the replay through it. Pure, given the replay.
 */
export function recordedPrompt(branch: readonly Entry[], replay: Replay): RecordedPrompt {
  const system = branch
    .filter((e) => e.type === "message" && isObj(e.message) && e.message.role === "system")
    .map((e) => ({ message: e.message as SystemMessage, at: str(e.timestamp) }));
  const cut = system.findIndex((s) => (s.message.toolsAdded ?? []).some((t) => t.name === WRAPUP_TOOL));
  const before = cut === -1 ? system : system.slice(0, cut);
  const changed = before.filter((s) => Object.keys(s.message.sections ?? {}).length > 0 || str(s.message.content) !== "");
  const last = changed.at(-1);
  const messages = before.map((s) => s.message);
  return {
    prompt: before.length ? { text: replay.getCurrentSystemPrompt(messages), at: last?.at || before.at(-1)!.at || isoOf(before.at(-1)!.message.timestamp), changes: changed.length } : null,
    ...(cut === -1 ? {} : { wrapup: { text: replay.getCurrentSystemPrompt(system.map((s) => s.message)), at: system[cut]!.at || isoOf(system[cut]!.message.timestamp) } }),
    tools: replay.getCurrentTools(messages).map(toolOf),
  };
}

/** The loadout's tools it doesn't have now, and when it would. Pure. */
export function inactiveTools(has: readonly string[]): { name: string; when: string }[] {
  const when: Record<string, string> = { [READ_LINK_TOOL]: "while it can read links", [WRAPUP_TOOL]: "only during the wrap-up" };
  return [...BATON_TOOLS, READ_LINK_TOOL, WRAPUP_TOOL].filter((n) => !has.includes(n)).map((name) => ({ name, when: when[name] ?? "not now" }));
}

/** The model and thinking level the branch last recorded, else null. Pure. */
export function recordedModel(branch: readonly Entry[]): { model: string | null; thinking: string | null } {
  let model: string | null = null;
  let thinking: string | null = null;
  for (const e of branch) {
    if (e.type === "model_change" && e.provider && e.modelId) model = `${e.provider}/${e.modelId}`;
    if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") thinking = e.thinkingLevel;
  }
  return { model, thinking };
}

/** GET /api/baton/:sid/told: What It's Told, for the operator. null for a session that isn't a gathering session. */
export async function toldOf(sessionId: string): Promise<BatonTold | null> {
  const hit = batonById(sessionId);
  if (!hit) return null;
  const { row, dir } = hit;
  const data = batonData(row) ?? {};
  let branch: Entry[] = [];
  try {
    branch = await readActiveBranch(sessionPathOf(dir, row));
  } catch {
    branch = []; // a session the statechart spawned before its file exists
  }
  const recorded = recordedPrompt(branch, await piReplay());
  let prompt: BatonTold["prompt"];
  let tools = recorded.tools;
  if (recorded.prompt) prompt = { kind: "recorded", ...recorded.prompt };
  else {
    // Never run: what the next reply would get, rendered now (the only render; labelled a preview).
    prompt = { kind: "preview", text: renderBatonPrompt(sessionId, undefined, !!(await photosFor(row, dir, undefined, branch).catch(() => null))) };
    const active = new Set(activeBatonTools(sessionId));
    tools = [...batonTools(sessionId, () => {}), readLinkTool(sessionId)].filter((t) => active.has(t.name)).map(toolOf);
  }
  const { model, thinking } = recordedModel(branch);
  const startedFor = startedForOf(row, data);
  return {
    publicTitle: row.publicTitle,
    orgId: row.orgId,
    projectId: row.projectId,
    projectName: readProjects(row.orgId).find((p) => p.id === row.projectId)?.name ?? "",
    started: startedOf(row, data),
    ...(startedFor ? { startedFor } : {}),
    goal: row.goal,
    prompt,
    ...(recorded.wrapup ? { wrapup: recorded.wrapup } : {}),
    tools,
    inactive: inactiveTools(tools.map((t) => t.name)),
    model: model ?? row.model ?? null,
    thinking: thinking ?? row.thinking ?? null,
    budget: row.budget,
  };
}
