// The batch runner and the one way a message reaches a design session. Each label gets its own hidden
// session on its model, started by the server through the worker registry; at most DESIGN_CONCURRENT
// of a chat's sessions write at once, the rest read Queued. Nothing here reports to the main chat:
// designs finishing send it nothing, one by one or as a batch.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { WorkerHost, WorkerSpec, WorkerStart, WorkerState } from "../../shared/chat-runtime";
import type { HEntry } from "../../shared/harness";
import { DESIGN_ASK_ABOVE, DESIGN_BATCH_MAX, DESIGN_CONCURRENT, DESIGN_FIX_TRIES, designerSkills, designPlan, type DesignActor, type DesignHistoryItem, type DesignNote, type DesignRecord, type DesignRun, type DesignSetup, type DesignStill, type DesignVersion } from "../../shared/design";
import { DESIGN_PAGE_END, DESIGN_PAGE_START, designSessionPrompt } from "../../pi-config/extensions/mode/design-guide.ts";
import { claudeCodeProviderLoad, sessionDirName } from "../../pi-config/extensions/subagents/worker-load.ts";
import { SESSIONS_DIR } from "../paths";
import { readBranch } from "../harness/pi/reader";
import { agentRoot } from "../state-root";
import { applySlice, clearLivePage, livePage } from "./live";
import { noteDesignEvent } from "./coordinator";
import { pageProblem } from "./lint";
import { versionViews } from "./views";
import { replyCost, resolveDesignModel } from "./setup";
import { listModels } from "../models";
import { readModelPolicy } from "../model-policy";
import { retiredModelRefs } from "../harness/pi/model-sync";
import { dropHistory, historyVersion, recordHistory } from "./history";
import { pageInReply } from "./stream-decode";
import { designerSkillsBlock } from "./skills";
import { SCREENSHOTS_HEADING, WORDS_ONLY_NOTE } from "../../shared/design-assets";
import { changeDesign, changeDesigns, designOf, designRoot, designSessions, nextLabel, pendingPage, readDesigns, readPage, runOf, setPendingPage, setRunPhase, viewOf, writePage, writeStill } from "./store";

export interface DesignParent {
  sessionId: string;
  path: string;
}

/** What the runner needs of the worker registry (server/chat-host.ts installs the real one). */
export interface DesignHost {
  workers(parent: DesignParent): WorkerHost;
  /** A worker chat's parent and id, when this server knows it. */
  owner(chatId: string): { parent: DesignParent; workerId: string } | undefined;
  /** Click through a just-kept version's views in a browser, in the background (server/design/views.ts). */
  checkViews?(parent: DesignParent, label: string, version: number): void;
}

let host: DesignHost | null = null;
/** The worker host of a chat, for the design module's other hidden sessions. */
export const designWorkers = (parent: DesignParent): WorkerHost => workers(parent);
export const installDesignHost = (h: DesignHost | null): void => void (host = h);
const workers = (parent: DesignParent): WorkerHost => {
  if (!host) throw new Error("Design sessions need Sova's chat runtime.");
  return host.workers(parent);
};

/** A reference for the design sessions of a launch: a screenshot, and its outline for a model that can't read images. */
export interface DesignReference {
  name: string;
  mime: string;
  data: string;
  outline: string;
}

export const workerIdOf = (label: string): string => `design-${label}`;
const labelOf = (workerId: string): string | null => /^design-([A-Z]{1,4})$/.exec(workerId)?.[1] ?? null;

const WORKER_MARK = fileURLToPath(new URL("../../pi-config/extensions/subagents/worker-mark.ts", import.meta.url));

/** Words a person can act on, for a launch the limits refuse (q2). */
export class DesignLimitError extends Error {
  constructor(
    message: string,
    readonly needsConfirm: boolean,
    readonly designs: number,
  ) {
    super(message);
  }
}

/** The limits of one launch, however it is made up (q2): ask above 12, stop at 24. */
export function assertLaunchAllowed(designs: number, confirmedSpend: boolean): void {
  if (designs > DESIGN_BATCH_MAX) throw new DesignLimitError(`${designs} designs is more than the ${DESIGN_BATCH_MAX} one launch may start. Choose fewer models, styles or layouts.`, false, designs);
  if (designs > DESIGN_ASK_ABOVE && !confirmedSpend) throw new DesignLimitError(`${designs} designs is more than ${DESIGN_ASK_ABOVE}, so this launch needs your confirmation first.`, true, designs);
}

/** How many designs a setup's plan makes: what the limits count. */
export const designCount = (setup: DesignSetup): number => designPlan(setup).items.length;

// ---- starting -----------------------------------------------------------------------------------

export function specFor(parent: DesignParent, d: Pick<DesignRecord, "label" | "direction" | "layout" | "model" | "route" | "vision" | "effort">, cwd: string, reference: "none" | "screenshot" | "description"): WorkerSpec {
  const loaded = claudeCodeProviderLoad(d.model, [WORKER_MARK], undefined);
  return {
    kind: "design",
    parent: { sessionId: parent.sessionId, path: parent.path, workerId: workerIdOf(d.label) },
    cwd,
    model: d.model,
    // Low: a page is written, not reasoned about; at higher levels a model spends its minutes and money on thinking.
    // A design the Creative Director added runs at the level the user named, or on a model not ticked at Setup at the
    // model's own default (null).
    thinking: d.effort === undefined ? "low" : d.effort,
    // No file tools and no shell: a design session has only the design tools the server gives it.
    builtins: [],
    extensions: loaded.extensions,
    flags: loaded.flags ?? {},
    appendSystemPrompt: designSessionPrompt({ label: d.label, direction: d.direction, ...(d.layout ? { layout: d.layout } : {}), reference, delivery: d.route }),
    env: {},
    agentDir: null,
    lowered: true,
  };
}

/** A design's skill folders, from its run: on its own record, so a design revived after a restart keeps them. */
const skillRootsOf = (run: Pick<DesignRun, "skills" | "brief">): Pick<DesignRecord, "skills"> => {
  // The brief's choice among the run's skills: what the Creative Director left out, its designers never read.
  const mine = designerSkills(run);
  return mine.length ? { skills: mine.map((k) => ({ name: k.name, dir: k.dir })) } : {};
};

export function firstMessage(d: DesignRecord, brief: string, refs: DesignReference[], parents: { label: string; html: string }[], instructions: string | null, run?: Pick<DesignRun, "skills">, fromBrief = false): { text: string; images: NonNullable<WorkerStart["images"]> } {
  const parts: string[] = [];
  // A design added from the brief gets the brief its run launched with, then what the Creative Director asked of it.
  if (instructions && fromBrief) parts.push(brief, `The Creative Director's instructions for your design:\n${instructions}`);
  else if (instructions) parts.push(instructions);
  else parts.push(brief);
  // Sova writes the skills list itself, from the design's own record; a description comes from its run when it still has it.
  const skills = (d.skills ?? []).map((k) => ({ name: k.name, description: run?.skills?.find((r) => r.dir === k.dir)?.description ?? "" }));
  if (skills.length) parts.push(designerSkillsBlock(skills));
  // A designer that reads no pictures, given screenshots: the brief may speak of pictures, so its own note overrides that.
  if (!d.vision && (instructions ?? brief).includes(SCREENSHOTS_HEADING)) parts.push(WORDS_ONLY_NOTE);
  for (const p of parents) parts.push(`Design ${p.label}, a page to draw from:\n\n${p.html}`);
  // A reference with no outline (a pasted screenshot's: its words are in the text) adds no empty line.
  if (refs.length && !d.vision) parts.push(...refs.filter((r) => r.outline.trim()).map((r) => `Outline of the existing screen (${r.name}):\n${r.outline}`));
  const images = d.vision ? refs.map((r) => ({ type: "image" as const, data: r.data, mimeType: r.mime })) : [];
  return { text: parts.join("\n\n"), images };
}

const refFile = (sessionId: string, runId: string): string => join(designRoot(), encodeURIComponent(sessionId), "refs", `${encodeURIComponent(runId)}.json`);
function saveRefs(sessionId: string, runId: string, refs: DesignReference[]): void {
  if (!refs.length) return;
  const f = refFile(sessionId, runId);
  mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(refs), { mode: 0o600 });
}
function loadRefs(sessionId: string, runId: string): DesignReference[] {
  try {
    return JSON.parse(readFileSync(refFile(sessionId, runId), "utf8")) as DesignReference[];
  } catch {
    return [];
  }
}

/** Whether a run's own batch has been started. Its labels can't say: a design made from others joins them too. */
export const designRunLaunched = (run: Pick<DesignRun, "phase">): boolean => run.phase !== "setup" && run.phase !== "researching" && run.phase !== "brief";

/** A run's designs: one queued record per item of its setup's plan, within what the Setup card holds. */
export function launchDesigns(parent: DesignParent, runId: string, input: { brief?: string; references?: DesignReference[] }): string[] {
  const run = runOf(parent.sessionId, runId);
  if (!run) throw new Error("No such design run.");
  if (designRunLaunched(run)) return run.labels;
  const plan = designPlan(run.setup).items;
  if (!plan.length) throw new Error("Pick at least one model and one style first.");
  assertLaunchAllowed(plan.length, !!run.confirmedSpend);
  const models = new Map(run.setup.models.map((m) => [m.ref, m]));
  const brief = input.brief?.trim() || run.setup.brief;
  saveRefs(parent.sessionId, runId, input.references ?? []);
  const now = new Date().toISOString();
  const labels = changeDesigns(parent.sessionId, (s) => {
    const made: string[] = [];
    for (const item of plan) {
      const model = models.get(item.model)!;
      const label = nextLabel(s);
      made.push(label);
      s.designs.push({ label, runId, direction: item.style, ...(item.layout ? { layout: item.layout } : {}), model: model.ref, modelName: model.name, parents: [], status: "queued", route: model.route, versions: [], workerState: "stopped", vision: model.vision, ...skillRootsOf(run), createdAt: now, updatedAt: now });
      (s.internal ??= {})[label] = { attempt: 0, brief, by: "first", parentPath: parent.path };
    }
    const r = s.runs.find((x) => x.id === runId)!;
    r.labels = made;
    r.phase = "generating";
    r.updatedAt = now;
    return made;
  });
  pump(parent);
  return labels;
}

/** What a new design may run on: the models this server lists, under the user's model rules. Tests stand in for it. */
let modelSource: () => Promise<{ listed: Awaited<ReturnType<typeof listModels>>; policy: ReturnType<typeof readModelPolicy>; retired: ReadonlySet<string> }> = async () => ({ listed: await listModels(), policy: readModelPolicy(), retired: retiredModelRefs() });
export const setDesignModelSourceForTest = (fn: typeof modelSource | null): void => void (modelSource = fn ?? (async () => ({ listed: await listModels(), policy: readModelPolicy(), retired: retiredModelRefs() })));

/** A new design the Creative Director adds after Start: made from others (the server, not the coordinator, puts the
    parents' pages in its first message), or with no parents from the brief its run launched with. On any model the user
    may use for workers, ticked at Setup or not; at the effort named, else as resolveDesignModel says. */
export async function newDesign(parent: DesignParent, input: { parents: string[]; instructions: string; model: string; effort?: string; direction?: string; layout?: string; runId?: string; toolCallId?: string }): Promise<string> {
  const sid = parent.sessionId;
  const view = viewOf(sid);
  const runId = input.runId ?? view.runs.at(-1)?.id;
  const run = runId ? runOf(sid, runId) : undefined;
  if (!run) throw new Error("This chat has no design run to add to.");
  if (!designRunLaunched(run)) throw new Error("This run hasn't launched yet: launch it first, then add designs.");
  const src = await modelSource();
  const model = resolveDesignModel(src.listed, src.policy, src.retired, run.setup, input.model, input.effort);
  if (typeof model === "string") throw new Error(model);
  for (const p of input.parents) if (!readPage(sid, p)) throw new Error(`Design ${p} has no finished page to draw from.`);
  const now = new Date().toISOString();
  const fromBrief = !input.parents.length;
  const label = changeDesigns(sid, (s) => {
    const made = nextLabel(s);
    // From the brief: the text its run's own designs launched with, Sova's additions and all.
    const launched = fromBrief ? run.labels.map((l) => s.internal?.[l]).find((i) => i && !i.instructions)?.brief : undefined;
    s.designs.push({ label: made, runId: run.id, direction: input.direction ?? "Mixed", ...(input.layout ? { layout: input.layout } : {}), model: model.ref, modelName: model.name, ...(model.effort !== undefined ? { effort: model.effort } : {}), parents: input.parents, status: "queued", route: model.route, versions: [], workerState: "stopped", vision: model.vision, ...skillRootsOf(run), createdAt: now, updatedAt: now });
    (s.internal ??= {})[made] = { attempt: 0, brief: launched ?? run.brief?.prompt ?? run.setup.brief, by: "coordinator", instructions: input.instructions, parentPath: parent.path, ...(fromBrief ? { fromBrief: true as const } : {}) };
    s.runs.find((r) => r.id === run.id)!.labels.push(made);
    const r = s.runs.find((x) => x.id === run.id)!;
    if (r.phase === "done") r.phase = "generating";
    return made;
  });
  const id = recordHistory(sid, { kind: "new", by: "coordinator", runId: run.id, label, parents: input.parents, text: input.instructions, model: model.ref, direction: input.direction ?? "Mixed", ...(input.layout ? { layout: input.layout } : {}), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}) });
  setHistoryId(sid, label, id);
  pump(parent);
  return label;
}

/** The history item the page now being written answers. */
function setHistoryId(sid: string, label: string, id: string): void {
  if (!id) return;
  changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (i) i.historyId = id;
  });
}

/** A removed design is never at work: it was stopped before it was set aside, and nothing starts it while it is. */
const atWork = (d: DesignRecord): boolean => !d.removed && (d.status === "writing" || d.status === "fixing" || d.status === "queued");
/** Designs whose session is being started: no session id until the start answers, and a pump meanwhile must neither
    start them again nor count them as free room. In memory: a restart ends every start in flight with it. */
const starting = new Set<string>();
const startKey = (sid: string, label: string): string => `${sid}\0${label}`;

const working = (sid: string, d: DesignRecord): boolean =>
  !d.removed && (d.status === "writing" || d.status === "fixing" || (d.status === "queued" && ((!!d.sessionId && !d.sessionEnded) || starting.has(startKey(sid, d.label)))));

/** Start queued designs while the chat has room. */
export function pump(parent: DesignParent): void {
  const sid = parent.sessionId;
  const view = viewOf(sid);
  let room = DESIGN_CONCURRENT - view.designs.filter((d) => working(sid, d)).length;
  for (const d of view.designs) {
    if (room <= 0) return;
    // Only a queued design waiting for its first session: never a stopped or a removed one.
    if (d.status !== "queued" || d.removed || d.sessionId || starting.has(startKey(sid, d.label))) continue;
    room--;
    void startSession(parent, d.label);
  }
}

async function startSession(parent: DesignParent, label: string, seed?: { text: string; images?: NonNullable<WorkerStart["images"]> }): Promise<void> {
  const sid = parent.sessionId;
  const d = designOf(sid, label);
  const key = startKey(sid, label);
  if (!d || starting.has(key)) return;
  const st = changeDesigns(sid, (s) => {
    const i = (s.internal ??= {})[label] ?? { attempt: 0, brief: "", by: "first" as const, parentPath: parent.path };
    i.attempt++;
    s.internal[label] = i;
    return { attempt: i.attempt, brief: i.brief, instructions: i.instructions, fromBrief: !!i.fromBrief };
  });
  // Marked before the first await: every pump from here until the start answers sees it.
  starting.add(key);
  try {
    const cwd = viewCwd(sid);
    const refs = loadRefs(sid, d.runId);
    // A designer that can't read pictures works from an outline: with none (only screenshots' pictures), it has no reference.
    const reference = refs.length ? (d.vision ? "screenshot" : refs.some((r) => r.outline.trim()) ? "description" : "none") : "none";
    const parents = d.parents.map((p) => ({ label: p, html: readPage(sid, p) ?? "" }));
    const first = seed ?? firstMessage(d, st.brief, refs, parents, st.instructions ?? null, runOf(sid, d.runId), st.fromBrief);
    const ref = await workers(parent).start({
      key: `design:${sid}:${label}:${st.attempt}`,
      spec: specFor(parent, d, cwd, reference),
      session: { new: { dir: join(SESSIONS_DIR, sessionDirName(cwd)) } },
      task: first.text,
      ...(first.images?.length ? { images: first.images } : {}),
    });
    starting.delete(key);
    // Deleted, stopped or removed while it started: its session goes too, and the card stays as the stop left it.
    if (!designOf(sid, label)) return void workers(parent).stop(ref.chatId, "design deleted").catch(() => {});
    if (haltedWhileStarting.delete(key)) return void workers(parent).stop(ref.chatId, "design stopped").catch(() => {});
    changeDesign(sid, label, (x) => {
      x.sessionId = ref.chatId;
      x.sessionFile = ref.sessionFile;
      x.sessionEnded = false;
      x.workerState = "working";
    });
    follow(parent, label, ref.chatId);
  } catch (err) {
    starting.delete(key);
    if (haltedWhileStarting.delete(key)) return;
    if (designOf(sid, label)) fail(parent, label, err instanceof Error ? err.message : String(err));
  }
}

/** Starts a stop came in during: when the start answers, its session is stopped at once. */
const haltedWhileStarting = new Set<string>();

const viewCwd = (sessionId: string): string => readDesigns(sessionId).cwd ?? agentRoot();

function fail(parent: DesignParent, label: string, why: string): void {
  stopWatching(parent.sessionId, label);
  clearLivePage(parent.sessionId, label);
  setPendingPage(parent.sessionId, label, null);
  changeDesign(parent.sessionId, label, (d) => {
    d.status = "failed";
    d.error = why;
    delete d.fix;
    delete d.live;
    delete d.thinking;
    delete d.readingSkill;
    d.workerState = d.sessionEnded ? "ended" : "idle";
  });
  noteDesignEvent(parent.sessionId, { label, kind: "failed", reason: why });
  finishRun(parent, label);
}

/** The next design goes in when one is done, and a run whose designs are all done says so. */
function finishRun(parent: DesignParent, label: string): void {
  pump(parent);
  const d = designOf(parent.sessionId, label);
  if (!d) return;
  const run = runOf(parent.sessionId, d.runId);
  const view = viewOf(parent.sessionId);
  if (run?.phase === "generating" && view.designs.filter((x) => x.runId === run.id).every((x) => x.removed || x.status === "ready" || x.status === "failed" || x.status === "stopped")) setRunPhase(parent.sessionId, run.id, "done");
}

// ---- following a session -------------------------------------------------------------------------

const following = new Map<string, () => void>();

/** How long a session at work may say nothing before its card stops claiming it is writing. Long enough for a
    slow provider's whole-page wait, thinking included. */
let quietMs = 10 * 60_000;
export const setDesignQuietMsForTest = (ms: number): void => void (quietMs = ms);
const watchdogs = new Map<string, NodeJS.Timeout>();

function stopWatching(sessionId: string, label: string): void {
  const key = `${sessionId}\0${label}`;
  const t = watchdogs.get(key);
  if (t) clearTimeout(t);
  watchdogs.delete(key);
}

/** The session did something: its watch restarts. */
function heard(parent: DesignParent, label: string): void {
  stopWatching(parent.sessionId, label);
  const t = setTimeout(() => {
    watchdogs.delete(`${parent.sessionId}\0${label}`);
    const d = designOf(parent.sessionId, label);
    if (!d || !atWork(d) || !d.sessionId) return;
    void workers(parent).abort(d.sessionId).catch(() => {});
    if (d.versions.length) {
      clearLivePage(parent.sessionId, label);
      changeDesign(parent.sessionId, label, (x) => {
        x.status = "ready";
        delete x.fix;
        delete x.live;
      });
      noteUnchanged(parent.sessionId, label, "Its session went quiet and stopped responding.");
      finishRun(parent, label);
    } else fail(parent, label, "Its session went quiet and stopped responding.");
  }, quietMs);
  t.unref?.();
  watchdogs.set(`${parent.sessionId}\0${label}`, t);
}

/** Watch a design's session: its status, its queue, and how its turns end. */
function follow(parent: DesignParent, label: string, chatId: string): void {
  const key = `${parent.sessionId}\0${label}`;
  following.get(key)?.();
  let baseline: string | null | undefined;
  try {
    baseline = readDesigns(parent.sessionId).internal?.[label]?.settleKey;
    const off = workers(parent).watch(chatId, null, (f) => {
      const d = designOf(parent.sessionId, label);
      if (!d || d.sessionId !== chatId) return;
      if (f.t === "event" || (f.t === "state" && f.state.status === "running")) heard(parent, label);
      if (f.t === "state") {
        setWorkerState(parent, label, f.state);
        const k = f.state.lastSettled?.key;
        if (k && k !== baseline) {
          baseline = k;
          changeDesigns(parent.sessionId, (s) => {
            const i = s.internal?.[label];
            if (i) i.settleKey = k;
          });
          void settled(parent, label, f.state);
        }
      } else if (f.t === "event") {
        const e = f.event as { type?: string; message?: { role?: string }; sendKey?: string };
        // Each reply as it ends: the card's cost keeps climbing through a long or repeated turn.
        if (e.type === "message_end" && e.message?.role === "assistant" && d.sessionFile) void noteUsage(parent.sessionId, label, d.sessionFile);
        // The first words of its reply: past the wait for a provider slot, so Queued ends here.
        if (e.type === "message_start" && e.message?.role === "assistant" && d.status === "queued") changeDesign(parent.sessionId, label, (x) => void (x.status = "writing"));
        if (e.type === "message_start" && e.message?.role === "user" && e.sendKey && d.delivery?.key === e.sendKey) changeDesign(parent.sessionId, label, (x) => void delete x.delivery);
        if (e.type === "send_dropped" && e.sendKey && d.delivery?.key === e.sendKey)
          changeDesign(parent.sessionId, label, (x) => void (x.delivery = { state: "undelivered", key: e.sendKey!, at: new Date().toISOString(), error: "The session didn't take this message." }));
      } else if (f.t === "ended" && (f.cause === "killed" || f.cause === "died") && !f.resuming) {
        changeDesign(parent.sessionId, label, (x) => {
          x.sessionEnded = true;
          x.workerState = "ended";
        });
        clearLivePage(parent.sessionId, label);
        if (d.versions.length && (atWork(d) || readDesigns(parent.sessionId).internal?.[label]?.by === "refine")) noteUnchanged(parent.sessionId, label, f.detail ?? "Its session stopped before it finished.");
        if (atWork(d)) {
          if (d.versions.length)
            changeDesign(parent.sessionId, label, (x) => {
              x.status = "ready";
              delete x.fix;
            });
          else fail(parent, label, f.detail ?? "Its session stopped before it finished a page.");
        }
      } else if (f.t === "ended" && f.cause === "idle") {
        changeDesign(parent.sessionId, label, (x) => void (x.workerState = "stopped"));
      }
    });
    following.set(key, off);
    if (designOf(parent.sessionId, label)?.status !== "ready") heard(parent, label);
  } catch (err) {
    fail(parent, label, err instanceof Error ? err.message : String(err));
  }
}

function setWorkerState(parent: DesignParent, label: string, s: WorkerState): void {
  const next = s.status === "running" || s.status === "starting" ? "working" : s.status === "ended" ? "ended" : "idle";
  const d = designOf(parent.sessionId, label);
  if (d && d.workerState !== next) changeDesign(parent.sessionId, label, (x) => void (x.workerState = next));
}

const NO_PAGE = "The model finished without writing a page.";

/** What a turn left: a page that lands, or why the one it wrote doesn't. */
async function writtenThisTurn(sid: string, label: string, d: DesignRecord): Promise<{ page: string | null; problem: string | null }> {
  const pending = pendingPage(sid, label);
  if (pending) return { page: pending, problem: null };
  // A page written whole but never handed in (its session lost its tools, or stopped short) is still a page.
  const live = livePage(sid, label)?.text;
  const problem = live ? pageProblem(live) : null;
  if (live && !problem) return { page: live, problem: null };
  if (d.route === "reply" && d.sessionFile) {
    const reply = await unsavedReplyPage(d.sessionFile, readPage(sid, label));
    if (reply.page || reply.problem) return reply;
  }
  return { page: null, problem };
}

async function settled(parent: DesignParent, label: string, state: WorkerState): Promise<void> {
  const sid = parent.sessionId;
  stopWatching(sid, label);
  const was = designOf(sid, label);
  if (!was) return;
  const wrote = await writtenThisTurn(sid, label, was);
  const refused = changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    const out = i?.refused ?? null;
    if (i) delete i.refused;
    return out;
  });
  if (wrote.page && designOf(sid, label)) commitVersion(parent, label, wrote.page, undefined);
  const d = designOf(sid, label);
  if (!d) return;
  if (d.sessionFile) await noteUsage(sid, label, d.sessionFile);
  if (d.thinking || d.readingSkill)
    changeDesign(sid, label, (x) => {
      delete x.thinking;
      delete x.readingSkill;
    });
  // A turn that has nothing new to land is fine for a design with a page (a question in Chat); for one without, that is the problem.
  const problem = wrote.page ? null : (wrote.problem ?? refused ?? (atWork(d) && !d.versions.length ? NO_PAGE : null));
  const s = state.lastSettled;
  // The model can't act on these: a stop, or a provider's or login's failure.
  const fixable = !state.trip && s?.outcome === "success";
  if (problem && fixable && (await sendBack(parent, label, problem))) return;
  // Asked for a change and got none: a page that didn't land, or a turn that wrote nothing or stopped.
  if (d.versions.length && !wrote.page) {
    const asked = readDesigns(sid).internal?.[label]?.by === "refine";
    const stopped = state.trip ? `It was stopped: ${state.trip}.` : s?.outcome === "error" ? (s.error ?? "The model's reply failed.") : s?.outcome === "aborted" ? "It was stopped before it finished." : null;
    if (problem || asked) noteUnchanged(sid, label, problem ?? stopped ?? "It finished without changing the page.");
  }
  if (atWork(d)) {
    if (d.versions.length) {
      clearLivePage(sid, label);
      changeDesign(sid, label, (x) => {
        x.status = "ready";
        delete x.fix;
        delete x.live;
        delete x.thinking;
        delete x.readingSkill;
      });
      if (problem) noteDesignEvent(sid, { label, kind: "failed", reason: problem });
    } else {
      fail(parent, label, state.trip ? `Stopped: ${state.trip}.` : s?.outcome === "error" ? (s.error ?? "The model's reply failed.") : s?.outcome === "aborted" ? "It was stopped before it finished a page." : (problem ?? NO_PAGE));
      return;
    }
  }
  finishRun(parent, label);
}

/** One of the design's tries, or null when they are used up. */
function takeFixTry(sid: string, label: string): { attempt: number; session: number } | null {
  return changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (!i || (i.fixes ?? 0) >= DESIGN_FIX_TRIES) return null;
    i.fixes = (i.fixes ?? 0) + 1;
    return { attempt: i.fixes, session: i.attempt };
  });
}

function showFixing(sid: string, label: string, problem: string, attempt: number): DesignRecord {
  const d = changeDesign(sid, label, (x) => {
    x.status = "fixing";
    x.fix = { reason: problem, attempt, of: DESIGN_FIX_TRIES };
    delete x.error;
    delete x.live;
    delete x.thinking;
    delete x.readingSkill;
  });
  noteDesignEvent(sid, { label, kind: "fixing", reason: problem });
  return d;
}

/** A request for a change ended with no new version: the card says so. A Refine must never just appear to do nothing. */
function noteUnchanged(sid: string, label: string, reason: string): void {
  changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (i) i.by = "chat";
  });
  changeDesign(sid, label, (x) => void (x.unchanged = { reason, at: new Date().toISOString() }));
}

function fixMessage(route: DesignRecord["route"], problem: string, attempt: number): string {
  const how = route === "reply" ? "in your reply, between the two marker lines" : "with `design_stream`";
  return `Your page didn't land, so nobody can see it yet (fix ${attempt} of ${DESIGN_FIX_TRIES}). What is wrong: ${problem}\n\nFix exactly that and change nothing else. Then deliver the complete page again, ${how}, and call \`${DESIGN_HAND_IN_TOOL}\`.`;
}

/** Send a page that didn't land back to its session, while this design has tries left. False when it can't. */
async function sendBack(parent: DesignParent, label: string, problem: string): Promise<boolean> {
  const sid = parent.sessionId;
  const tried = takeFixTry(sid, label);
  if (!tried) return false;
  clearLivePage(sid, label);
  const d = showFixing(sid, label, problem, tried.attempt);
  try {
    await deliverDesign(parent, label, { text: fixMessage(d.route, problem, tried.attempt), key: `fix:${tried.session}:${tried.attempt}`, by: "server" });
    heard(parent, label);
    return true;
  } catch {
    changeDesign(sid, label, (x) => void delete x.delivery);
    return false;
  }
}

export const DESIGN_HAND_IN_TOOL = "design_hand_in";

/** The turn just ended: everything after the user's last message. */
const thisTurn = (branch: readonly HEntry[]): readonly HEntry[] => branch.slice(branch.map((e) => e.kind).lastIndexOf("user") + 1);

/** The pages the replies of this turn carry between their markers, newest first. A page from an earlier turn is
    never among them: a question in Chat, with no new page, must not find one. */
function replyPages(branch: readonly HEntry[]): string[] {
  const out: string[] = [];
  for (const e of [...thisTurn(branch)].reverse()) {
    if (e.kind !== "assistant") continue;
    const text = e.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const page = pageInReply(text, DESIGN_PAGE_START, DESIGN_PAGE_END);
    if (page !== null) out.push(page);
  }
  return out;
}

/** The newest page in this turn's replies that counts as landed. */
export const replyPageThisTurn = (branch: readonly HEntry[]): string | null => replyPages(branch).find((p) => !pageProblem(p)) ?? null;

/** A page a reply-route session wrote and never handed in, read from its session file: the live buffer is only
    this server's memory, and the file is what survives. Nothing once this turn's hand-in has dealt with it. */
async function unsavedReplyPage(file: string, current: string | null): Promise<{ page: string | null; problem: string | null }> {
  try {
    const branch = await readBranch(file);
    if (thisTurn(branch).some((e) => e.kind === "tool-result" && e.tool === DESIGN_HAND_IN_TOOL && !e.isError)) return { page: null, problem: null };
    const page = replyPageThisTurn(branch);
    if (page) return { page: page === current ? null : page, problem: null };
    const newest = replyPages(branch)[0];
    return { page: null, problem: newest === undefined ? null : pageProblem(newest) };
  } catch {
    return { page: null, problem: null };
  }
}

/** Cost per card, from the session's own replies. API prices apply on a subscription too. */
async function noteUsage(sessionId: string, label: string, file: string): Promise<void> {
  try {
    let input = 0;
    let output = 0;
    let cost = 0;
    let context: number | undefined;
    for (const e of await readBranch(file)) {
      if (e.kind !== "assistant" || !e.usage) continue;
      context = e.usage.input + e.usage.cacheRead + e.usage.cacheWrite + e.usage.output;
      input += e.usage.input + e.usage.cacheRead + e.usage.cacheWrite;
      output += e.usage.output;
      cost += (e.provider && e.model ? replyCost({ provider: e.provider, model: e.model }, e.usage, e.sentAt ?? Date.now()) : null) ?? e.usage.cost ?? 0;
    }
    changeDesign(sessionId, label, (d) => void (d.usage = { input, output, cost }));
    if (context !== undefined)
      changeDesigns(sessionId, (s) => {
        const i = s.internal?.[label];
        if (i) i.context = context;
      });
  } catch {
    // A card without a cost: the page is what matters.
  }
}

// ---- finished pages -----------------------------------------------------------------------------

const handInListeners = new Set<(e: { sessionId: string; label: string; version: number; note: DesignNote }) => void>();
/** Hear a design's hand-in (the coordinator's non-waking note). */
export function onDesignHandIn(fn: (e: { sessionId: string; label: string; version: number; note: DesignNote }) => void): () => void {
  handInListeners.add(fn);
  return () => handInListeners.delete(fn);
}

function commitVersion(parent: DesignParent, label: string, html: string, note: DesignNote | undefined): DesignVersion {
  const sid = parent.sessionId;
  const { by, historyId } = changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    const out = { by: i?.by ?? "chat", historyId: i?.historyId };
    if (i) {
      i.by = "chat";
      delete i.historyId;
    }
    return out;
  });
  const n = (designOf(sid, label)?.versions.at(-1)?.n ?? 0) + 1;
  if (historyId) historyVersion(sid, historyId, n);
  writePage(sid, label, n, html);
  // Its views, read from its markup: the browser pass below checks each one once the version is kept.
  const views = versionViews(html);
  const version: DesignVersion = { n, at: new Date().toISOString(), chars: html.length, by, ...(note ? { note } : {}), ...(views ? { views } : {}) };
  setPendingPage(sid, label, null);
  clearLivePage(sid, label);
  clearRefused(sid, label);
  changeDesign(sid, label, (d) => {
    d.versions.push(version);
    d.status = "ready";
    delete d.error;
    delete d.fix;
    delete d.unchanged;
    delete d.live;
    delete d.thinking;
    delete d.readingSkill;
  });
  if (note) for (const fn of handInListeners) fn({ sessionId: sid, label, version: n, note });
  else noteDesignEvent(sid, { label, kind: "finished" });
  if (views) host?.checkViews?.(parent, label, n);
  return version;
}

/** Looks one message allows: two rounds of looking and fixing, at two widths each (q7). */
export const DESIGN_LOOKS_PER_MESSAGE = 4;

/** Count one design_look against the message that asked for it; throws when its rounds are used up. */
export function takeLook(sessionId: string, label: string): void {
  changeDesigns(sessionId, (s) => {
    const i = s.internal?.[label];
    if (!i) return;
    i.looks = (i.looks ?? 0) + 1;
    if (i.looks > DESIGN_LOOKS_PER_MESSAGE) throw new Error("You have used your two rounds of looking and fixing for this request. Call design_hand_in with what you have.");
  });
}

export { pageProblem };

/** A design tool turning a page away. The model hears why at once, which spends one of the design's tries, and the
    card says Fixing; the turn's end knows why if it stops there. With its tries used up the turn is over. */
export function refusedPage(parent: DesignParent, label: string, problem: string, html?: string): never {
  const sid = parent.sessionId;
  assertTakesPages(sid, label);
  // The page it was refused for is what its next edits apply to, so a fix can be a small edit, not the page again.
  if (html !== undefined) refusedPages.set(`${sid}\0${label}`, html);
  const tried = takeFixTry(sid, label);
  clearLivePage(sid, label);
  if (tried) {
    changeDesigns(sid, (s) => {
      const i = s.internal?.[label];
      if (i) i.refused = problem;
    });
    showFixing(sid, label, problem, tried.attempt);
    heard(parent, label);
    throw new Error(problem);
  }
  const d = designOf(sid, label);
  if (d?.sessionId) void workers(parent).abort(d.sessionId).catch(() => {});
  if (d?.versions.length) {
    stopWatching(sid, label);
    changeDesign(sid, label, (x) => {
      x.status = "ready";
      delete x.fix;
      delete x.live;
      delete x.thinking;
      delete x.readingSkill;
    });
    noteUnchanged(sid, label, problem);
    noteDesignEvent(sid, { label, kind: "failed", reason: problem });
    finishRun(parent, label);
  } else if (d) fail(parent, label, problem);
  throw new Error(`${problem} Your tries for this page are used up, so stop now.`);
}

/** Pages a tool turned away, in memory only: what their fix edits. */
const refusedPages = new Map<string, string>();

/** The page edits apply to: the one being written, else one just refused, else the newest version. */
export const editBase = (sid: string, label: string): string | null => pendingPage(sid, label) ?? refusedPages.get(`${sid}\0${label}`) ?? readPage(sid, label);

/** A page that passed: whatever an earlier call was refused for is over. */
function clearRefused(sid: string, label: string): void {
  refusedPages.delete(`${sid}\0${label}`);
  changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (i) delete i.refused;
  });
}

/** Its session is reading a design skill: before the page starts, the tile says so instead of an empty Writing. */
export function readingSkill(parent: DesignParent, label: string): void {
  const d = designOf(parent.sessionId, label);
  if (!d || d.live || d.readingSkill || !atWork(d)) return;
  heard(parent, label);
  changeDesign(parent.sessionId, label, (x) => {
    if (x.status === "queued") x.status = "writing";
    x.readingSkill = true;
    delete x.thinking;
  });
}

/** A design stopped or set aside takes no page, and spends no try, from a session that is still winding down: every
    design tool asks this first. */
export function assertTakesPages(sid: string, label: string): void {
  const d = designOf(sid, label);
  if (d && (d.status === "stopped" || d.removed)) throw new Error("This design was stopped, so this page isn't kept. Stop now.");
}

export function savePage(parent: DesignParent, label: string, html: string): void {
  assertTakesPages(parent.sessionId, label);
  setPendingPage(parent.sessionId, label, html);
  clearRefused(parent.sessionId, label);
}

export function handIn(parent: DesignParent, label: string, html: string, note: DesignNote): DesignVersion {
  assertTakesPages(parent.sessionId, label);
  return commitVersion(parent, label, html, note);
}

/** A slice of the page being written, as its session's process sent it. */
export function onLiveFrame(chatId: string, f: { thinking?: true; gen: number; at: number; text: string }): void {
  const owner = host?.owner(chatId);
  const label = owner && labelOf(owner.workerId);
  if (!owner || !label) return;
  const sid = owner.parent.sessionId;
  const d = designOf(sid, label);
  // A stopped or removed design keeps what the stop left: a slice its dying session still sent changes nothing.
  if (!d || d.sessionId !== chatId || d.sessionEnded || d.status === "stopped" || d.removed) return;
  // A chat that came back re-telling the page it already finished: that is no new page.
  if (f.at === 0 && !f.thinking && !livePage(sid, label) && f.text.trim() === readPage(sid, label)?.trim()) return;
  heard(owner.parent, label);
  if (f.thinking) {
    if (!d.thinking && !d.live) changeDesign(sid, label, (x) => void (x.thinking = true));
    return;
  }
  const version = (d.versions.at(-1)?.n ?? 0) + 1;
  const began = applySlice(sid, label, version, f);
  if (began)
    changeDesign(sid, label, (x) => {
      if (x.status !== "fixing") x.status = "writing";
      x.live = { version, chars: 0 };
      delete x.thinking;
      delete x.readingSkill;
    });
}

export { livePage };

// ---- delivery -----------------------------------------------------------------------------------

export interface DesignSend {
  text: string;
  /** Client-made: a retry of the same send doesn't deliver it twice. */
  key: string;
  /** "server": the server's own message, sending a page back; what the next version came from stays as it was. */
  by: "user" | "coordinator" | "main" | "server";
  /** What the page shows this version came from. */
  version?: "refine" | "chat" | "coordinator";
  /** The words the history keeps, when they differ from what the session gets (a Refine's, without Sova's own lines). */
  historyText?: string;
  /** The Creative Director's tool call that sent it. */
  toolCallId?: string;
}

/**
 * The one way anything reaches a design's session: the page, Refine, the coordinator and the main chat
 * alike. It goes through the worker registry, so the session's file has one writer and sends are taken
 * in order; a busy session's message waits and the card reads Queued. A session stopped as idle comes
 * back by itself. One that has ended is replaced by a fresh session seeded from the stored page.
 * Throws when it can't be delivered, with the card saying so and the sender's text kept.
 */
export async function deliverDesign(parent: DesignParent, label: string, send: DesignSend): Promise<{ queued: boolean }> {
  const sid = parent.sessionId;
  const d = designOf(sid, label);
  if (!d) throw new Error(`No design ${label} in this chat.`);
  if (d.removed) throw new DesignRefused(`Design ${label} is removed: restore it first.`);
  if (d.status === "stopped") throw new DesignRefused(`Design ${label} is stopped: Start Again first.`);
  if (!d.sessionId) throw new Error(`Design ${label} hasn't started yet.`);
  const key = `design-send:${send.key}`;
  const by = send.version ?? (send.by === "coordinator" ? "coordinator" : "chat");
  changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (i) {
      if (send.by !== "server") i.by = by;
      // A person's new request can be fixed like the first one was; the coordinator's or the server's can't reset it.
      if (send.by === "user") delete i.fixes;
      i.looks = 0;
    }
  });
  const undelivered = (error: string): never => {
    changeDesign(sid, label, (x) => void (x.delivery = { state: "undelivered", key, at: new Date().toISOString(), error }));
    throw new Error(error);
  };
  let noted: string | null = null;
  try {
    const alive = (await workers(parent).list()).some((r) => r.chatId === d.sessionId);
    // In the history before the session can have it: a reader of the session's file finds the item for each message.
    noted = noteSent(sid, label, send, key, by, !alive);
    if (!alive) return await restartFromPage(parent, d, send.text);
    const { queued } = await workers(parent).send(d.sessionId, { text: send.text, delivery: "followUp", key });
    if (!following.has(`${sid}\0${label}`)) follow(parent, label, d.sessionId);
    changeDesign(sid, label, (x) => {
      // A failed design's reason stays until a Retry: a message doesn't make it not have failed.
      if (x.status !== "failed") delete x.error;
      if (send.by !== "server") delete x.unchanged;
      if (queued) x.delivery = { state: "queued", key, at: new Date().toISOString() };
      else delete x.delivery;
    });
    return { queued };
  } catch (err) {
    // Never given: it leaves the history, and a retry under its key is recorded afresh.
    if (noted) unnoteSent(sid, label, key, noted);
    return undelivered(err instanceof Error ? err.message : String(err));
  }
}

/** A message a design was given, in the history, once per key; the version it leads to fills in when it lands. */
function noteSent(sid: string, label: string, send: DesignSend, key: string, by: "refine" | "chat" | "coordinator", fresh: boolean): string | null {
  const seen = changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (!i) return false;
    if (i.sentKeys?.includes(key)) return true;
    i.sentKeys = [...(i.sentKeys ?? []), key].slice(-20);
    return false;
  });
  if (seen) return null;
  const via: DesignHistoryItem["via"] = send.by === "server" ? "fix" : send.by === "main" && !send.version ? "main" : by;
  const d = designOf(sid, label);
  const id = recordHistory(sid, { kind: "message", by: send.by, ...(d ? { runId: d.runId } : {}), label, via, text: send.historyText ?? send.text, ...(fresh ? { fresh: true as const } : {}), ...(send.toolCallId ? { toolCallId: send.toolCallId } : {}) });
  setHistoryId(sid, label, id);
  return id;
}

function unnoteSent(sid: string, label: string, key: string, id: string): void {
  dropHistory(sid, id);
  changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (!i) return;
    i.sentKeys = i.sentKeys?.filter((k) => k !== key);
    if (i.historyId === id) delete i.historyId;
  });
}

/** A refusal a person can act on (a removed or stopped design): the routes answer 409. */
export class DesignRefused extends Error {}

/** A session stopped for good: a new one starts from the stored page and is given the message. */
async function restartFromPage(parent: DesignParent, d: DesignRecord, text: string): Promise<{ queued: boolean }> {
  const page = readPage(parent.sessionId, d.label);
  if (!page) throw new Error(`Design ${d.label} has no finished page to start again from. Use Retry.`);
  changeDesign(parent.sessionId, d.label, (x) => {
    x.sessionEnded = true;
    delete x.sessionId;
    delete x.sessionFile;
  });
  await startSession(parent, d.label, { text: `This is your page so far, as you last delivered it:\n\n${page}\n\n${text}` });
  return { queued: false };
}

/** Try a failed design again, or Start Again a stopped one: in a fresh session, writing its page afresh. */
export function retryDesign(parent: DesignParent, label: string, by: DesignActor = "user", toolCallId?: string): void {
  const d = designOf(parent.sessionId, label);
  if (!d) throw new Error(`No design ${label} in this chat.`);
  if (d.removed) throw new DesignRefused(`Design ${label} is removed: restore it first.`);
  if (d.status !== "failed" && d.status !== "stopped") throw new DesignRefused(`Design ${label} hasn't failed or been stopped.`);
  if (d.sessionId) void workers(parent).stop(d.sessionId, "retrying this design").catch(() => {});
  changeDesign(parent.sessionId, label, (x) => {
    x.status = "queued";
    delete x.error;
    delete x.fix;
    delete x.stopped;
    delete x.sessionId;
    delete x.sessionFile;
    delete x.delivery;
    x.sessionEnded = false;
    x.workerState = "stopped";
  });
  changeDesigns(parent.sessionId, (s) => {
    const i = s.internal?.[label];
    if (i) {
      delete i.fixes;
      delete i.refused;
    }
  });
  refusedPages.delete(`${parent.sessionId}\0${label}`);
  const run = runOf(parent.sessionId, d.runId);
  if (run?.phase === "done") setRunPhase(parent.sessionId, run.id, "generating");
  setHistoryId(parent.sessionId, label, recordHistory(parent.sessionId, { kind: "again", by, runId: d.runId, label, ...(toolCallId ? { toolCallId } : {}) }));
  pump(parent);
}

/** A design that is queued, starting, or whose session is at work: what Stop can stop. */
export function designStoppable(sid: string, d: DesignRecord): boolean {
  return !d.removed && (atWork(d) || starting.has(startKey(sid, d.label)) || (!!d.sessionId && !d.sessionEnded && d.workerState === "working"));
}

/**
 * Stop a design. Nothing its session still sends changes the card from here: the watch on it ends first. What it had
 * written is kept as a still before its session goes, so the still is on disk whatever happens next. One with no
 * version reads Stopped (never Failed) and never starts by itself, a restart included; one stopped mid-change keeps its
 * last finished version and reads Ready, saying the change was stopped.
 */
export function stopDesign(parent: DesignParent, label: string, by: DesignActor, toolCallId?: string): DesignRecord {
  const sid = parent.sessionId;
  const d = designOf(sid, label);
  if (!d) throw new Error(`No design ${label} in this chat.`);
  if (d.removed) throw new DesignRefused(`Design ${label} is removed, so it isn't running.`);
  if (!designStoppable(sid, d)) throw new DesignRefused(`Design ${label} isn't queued or being written, so there's nothing to stop.`);
  return halt(parent, label, by, toolCallId);
}

function halt(parent: DesignParent, label: string, by: DesignActor, toolCallId?: string, removing = false): DesignRecord {
  const sid = parent.sessionId;
  const key = `${sid}\0${label}`;
  following.get(key)?.();
  following.delete(key);
  stopWatching(sid, label);
  if (starting.has(startKey(sid, label))) haltedWhileStarting.add(startKey(sid, label));
  const d = designOf(sid, label)!;
  const written = livePage(sid, label)?.text || pendingPage(sid, label) || "";
  const at = new Date().toISOString();
  let still: DesignStill | undefined;
  if (!d.versions.length && written.trim()) {
    const n = changeDesigns(sid, (s) => {
      const i = ((s.internal ??= {})[label] ??= { attempt: 0, brief: "", by: "first", parentPath: parent.path });
      return (i.stills = (i.stills ?? 0) + 1);
    });
    // Saved before the session is stopped: the live page is only this server's memory.
    writeStill(sid, label, n, written);
    still = { n, chars: written.length, at };
  }
  clearLivePage(sid, label);
  setPendingPage(sid, label, null);
  refusedPages.delete(key);
  const sessionId = d.sessionId;
  // Removed before it ever started: it was waiting, and reads so once restored.
  const waiting = removing && d.status === "queued" && !d.sessionId && !starting.has(startKey(sid, label));
  const out = changeDesign(sid, label, (x) => {
    if (x.versions.length) {
      x.status = "ready";
      // Its last version stands, as the tile already shows: no note.
      delete x.unchanged;
    } else {
      x.status = "stopped";
      x.stopped = { at, by, ...(still ? { still } : {}), ...(waiting ? { waiting: true as const } : {}) };
    }
    delete x.error;
    delete x.fix;
    delete x.live;
    delete x.thinking;
    delete x.readingSkill;
    delete x.delivery;
    if (x.sessionId) {
      x.sessionEnded = true;
      x.workerState = "ended";
    }
  });
  changeDesigns(sid, (s) => {
    const i = s.internal?.[label];
    if (!i) return;
    i.by = "chat";
    delete i.fixes;
    delete i.refused;
    delete i.historyId;
  });
  if (sessionId) void workers(parent).stop(sessionId, "design stopped").catch(() => {});
  // A waiting design set aside wasn't stopped: its removal is the one thing that happened to it.
  if (!waiting) {
    recordHistory(sid, { kind: "stop", by, runId: d.runId, label, ...(still ? { still } : {}), ...(toolCallId ? { toolCallId } : {}) });
    if (by !== "coordinator") noteDesignEvent(sid, { label, kind: "stopped" });
  }
  finishRun(parent, label);
  return out;
}

/** Set a design aside: one still at work is stopped first. It keeps its label, versions and session, never starts by
    itself, and still counts against the limits, so Restore always works. */
export function removeDesign(parent: DesignParent, label: string, by: DesignActor, toolCallId?: string): DesignRecord {
  const sid = parent.sessionId;
  const d = designOf(sid, label);
  if (!d) throw new Error(`No design ${label} in this chat.`);
  if (d.removed) throw new DesignRefused(`Design ${label} is already removed.`);
  if (designStoppable(sid, d)) halt(parent, label, by, toolCallId, true);
  const out = changeDesign(sid, label, (x) => void (x.removed = { at: new Date().toISOString(), by }));
  recordHistory(sid, { kind: "remove", by, runId: d.runId, label, ...(toolCallId ? { toolCallId } : {}) });
  if (by !== "coordinator") noteDesignEvent(sid, { label, kind: "removed" });
  finishRun(parent, label);
  return out;
}

/** Put a removed design back exactly as it was. One that was waiting stays Stopped until someone starts it again. */
export function restoreDesign(parent: DesignParent, label: string, by: DesignActor, toolCallId?: string): DesignRecord {
  const sid = parent.sessionId;
  const d = designOf(sid, label);
  if (!d) throw new Error(`No design ${label} in this chat.`);
  if (!d.removed) throw new DesignRefused(`Design ${label} isn't removed.`);
  const out = changeDesign(sid, label, (x) => void delete x.removed);
  recordHistory(sid, { kind: "restore", by, runId: d.runId, label, ...(toolCallId ? { toolCallId } : {}) });
  if (by !== "coordinator") noteDesignEvent(sid, { label, kind: "restored" });
  return out;
}

/** Delete one design, its session and its pages stay out of the view from here on. */
export function deleteDesign(parent: DesignParent, label: string): void {
  const d = designOf(parent.sessionId, label);
  if (!d) throw new Error(`No design ${label} in this chat.`);
  if (d.sessionId) void workers(parent).stop(d.sessionId, "design deleted").catch(() => {});
  following.get(`${parent.sessionId}\0${label}`)?.();
  following.delete(`${parent.sessionId}\0${label}`);
  clearLivePage(parent.sessionId, label);
  changeDesigns(parent.sessionId, (s) => {
    s.designs = s.designs.filter((x) => x.label !== label);
    for (const r of s.runs) r.labels = r.labels.filter((l) => l !== label);
    delete s.internal?.[label];
  });
  pump(parent);
}

/** Metadata only, never a page: what the coordinator may know of every design. */
export function designsFor(sessionId: string): { label: string; direction: string; layout?: string; model: string; parents: string[]; status: DesignRecord["status"]; removed?: true; version: number; note?: DesignNote; costUsd?: number }[] {
  return viewOf(sessionId).designs.map((d) => {
    const last = d.versions.at(-1);
    return { label: d.label, direction: d.direction, ...(d.layout ? { layout: d.layout } : {}), model: d.model, parents: d.parents, status: d.status, ...(d.removed ? { removed: true as const } : {}), version: last?.n ?? 0, ...(last?.note ? { note: last.note } : {}), ...(d.usage ? { costUsd: d.usage.cost } : {}) };
  });
}

/** After a restart: the sessions still writing are followed again, and queued designs go in. */
export function reattachDesigns(): void {
  for (const sid of designSessions()) {
    const view = viewOf(sid);
    const path = readDesigns(sid).parentPath;
    if (!path) continue;
    const parent = { sessionId: sid, path };
    for (const d of view.designs) if (d.sessionId && atWork(d)) follow(parent, d.label, d.sessionId);
    pump(parent);
  }
}

export { readPage };
export type { DesignRun };
