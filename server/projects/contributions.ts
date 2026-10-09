import type { ToolSpec } from "../../shared/harness";
import type { CostKind, CostStarter } from "../../shared/costs";
import type { Autonomy, PoLimitKind, ProjectOverseerSettings, StartedSession } from "../../shared/project-overseer";
import type { ProjectSpace, ProjectSummary } from "../../shared/projects";
import type { Envelope } from "../org-envelope";
import type { ProjectOverseerPaths } from "../project-overseer-store";
import type { Hold } from "../statecharts";
import type { ActResult } from "../org-host";

/**
 * What another layer adds to a project (design: "What crosses the seam"). The project layer reads
 * these and never imports the layer that fills them in: a layer that places projects (organizations)
 * registers its part as it loads. Every reader is keyed by the engine that holds the project (its
 * host id) and the project id, and nothing here names that layer. With nothing contributed, a project
 * runs on its own: no ceiling on its level, no extra look text, tools or prompt.
 */

/** What an overseer's turn offers a contributed tool (the project's own facts and this turn's envelope). */
/** A tool's execute, as the overseer's wrappers make it. */
export type PartExecute = (toolCallId: string, params: any) => Promise<any>;

export interface OverseerPartCtx {
  engine: string;
  projectId: string;
  paths: ProjectOverseerPaths;
  project(): ProjectSummary;
  settings(): ProjectOverseerSettings;
  /** The level in force now. */
  effective(): { autonomy: Autonomy; reason?: string };
  /** The run is the operator's. */
  attended(): boolean;
  /** The current conversation's id. */
  overseerId(): string;
  /** This turn's envelope for an act of the overseer's. */
  envelope(): Envelope;
  /** The model and thinking people talk to (its gathering choice), for sessions it starts with people. */
  gatheringChoice(input: { model?: string; thinking?: string }): Promise<{ model?: string; thinking?: string }>;
  /** A statechart refused `kind` for its allowance: the watch holds it until it comes back. */
  limitRefused(kind: PoLimitKind): Promise<void>;
}

/** What contributed tools are built with: the context, plus the overseer's own wrappers (an act is logged to its
    actions and its refusals relayed as its own tools' are; `counts`: the allowance it draws on, for the hold a
    refused allowance puts on it). */
export interface OverseerToolCtx extends OverseerPartCtx {
  act(name: string, run: (params: any, toolCallId: string) => Promise<any>, counts?: PoLimitKind): PartExecute;
  read(run: (params: any) => Promise<any>): PartExecute;
  /** "Held: {what} waits until …": an act the statechart holds, in the words the overseer's tools use. */
  heldText(what: string, held: { until: number }): string;
}

/** Sessions of the project that another layer keeps (gathering sessions), for sova_list_sessions and sova_read_session. */
export interface OtherSessions {
  /** The list's heading ("Gathering"). */
  heading: string;
  list(): { id: string; line: string }[];
  /** One of them as the overseer reads it, or null: not one of these. */
  read(id: string, items: number): Promise<{ content: { type: "text"; text: string }[]; details: any } | null>;
}

export interface ProjectPart {
  /** A cap on the project's level (the envelope's `ceiling` and the watch fact), or null: none. */
  ceiling?(engine: string, projectId: string): { autonomy: Autonomy; reason: string } | null;
  /** Text appended to the watch's look (the watch fact `lookHint`), or null. */
  lookHint?(engine: string, projectId: string): string | null;
  /** More tools for the project's overseer, wrapped like its own. */
  overseerTools?(ctx: OverseerToolCtx): ToolSpec[];
  /** Lines sova_project adds after the level (an org's roster, gatherings, decisions, conflicts, spec). */
  overseerRead?(engine: string, projectId: string): Promise<string[]>;
  /** Sessions sova_list_sessions lists and sova_read_session reads besides the project's coding sessions. */
  overseerSessions?(engine: string, projectId: string): OtherSessions | null;
  /** Sections appended to the overseer's system prompt, before the operator's extra instructions. */
  overseerPrompt?(engine: string, projectId: string): string[];
  /** Lines for a look's untrusted appendix. */
  lookAppendix?(engine: string, projectId: string): string[];
  /** What else must stop before the project is archived ("2 gathering sessions open"). */
  archiveBlockers?(engine: string, projectId: string): string[];
  /** Other sessions the overseer started (the overseer info's `started`). */
  startedSessions?(engine: string, projectId: string): StartedSession[];
  /** Folders a project root may not be inside of or hold. */
  reservedRoots?(): string[];
  /** Other sessions whose cost is the project's (the cost card counts each file). */
  costSessions?(engine: string, projectId: string): CostSession[];
  /** The name of the person a project's link went to (a preview's `sentTo`), or null. */
  sentToName?(engine: string, projectId: string, personId: string): string | null;
  /** How a held act this part owns reads (its `what`, the person an hours wait waits for, its item and gap), or null. */
  holdDetails?(engine: string, hold: Hold): HoldDetails | null;
  /** Lines sova_pipeline starts with (an org's gaps, with their session ids). */
  pipelineLines?(engine: string, projectId: string): string[];
  /** A held act this part owns was approved and went ahead, but did not do what it is for (a message not sent): who and why, or null. */
  releasedNotDone?(engine: string, hold: Hold, out: ActResult): { name: string; why: string } | null;
  /** Since when the project's overseer is paused by something this part did on this host (ISO), or null. */
  pausedSince?(engine: string, projectId: string): string | null;
  /** Where the project lives, when this part holds it (the read's `space`; none: standalone). */
  space?(engine: string, projectId: string): ProjectSpace | null;
  /** Gaps: a project whose work is tracked as gaps (§gap/… ideas filed as items elsewhere). Null: none, so the
      overseer's coding sessions carry no `gap` and start on the project itself. */
  gaps?(engine: string, projectId: string): GapPart | null;
}

export interface HoldDetails {
  what?: string;
  person?: string;
  itemId?: string;
  gap?: string;
}

export interface CostSession {
  key: string;
  sessionId: string;
  title: string;
  kind: CostKind;
  by: CostStarter;
  /** Its file on this host, or null. */
  path: string | null;
  /** A custom entry (`phase` "start"/"end") marking turns counted as "wrapup" instead of `kind`. */
  wrapupEntry?: string;
}

export interface GapPart {
  /** The `gap` parameter's description on sova_create_session. */
  param: string;
  /** The session a gap's coding session starts on ("none" is never passed), or throws the refusal. */
  buildTarget(gap: string): string;
  /** The live session of a §gap idea (items/code), or null. */
  ideaTarget(ideaId: string): string | null;
  /** An idea took a §gap/ id (sova_idea, Add idea), with its title when it has one. */
  filed(ideaId: string, envelope: Envelope, title?: string): Promise<void>;
  /** A §gap idea was dropped. */
  dropped(ideaId: string, envelope: Envelope): Promise<void>;
}

const parts: ProjectPart[] = [];

export function contributeProjectPart(part: ProjectPart): void {
  parts.push(part);
}

/** Every contributed part (readers below; tests). */
export const projectParts = (): readonly ProjectPart[] => parts;

/** The lowest contributed ceiling, or null. */
export function ceilingOf(engine: string, projectId: string): { autonomy: Autonomy; reason: string } | null {
  let out: { autonomy: Autonomy; reason: string } | null = null;
  for (const p of parts) {
    const c = p.ceiling?.(engine, projectId) ?? null;
    if (c && (!out || c.autonomy < out.autonomy)) out = c;
  }
  return out;
}

export function lookHintOf(engine: string, projectId: string): string | null {
  const hints = parts.map((p) => p.lookHint?.(engine, projectId)).filter((h): h is string => !!h && !!h.trim());
  return hints.length ? hints.join("\n\n") : null;
}

export const contributedTools = (ctx: OverseerToolCtx): ToolSpec[] => parts.flatMap((p) => p.overseerTools?.(ctx) ?? []);
export async function contributedRead(engine: string, projectId: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of parts) if (p.overseerRead) out.push(...(await p.overseerRead(engine, projectId)));
  return out;
}
export const otherSessionsOf = (engine: string, projectId: string): OtherSessions[] => parts.map((p) => p.overseerSessions?.(engine, projectId) ?? null).filter((x): x is OtherSessions => !!x);
export const contributedPrompt = (engine: string, projectId: string): string[] => parts.flatMap((p) => p.overseerPrompt?.(engine, projectId) ?? []).filter((s) => s.trim());
export const contributedLookLines = (engine: string, projectId: string): string[] => parts.flatMap((p) => p.lookAppendix?.(engine, projectId) ?? []);
export const contributedBlockers = (engine: string, projectId: string): string[] => parts.flatMap((p) => p.archiveBlockers?.(engine, projectId) ?? []);
export const contributedStarted = (engine: string, projectId: string): StartedSession[] => parts.flatMap((p) => p.startedSessions?.(engine, projectId) ?? []);
export const contributedCostSessions = (engine: string, projectId: string): CostSession[] => parts.flatMap((p) => p.costSessions?.(engine, projectId) ?? []);
export function sentToNameOf(engine: string, projectId: string, personId: string): string | null {
  for (const p of parts) {
    const n = p.sentToName?.(engine, projectId, personId);
    if (n) return n;
  }
  return null;
}
export function holdDetailsOf(engine: string, hold: Hold): HoldDetails | null {
  for (const p of parts) {
    const d = p.holdDetails?.(engine, hold);
    if (d) return d;
  }
  return null;
}
export function pausedSinceOf(engine: string, projectId: string): string | null {
  for (const p of parts) {
    const at = p.pausedSince?.(engine, projectId);
    if (at) return at;
  }
  return null;
}
export const contributedPipelineLines = (engine: string, projectId: string): string[] => parts.flatMap((p) => p.pipelineLines?.(engine, projectId) ?? []);
export function releasedNotDoneOf(engine: string, hold: Hold, out: ActResult): { name: string; why: string } | null {
  for (const p of parts) {
    const r = p.releasedNotDone?.(engine, hold, out);
    if (r) return r;
  }
  return null;
}
export const reservedRoots = (): string[] => parts.flatMap((p) => p.reservedRoots?.() ?? []);
export function spaceOf(engine: string, projectId: string): ProjectSpace {
  for (const p of parts) {
    const s = p.space?.(engine, projectId);
    if (s) return s;
  }
  return { kind: "standalone" };
}
export function gapsOf(engine: string, projectId: string): GapPart | null {
  for (const p of parts) {
    const g = p.gaps?.(engine, projectId);
    if (g) return g;
  }
  return null;
}

const factListeners: ((engine: string) => Promise<void>)[] = [];
/** The project layer listens: a contributed fact (ceiling, look hint) may have changed on `engine`. */
export function onWatchFactsChanged(fn: (engine: string) => Promise<void>): void {
  factListeners.push(fn);
}
/** A contributing layer calls this when what it contributes changed (its people, its hint). */
export async function watchFactsChanged(engine: string): Promise<void> {
  for (const fn of factListeners) await fn(engine);
}

/** Tests only. */
export function resetProjectPartsForTest(): void {
  parts.length = 0;
}
