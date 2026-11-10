// A chat's design coordinator: one hidden session per chat, started at Start Coordinator. It finds the screen,
// launches the design team inside what the Setup card allows, and directs the sessions afterwards. It knows about
// designs and never holds their pages: nothing in this file gives it a page's text. Every power it has is a tool
// here, and each tool decides from server-held state, never from what the model says about itself.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolSpec } from "../../shared/harness";
import { DESIGN_ASK_ABOVE, DESIGN_BATCH_MAX, type DesignAsk, type DesignCoordinatorView, type DesignRecord, type DesignRun, type DesignSignInAnswer } from "../../shared/design";
import { isTourOrigin, type TourSize } from "../../shared/tour";
import { serverToolCall } from "../chat-handle";
import { modelDenial, readModelPolicy } from "../model-policy";
import { redactingTool, serverRedactor } from "../overseer-redact";
import { projectEngine } from "../project-services/routes";
import { listProjects } from "../projects/spaces";
import { readRegistry } from "../project-services/store";
import { tourRuntime } from "../tours/runtime";
import { TourSignInStore } from "../tours/signin-store";
import { DESIGN_COORDINATOR_PROMPT } from "../../pi-config/extensions/mode/design-guide.ts";
import { claudeCodeProviderLoad, sessionDirName } from "../../pi-config/extensions/subagents/worker-load.ts";
import type { WorkerHost, WorkerSpec, WorkerStart } from "../../shared/chat-runtime";
import { SESSIONS_DIR } from "../paths";
import { assertLaunchAllowed, deliverDesign, designRunLaunched, DesignLimitError, launchDesigns, newDesign, onDesignHandIn } from "./batch";
import { DESIGN_BROWSE_TOUR_ID, designBrowse, type BrowseParent, type DesignBrowseStores } from "./browse";
import { lookAtDesign } from "./look";
import { changeDesigns, designRoot, designSessions, runOf, setCoordinator, setRunPhase, viewOf } from "./store";

export const COORDINATOR_LIMITS = Object.freeze({ cardChars: 20_000, briefChars: 20_000, revisions: 50, shots: 200, notes: 200, textChars: 20_000 });

export interface ShotRecord { id: string; size: TourSize; file: string; url: string; at: string; outline: string }

export interface CoordinatorState {
  v: 1;
  sessionId: string;
  parentPath: string;
  chatId: string;
  sessionFile: string;
  cwd: string;
  /** How many times its session has been started again after it ended for good. */
  revived: number;
  model: string;
  vision: boolean;
  runId: string;
  revision: number;
  card: string;
  revisions: { rev: number; at: string; text: string }[];
  /** Origins the user named in their own words: Setup's brief, a message, the confirm box. */
  named: string[];
  ask: DesignAsk | null;
  /** What a yes runs: held here, never rebuilt from the model's later words. */
  grant: { verb: "up" | "down"; body: Record<string, unknown> } | null;
  shots: ShotRecord[];
  /** The pictures the user approved with Design This Screen; null until then. */
  confirmed: string[] | null;
  /** It has looked at an existing screen in this run, so launching waits for that confirm. */
  browsed: boolean;
  /** Hand-ins since its last turn: they reach it with the next message and wake nothing. */
  notes: string[];
  /** `design_new` calls since the last message it was sent: one launch against the limits. */
  newThisTurn: number;
  /** The user's yes to a turn's `design_new` going above the free limit. */
  spendOk: boolean;
  shotSeq: number;
}

/** What this module needs of the design sessions and the worker registry: the real ones, or a test's. */
export interface CoordinatorPorts {
  workers(parent: BrowseParent): CoordinatorWorkers;
  designsFor(sessionId: string): DesignRecord[];
  launchDesigns(parent: BrowseParent, runId: string, a: { brief: string; references: { name: string; mime: string; data: string; outline: string }[] }): Promise<string[]>;
  newDesign(parent: BrowseParent, a: { parents: string[]; instructions: string; model: string; runId?: string }): Promise<string>;
  deliverDesign(parent: BrowseParent, label: string, a: { text: string; key: string; by: "user" | "coordinator" | "main" }): Promise<{ queued: boolean }>;
  lookAtDesign(parent: BrowseParent, label: string, a: { version?: number; sizes?: TourSize[] }): Promise<{ shots: { size: TourSize; png: Uint8Array }[]; outline: string }>;
  systemPrompt(): string;
  specFor(parent: BrowseParent, cwd: string, model: string, systemPrompt: string): WorkerSpec;
  sessionDir(cwd: string): string;
  browse: typeof designBrowse;
  stores(sessionId: string): DesignBrowseStores;
  verbs(verb: string, body: Record<string, unknown>, caller: { kind: "design-coordinator"; id: string; granted?: true }): Promise<VerbAnswer>;
  projects(): readonly { id: string; root: string; name?: string }[];
  approveSite(origin: string): void;
  saveTestAccount(origin: string, username: string, password: string): void;
}
export interface CoordinatorWorkers {
  /** Hear its state change; the returned function stops listening. */
  watch(chatId: string, fn: () => void): () => void;
  start(req: WorkerStart): Promise<{ chatId: string; sessionFile: string }>;
  send(chatId: string, input: { text: string; delivery: "followUp"; key: string }): Promise<{ queued: boolean }>;
  state(chatId: string): "running" | "idle" | "ended" | undefined;
}
export interface VerbAnswer { ok?: boolean; error?: { code: string; message: string } | null; state?: unknown; instances?: unknown; services?: unknown }

let portsOverride: CoordinatorPorts | null = null;
/** Tests stand in for the sessions and the registry here. */
export function setCoordinatorPorts(p: CoordinatorPorts | null): void {
  portsOverride = p;
  cache.clear();
}

/** How the real ports reach the worker registry: server/chat-host.ts installs it once its router is up. */
export interface CoordinatorRegistry {
  workers(parent: BrowseParent): WorkerHost;
  status(chatId: string): "running" | "idle" | "ended" | undefined;
}
let registry: CoordinatorRegistry | null = null;
export const installCoordinatorRegistry = (r: CoordinatorRegistry | null): void => void (registry = r);

let hooked = false;
function ports(): CoordinatorPorts {
  if (portsOverride) return portsOverride;
  if (!hooked) {
    hooked = true;
    onDesignHandIn((e) => noteHandIn(e.sessionId, { label: e.label, version: e.version, note: e.note }));
  }
  return realPorts;
}

const WORKER_MARK = fileURLToPath(new URL("../../pi-config/extensions/subagents/worker-mark.ts", import.meta.url));

/** A coordinator's loadout: no file tools and no shell, so everything it may do is one of its served tools. */
export function realCoordinatorSpec(parent: BrowseParent, cwd: string, model: string, systemPrompt: string): WorkerSpec {
  // The worker mark first: it is what keeps this session out of the sessions list.
  const loaded = claudeCodeProviderLoad(model, [WORKER_MARK], undefined);
  return { kind: "design-coordinator", parent: { sessionId: parent.sessionId, path: parent.path, workerId: "design-coordinator" }, cwd, model, thinking: null, builtins: [], extensions: loaded.extensions, flags: loaded.flags ?? {}, appendSystemPrompt: systemPrompt, env: {}, agentDir: null, lowered: true };
}

const realPorts: CoordinatorPorts = {
  workers(parent) {
    if (!registry) throw new Error("The design coordinator needs Sova's chat runtime.");
    const host = registry.workers(parent);
    const statusOf = registry.status;
    return {
      start: async (req) => {
        const ref = await host.start(req);
        return { chatId: ref.chatId, sessionFile: ref.sessionFile };
      },
      send: (chatId, input) => host.send(chatId, input),
      state: statusOf,
      watch: (chatId, fn) => host.watch(chatId, null, (f) => {
        if (f.t === "state" || f.t === "ended") fn();
      }),
    };
  },
  designsFor: (sessionId) => viewOf(sessionId).designs,
  launchDesigns: async (parent, runId, a) => launchDesigns(parent, runId, a),
  newDesign: async (parent, a) => newDesign(parent, a),
  deliverDesign: (parent, label, a) => deliverDesign(parent, label, a),
  lookAtDesign,
  systemPrompt: () => DESIGN_COORDINATOR_PROMPT,
  specFor: realCoordinatorSpec,
  sessionDir: (cwd) => join(SESSIONS_DIR, sessionDirName(cwd)),
  browse: designBrowse,
  stores: (sessionId) => browseStores(sessionId),
  verbs: (verb, body, caller) => engineVerbs(verb, body, caller),
  projects: () => listProjects(),
  approveSite: (origin) => tourRuntime().approvals.approve(origin),
  saveTestAccount: (origin, username, password) => void tourRuntime().accounts.save({ origin, username, password, testAccount: true }),
};

// ---- state --------------------------------------------------------------------------------------

const cache = new Map<string, CoordinatorState>();
const dirOf = (sessionId: string): string => join(designRoot(), sessionId);
const fileOf = (sessionId: string): string => join(dirOf(sessionId), "coordinator.json");
export const shotsDir = (sessionId: string): string => join(dirOf(sessionId), "shots");

function load(sessionId: string): CoordinatorState | null {
  const held = cache.get(sessionId);
  if (held) return held;
  try {
    const st = JSON.parse(readFileSync(fileOf(sessionId), "utf8")) as CoordinatorState;
    if (st.v !== 1 || st.sessionId !== sessionId) return null;
    cache.set(sessionId, st);
    return st;
  } catch {
    return null;
  }
}

function save(st: CoordinatorState): void {
  mkdirSync(dirOf(st.sessionId), { recursive: true, mode: 0o700 });
  const f = fileOf(st.sessionId);
  writeFileSync(`${f}.tmp`, JSON.stringify(st), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
  cache.set(st.sessionId, st);
}

function viewFor(st: CoordinatorState): DesignCoordinatorView {
  const state = ports().workers({ sessionId: st.sessionId, path: st.parentPath }).state(st.chatId);
  return {
    sessionId: st.chatId,
    sessionFile: st.sessionFile,
    model: st.model,
    status: state ?? "idle",
    card: st.card,
    revision: st.revision,
    tracking: ports().designsFor(st.sessionId).length,
    ...(st.ask ? { ask: st.ask } : {}),
  };
}
const publish = (st: CoordinatorState): void => {
  save(st);
  setCoordinator(st.sessionId, viewFor(st));
};

/** Whether the user's own words named this origin (q13). */
const namedBy = (st: CoordinatorState, origin: string): boolean => st.named.includes(origin);

const following = new Map<string, () => void>();
/** The card's status follows the session's. */
function follow(st: CoordinatorState): void {
  if (following.has(st.chatId)) return;
  let last = "";
  following.set(st.chatId, ports().workers({ sessionId: st.sessionId, path: st.parentPath }).watch(st.chatId, () => {
    const cur = load(st.sessionId);
    if (!cur) return;
    const view = viewFor(cur);
    if (view.status === last) return;
    last = view.status;
    setCoordinator(cur.sessionId, view);
  }));
}

/** After a restart: the cards of the chats that have a coordinator read the truth again. */
export function reattachCoordinators(): void {
  for (const sid of designSessions()) {
    const st = load(sid);
    if (!st) continue;
    try {
      follow(st);
      setCoordinator(sid, viewFor(st));
    } catch (err) {
      console.warn(`[design] coordinator of ${sid} was not followed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---- the user's words ----------------------------------------------------------------------------

/** The exact origins a person's text names: full addresses, and localhost or 127.0.0.1 with a port. */
export function originsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) {
    try {
      const o = new URL(m[0].replace(/[.,;:!?]+$/, "")).origin;
      if (isTourOrigin(o)) out.add(o);
    } catch { /* not an address */ }
  }
  for (const m of text.matchAll(/(?<![\w./-])(localhost|127\.0\.0\.1):(\d{2,5})\b/g)) {
    const o = `http://${m[1]}:${m[2]}`;
    if (isTourOrigin(o)) out.add(o);
  }
  return [...out];
}

/** Add what a person typed to the addresses they vouched for. A model's words never come through here. */
function noteNamed(st: CoordinatorState, text: string): void {
  for (const o of originsIn(text)) if (!st.named.includes(o)) st.named.push(o);
}

// ---- waking it -----------------------------------------------------------------------------------

/** Deliver a message, carrying the notes that piled up. A message opens a new turn, so its launch count starts over. */
async function wake(st: CoordinatorState, text: string, key: string, sameTurn = false): Promise<{ queued: boolean }> {
  const notes = st.notes;
  const body = notes.length ? `Since your last turn:\n${notes.join("\n")}\n\n${text}` : text;
  st.notes = [];
  if (!sameTurn) {
    st.newThisTurn = 0;
    st.spendOk = false;
  }
  save(st);
  try {
    if (ports().workers({ sessionId: st.sessionId, path: st.parentPath }).state(st.chatId) === "ended") {
      await revive(st, body, key);
      return { queued: false };
    }
    return await ports().workers({ sessionId: st.sessionId, path: st.parentPath }).send(st.chatId, { text: body, delivery: "followUp", key });
  } catch (err) {
    st.notes = [...notes, ...st.notes];
    save(st);
    throw err;
  }
}

/** A design's other news (finished without a note, failed, being fixed): one line of context, and it wakes nothing. */
export function noteDesignEvent(sessionId: string, a: { label: string; kind: "finished" | "failed" | "fixing"; reason?: string }): void {
  const st = load(sessionId);
  if (!st) return;
  const reason = a.reason?.replace(/\s+/g, " ").trim().slice(0, 300);
  st.notes.push(`${a.label} ${a.kind === "fixing" ? "is fixing its page" : a.kind}${reason ? `: ${reason}` : "."}`);
  if (st.notes.length > COORDINATOR_LIMITS.notes) st.notes.splice(0, st.notes.length - COORDINATOR_LIMITS.notes);
  save(st);
}

/** Its session ended for good: a fresh one starts from what is known (its card and the designs' metadata), never from a page. */
async function revive(st: CoordinatorState, text: string, key: string): Promise<void> {
  const p = ports();
  const parent = { sessionId: st.sessionId, path: st.parentPath };
  const task = [`Your earlier session in this chat ended, so you are starting again. Your card said:\n${st.card || "(nothing yet)"}`, `The designs so far:\n${JSON.stringify(p.designsFor(st.sessionId).map(metadata))}`, text].join("\n\n");
  const ref = await p.workers(parent).start({ key: `${st.sessionId}:design-coordinator:revive:${++st.revived}:${key}`, spec: p.specFor(parent, st.cwd, st.model, p.systemPrompt()), session: { new: { dir: p.sessionDir(st.cwd) } }, task });
  following.get(st.chatId)?.();
  following.delete(st.chatId);
  st.chatId = ref.chatId;
  st.sessionFile = ref.sessionFile;
  publish(st);
  follow(st);
}

/** A design's hand-in, as a line of context: metadata only, and it wakes nothing. */
export function noteHandIn(sessionId: string, a: { label: string; version: number; note?: { layout: string; sections: string; type: string; color: string } | null }): void {
  const st = load(sessionId);
  if (!st) return;
  const n = a.note;
  st.notes.push(`${a.label}${a.version > 1 ? ` (version ${a.version})` : ""} handed in.${n ? ` Layout: ${n.layout}. Sections: ${n.sections}. Type: ${n.type}. Color: ${n.color}.` : ""}`);
  if (st.notes.length > COORDINATOR_LIMITS.notes) st.notes.splice(0, st.notes.length - COORDINATOR_LIMITS.notes);
  publish(st);
}

// ---- starting it ---------------------------------------------------------------------------------

function firstMessage(run: DesignRun): string {
  const designers = run.setup.models.filter((m) => m.design).map((m) => m.name);
  const directions = run.setup.directions.filter((d) => d.on).map((d) => d.name);
  return [`The brief, as the user left it on the Setup card:\n${run.setup.brief}`, `Models that will design: ${designers.join(", ") || "none"}.`, `Directions: ${directions.join(", ") || "none"}.`, `That is ${designers.length * directions.length} designs. Your run's id is ${run.id}.`].join("\n\n");
}

/** Start Coordinator: one per chat, started here; a later run hands the same session the new Setup. */
export async function startCoordinator(parent: BrowseParent, run: DesignRun, cwd: string): Promise<DesignCoordinatorView> {
  const choice = run.setup.models.find((m) => m.coordinator);
  if (!choice) throw new Error("Pick a coordinator model on the Setup card first.");
  const denied = modelDenial(readModelPolicy(), choice.ref);
  if (denied) throw new Error(denied);
  const p = ports();
  const known = load(parent.sessionId);
  if (known && p.workers(parent).state(known.chatId) !== "ended") {
    known.runId = run.id;
    known.browsed = false;
    known.confirmed = null;
    known.ask = null;
    known.grant = null;
    noteNamed(known, run.setup.brief);
    setRunPhase(parent.sessionId, run.id, "researching");
    publish(known);
    await wake(known, firstMessage(run), `${run.id}:coordinator-start`);
    return viewFor(known);
  }
  const key = `${parent.sessionId}:design-coordinator:${run.id}`;
  const ref = await p.workers(parent).start({ key, spec: p.specFor(parent, cwd, choice.ref, p.systemPrompt()), session: { new: { dir: p.sessionDir(cwd) } }, task: firstMessage(run) });
  const st: CoordinatorState = {
    v: 1, sessionId: parent.sessionId, parentPath: parent.path, chatId: ref.chatId, sessionFile: ref.sessionFile, cwd, revived: known?.revived ?? 0, model: choice.ref, vision: choice.vision, runId: run.id,
    revision: known?.revision ?? 0, card: known?.card ?? "", revisions: known?.revisions ?? [], named: known?.named ?? [], ask: null, grant: null, shots: known?.shots ?? [], confirmed: null, browsed: false, notes: [], newThisTurn: 0, spendOk: false, shotSeq: known?.shotSeq ?? 0,
  };
  noteNamed(st, run.setup.brief);
  setRunPhase(parent.sessionId, run.id, "researching");
  publish(st);
  follow(st);
  return viewFor(st);
}

// ---- what people and the main chat do ------------------------------------------------------------

/** A person's message from the coordinator's own box: their words, so an address in it counts as theirs when their page sent it. */
export async function messageCoordinator(parent: BrowseParent, text: string, key: string, vouches = true): Promise<{ queued: boolean }> {
  const st = mine(parent);
  if (vouches) noteNamed(st, text);
  save(st);
  return wake(st, text, key);
}

/** The main chat passing something on, word for word. A model typed this, so no address in it is vouched for. */
export async function tellCoordinator(parent: BrowseParent, text: string, key: string): Promise<{ queued: boolean }> {
  const st = mine(parent);
  return wake(st, text, key);
}

/** The coordinator's card, for the main chat to read when it needs to. */
export function coordinatorCard(sessionId: string): { card: string; revision: number } | null {
  const st = load(sessionId);
  return st ? { card: st.card, revision: st.revision } : null;
}

function mine(parent: BrowseParent): CoordinatorState {
  const st = load(parent.sessionId);
  if (!st || st.parentPath !== parent.path) throw new Error("This chat has no design coordinator yet.");
  return st;
}

/** Design This Screen or Not This Screen, from the user's click. */
export async function confirmRun(parent: BrowseParent, runId: string, verdict: "design" | "not-this", text?: string): Promise<void> {
  const st = mine(parent);
  const run = runOf(parent.sessionId, runId);
  if (!run || run.id !== st.runId || run.phase !== "confirm" || !run.confirm) throw new Error("There is no screen waiting to be confirmed.");
  const key = `${runId}:confirm:${Date.now()}`;
  if (verdict === "design") {
    st.confirmed = run.confirm.screenshots.map((u) => st.shots.find((s) => s.url === u)?.id).filter((x): x is string => !!x);
    setRunPhase(parent.sessionId, runId, "researching");
    publish(st);
    await wake(st, `The user pressed Design This Screen. Launch now with design_launch, using these references: ${st.confirmed.join(", ")}.`, key);
    return;
  }
  st.confirmed = null;
  if (text) noteNamed(st, text);
  changeDesigns(parent.sessionId, (s) => {
    const r = s.runs.find((x) => x.id === runId);
    if (r) delete r.confirm;
  });
  setRunPhase(parent.sessionId, runId, "researching");
  publish(st);
  await wake(st, `The user pressed Not This Screen.${text ? ` They said: ${text}` : " Ask on your card which screen they mean."}`, key);
}

/** The answer to the question on the card. A sign-in's values go to memory and never into the session. */
export async function answerCoordinator(parent: BrowseParent, id: string, answer: "yes" | "no" | DesignSignInAnswer): Promise<void> {
  const st = mine(parent);
  const ask = st.ask;
  if (!ask || ask.id !== id) throw new Error("That question has already been answered.");
  const grant = st.grant;
  st.ask = null;
  st.grant = null;
  const yes = answer === "yes";
  const key = `${ask.id}:answer`;
  const say = (text: string) => wake(st, text, key);
  switch (ask.kind) {
    case "site":
      if (yes) ports().approveSite(ask.origin);
      publish(st);
      return void (await say(yes ? `The user approved ${ask.origin}. Look again.` : `The user declined ${ask.origin}. Don't open it.`));
    case "spend":
      st.spendOk = yes;
      publish(st);
      // This turn's count and the yes the user just gave both stand: the answer continues the same launch.
      return void (await wake(st, yes ? "The user allowed more designs this turn, up to the limit. Carry on." : "The user declined more designs. Stop here.", key, true));
    case "sign-in":
    case "test-account": {
      const a = typeof answer === "object" ? answer : null;
      if (a && ask.kind === "test-account") {
        if (a.username && a.password) ports().saveTestAccount(ask.origin, a.username, a.password);
      } else if (a) {
        if (a.username && a.password) signIns.setLogin(parent.sessionId, DESIGN_BROWSE_TOUR_ID, ask.origin, { ...(a.account ? { account: a.account } : {}), username: a.username, password: a.password });
        // A one-time code goes with the login it follows; on its own it would blank that login.
        const held = signIns.login(parent.sessionId, DESIGN_BROWSE_TOUR_ID, ask.origin);
        if (a.code && held) signIns.setCredentials(parent.sessionId, DESIGN_BROWSE_TOUR_ID, { [ask.origin]: { ...held, code: a.code } });
      }
      publish(st);
      return void (await say(a ? `The user answered the sign-in for ${ask.origin}. Look again.` : `The user didn't sign in to ${ask.origin}. Don't open it.`));
    }
    case "start-project":
    case "stop-project": {
      publish(st);
      if (!yes || !grant) return void (await say(`The user said no to ${ask.text}.`));
      const r = await ports().verbs(grant.verb, grant.body, { kind: "design-coordinator", id: parent.sessionId, granted: true });
      return void (await say(r.error ? `${grant.verb} failed: ${r.error.code}: ${r.error.message}` : `${grant.verb} is done. state: ${JSON.stringify(r.state ?? null)}. Use project_verbs status to get its address.`));
    }
  }
}

/** A sign-in, in memory only, for an hour. */
const signIns = new TourSignInStore();

export function browseStores(sessionId: string): DesignBrowseStores {
  const tours = tourRuntime();
  return { approvals: tours.approvals, accounts: tours.accounts, signIns, named: (o) => { const st = load(sessionId); return !!st && namedBy(st, o); } };
}

// ---- its tools -----------------------------------------------------------------------------------

type Result = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; details: Record<string, unknown> };
const say = (text: string, details: Record<string, unknown> = {}): Result => ({ content: [{ type: "text", text }], details: { v: 1, ...details } });
const refuse = (text: string): Result => say(`Refused: ${text}`, { refused: true });
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const effect = (): string => serverToolCall()?.call.effectId ?? `${Date.now()}`;

function saveShots(st: CoordinatorState, shots: { size: TourSize; png: Uint8Array }[], outline: string): ShotRecord[] {
  mkdirSync(shotsDir(st.sessionId), { recursive: true, mode: 0o700 });
  const out: ShotRecord[] = [];
  for (const s of shots) {
    const id = `s${++st.shotSeq}`;
    const file = `${id}-${s.size}.png`;
    writeFileSync(join(shotsDir(st.sessionId), file), s.png, { mode: 0o600 });
    out.push({ id, size: s.size, file, url: `/api/design/shots/${file}?path=${encodeURIComponent(st.parentPath)}`, at: new Date().toISOString(), outline });
  }
  st.shots.push(...out);
  if (st.shots.length > COORDINATOR_LIMITS.shots) st.shots.splice(0, st.shots.length - COORDINATOR_LIMITS.shots);
  return out;
}

function picturesResult(st: CoordinatorState, shots: ShotRecord[], pngs: Uint8Array[], outline: string, url?: string): Result {
  const list = shots.map((s) => `${s.id} (${s.size})`).join(", ");
  const content: Result["content"] = [{ type: "text", text: `${url ? `At ${url}. ` : ""}Pictures: ${list}.${outline ? `\n${outline}` : ""}` }];
  if (st.vision) for (const png of pngs) content.push({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
  return { content, details: { v: 1, shots: shots.map((s) => s.id) } };
}

type NewAsk = DesignAsk extends infer A ? (A extends unknown ? Omit<A, "id"> : never) : never;
function raiseAsk(st: CoordinatorState, ask: NewAsk, grant?: CoordinatorState["grant"]): Result {
  if (st.ask) return refuse(`you're already waiting on the user for: ${st.ask.text}. Wait for that answer.`);
  st.ask = { ...ask, id: `ask-${Date.now()}-${st.shotSeq}` } as DesignAsk;
  st.grant = grant ?? null;
  publish(st);
  return say(`Asked the user on your card: ${st.ask.text} End your turn; their answer comes as your next message.`, { asked: true });
}

const metadata = (d: DesignRecord) => ({
  label: d.label, direction: d.direction, model: d.model, parents: d.parents, status: d.status, ...(d.error ? { error: d.error } : {}),
  versions: d.versions.map((v) => ({ n: v.n, at: v.at, ...(v.note ? { note: v.note } : {}) })), ...(d.usage ? { cost: d.usage.cost } : {}), ...(d.delivery ? { delivery: d.delivery.state } : {}),
});

/** The run's own limit on a launch: designers times directions against the Setup card (the batch runner checks again). */
function launchProblem(run: DesignRun): string | null {
  const n = run.setup.models.filter((m) => m.design).length * run.setup.directions.filter((d) => d.on).length;
  if (n === 0) return "the Setup card has no models or directions to design with.";
  if (n > DESIGN_BATCH_MAX) return `the Setup card asks for ${n} designs, and a batch stops at ${DESIGN_BATCH_MAX}.`;
  if (n > DESIGN_ASK_ABOVE && !run.confirmedSpend) return `the Setup card asks for ${n} designs, and the user hasn't approved more than ${DESIGN_ASK_ABOVE}.`;
  return null;
}

/** A coordinator's tools, closed over the chat its record names; none takes a chat id from the model. */
export function coordinatorTools(sessionId: string): ToolSpec[] {
  const parent: BrowseParent = { sessionId, get path() { return load(sessionId)?.parentPath ?? ""; } };
  const p = () => ports();
  const state = (): CoordinatorState | Result => load(parent.sessionId) ?? refuse("this chat's coordinator record is gone.");
  const isResult = (s: CoordinatorState | Result): s is Result => "content" in s;

  const status: ToolSpec = {
    name: "design_status", label: "Design status",
    description: "What you know of this chat's designs: label, direction, model, parents, status, versions and the note each session handed in. Never a page's code.",
    parameters: { type: "object", properties: { label: { type: "string", description: "One design's label; omit for all." } }, additionalProperties: false },
    async execute(_id, params: { label?: string }) {
      const st = state();
      if (isResult(st)) return st;
      const all = p().designsFor(parent.sessionId);
      const list = params?.label ? all.filter((d) => d.label === params.label) : all;
      const run = runOf(parent.sessionId, st.runId);
      return say(JSON.stringify({ run: run ? { id: run.id, phase: run.phase } : null, waitingOnUser: st.ask?.text ?? null, designs: list.map(metadata) }, null, 1));
    },
  };

  const launch: ToolSpec = {
    name: "design_launch", label: "Launch the design team",
    description: "Launch one design session per model and direction on the Setup card. Sova holds the models, directions and spending limits; you can't change them. references are picture ids the user approved with Design This Screen.",
    parameters: { type: "object", properties: { briefFinal: { type: "string" }, references: { type: "array", items: { type: "string" } } }, required: ["briefFinal"], additionalProperties: false },
    async execute(_id, params: { briefFinal?: string; references?: unknown }) {
      const st = state();
      if (isResult(st)) return st;
      const brief = str(params?.briefFinal);
      if (!brief || brief.length > COORDINATOR_LIMITS.briefChars) return refuse("briefFinal must be the brief, in words, within the size limit.");
      const refs = Array.isArray(params?.references) ? params.references.filter((r): r is string => typeof r === "string") : [];
      const run = runOf(parent.sessionId, st.runId);
      if (!run) return refuse("this run is gone.");
      if (run.phase !== "researching" && run.phase !== "confirm") return refuse("this run has already launched.");
      const needsConfirm = st.browsed || originsIn(run.setup.brief).length > 0 || refs.length > 0;
      if (needsConfirm && !st.confirmed) return refuse("you are working from an existing screen, so the user confirms it first: show it with design_confirm and wait.");
      if (refs.some((r) => !st.confirmed?.includes(r))) return refuse("references must be picture ids the user approved with Design This Screen.");
      const limit = launchProblem(run);
      if (limit) return refuse(limit);
      const references = [];
      for (const id of refs) {
        const shot = st.shots.find((s) => s.id === id);
        if (!shot) return refuse(`picture ${id} is gone.`);
        references.push({ name: shot.file, mime: "image/png", data: readFileSync(join(shotsDir(st.sessionId), shot.file)).toString("base64"), outline: shot.outline });
      }
      const labels = await p().launchDesigns(parent, run.id, { brief, references });
      return say(`Launched ${labels.join(", ")}. Each design's note reaches you as it finishes; nothing more to do until then.`, { labels });
    },
  };

  const confirm: ToolSpec = {
    name: "design_confirm", label: "Ask the user to confirm the screen",
    description: "Show the screen you found on your card and wait for Design This Screen or Not This Screen. shots are picture ids from design_browse. End your turn after calling it.",
    parameters: { type: "object", properties: { text: { type: "string" }, shots: { type: "array", items: { type: "string" }, minItems: 1 }, url: { type: "string" } }, required: ["text", "shots"], additionalProperties: false },
    async execute(_id, params: { text?: string; shots?: unknown; url?: string }) {
      const st = state();
      if (isResult(st)) return st;
      const text = str(params?.text);
      const ids = Array.isArray(params?.shots) ? params.shots.filter((s): s is string => typeof s === "string") : [];
      const shots = ids.map((id) => st.shots.find((s) => s.id === id));
      if (!text || !shots.length || shots.some((s) => !s)) return refuse("design_confirm needs your words and picture ids from design_browse.");
      const run = runOf(parent.sessionId, st.runId);
      if (!run || (run.phase !== "researching" && run.phase !== "confirm")) return refuse("this run is past confirming.");
      st.confirmed = null;
      const outline = shots[0]!.outline;
      changeDesigns(parent.sessionId, (s) => {
        const r = s.runs.find((x) => x.id === st.runId);
        if (r) r.confirm = { text, screenshots: shots.map((x) => x!.url), ...(str(params?.url) ? { url: str(params?.url)! } : {}), ...(outline ? { outline } : {}) };
      });
      setRunPhase(parent.sessionId, st.runId, "confirm");
      publish(st);
      return say("Your screen is on the user's card. End your turn; their answer comes as your next message.", { confirm: true });
    },
  };

  const browse: ToolSpec = {
    name: "design_browse", label: "Look at a screen",
    description: "Open an address in a real browser at desktop and phone widths and get pictures and a list of what is on the page, or look at a finished design by label. actions: click to navigate, reveal, wait, scroll; never typing and never a form. Only a declared signIn submits anything. Your own running copies and addresses the user gave open at once; any other site asks the user first.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" }, label: { type: "string", description: "A design's label, instead of url." }, version: { type: "integer" },
        actions: { type: "array", items: { type: "object" } }, sizes: { type: "array", items: { type: "string", enum: ["desktop", "phone"] } }, signIn: { type: "object" },
      },
      additionalProperties: false,
    },
    async execute(_id, params: Record<string, unknown>, signal?: AbortSignal) {
      const st = state();
      if (isResult(st)) return st;
      const sizes = params?.sizes as TourSize[] | undefined;
      if (typeof params?.label === "string") {
        const r = await p().lookAtDesign(parent, params.label, { ...(typeof params.version === "number" ? { version: params.version } : {}), ...(sizes ? { sizes } : {}) });
        const shots = saveShots(st, r.shots, r.outline);
        save(st);
        return picturesResult(st, shots, r.shots.map((s) => s.png), r.outline);
      }
      const { label: _l, version: _v, ...rest } = params ?? {};
      const out = await p().browse(parent, rest, { stores: p().stores(parent.sessionId) }, signal);
      switch (out.kind) {
        case "pictures": {
          st.browsed = true;
          const shots = saveShots(st, out.shots, out.outline);
          save(st);
          return picturesResult(st, shots, out.shots.map((s) => s.png), out.outline, out.url);
        }
        case "needs-site":
          return raiseAsk(st, { kind: "site", origin: out.origin, text: `May I open ${out.origin}?` });
        case "needs-sign-in":
          return raiseAsk(st, { kind: "sign-in", origin: out.origin, fields: out.fields, ...(out.reason ? { reason: out.reason } : {}), text: `${out.origin} asks to sign in.` });
        case "needs-test-account":
          return raiseAsk(st, { kind: "test-account", origin: out.origin, fields: ["username", "password"], text: `${out.origin} needs a test account.` });
        case "refused":
          return refuse(out.message);
      }
    },
  };

  const send: ToolSpec = {
    name: "design_send", label: "Message a design session",
    description: "Send instructions to one design session by its label. They reach it in order; if it is busy, they wait.",
    parameters: { type: "object", properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"], additionalProperties: false },
    async execute(_id, params: { label?: string; text?: string }) {
      const label = str(params?.label);
      const text = str(params?.text);
      if (!label || !text || text.length > COORDINATOR_LIMITS.textChars) return refuse("design_send needs a label and your instructions.");
      const r = await p().deliverDesign(parent, label, { text, key: `coordinator:${effect()}`, by: "coordinator" });
      return say(r.queued ? `${label} is busy; your message waits behind it.` : `${label} has your message.`);
    },
  };

  const create: ToolSpec = {
    name: "design_new", label: "Make a new design from others",
    description: "Start a new design that takes from others. parents are labels; Sova gives their pages to the new session. Say in instructions what to take from each. All your design_new calls in one turn count as one launch against the spending limits.",
    parameters: { type: "object", properties: { parents: { type: "array", items: { type: "string" }, minItems: 1 }, instructions: { type: "string" }, model: { type: "string" } }, required: ["parents", "instructions", "model"], additionalProperties: false },
    async execute(_id, params: { parents?: unknown; instructions?: string; model?: string }) {
      const st = state();
      if (isResult(st)) return st;
      const parents = Array.isArray(params?.parents) ? params.parents.filter((x): x is string => typeof x === "string") : [];
      const instructions = str(params?.instructions);
      const model = str(params?.model);
      if (!parents.length || !instructions || !model) return refuse("design_new needs parents, instructions and a model.");
      const run = runOf(parent.sessionId, st.runId);
      if (!run || !designRunLaunched(run)) return refuse("this run hasn't launched yet. Launch it with design_launch first, then make new designs from others.");
      try {
        assertLaunchAllowed(st.newThisTurn + 1, st.spendOk);
      } catch (err) {
        if (err instanceof DesignLimitError && err.needsConfirm) return raiseAsk(st, { kind: "spend", count: err.designs, text: `Make more than ${DESIGN_ASK_ABOVE} designs this turn?` });
        return refuse(err instanceof Error ? err.message : "This turn has reached the limit of one launch.");
      }
      // Counted before the wait, so calls made side by side can't all pass the same check.
      st.newThisTurn++;
      save(st);
      try {
        const label = await p().newDesign(parent, { parents, instructions, model, runId: st.runId });
        return say(`Started ${label}.`, { label });
      } catch (err) {
        st.newThisTurn--;
        save(st);
        return refuse(err instanceof Error ? err.message : "That design couldn't be started.");
      }
    },
  };

  const card: ToolSpec = {
    name: "coordinator_card", label: "Update your card",
    description: "Replace your whole card: what you have concluded, what has been made so far, what you are waiting for. Plain words, never code.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    async execute(_id, params: { text?: string }) {
      const st = state();
      if (isResult(st)) return st;
      const text = typeof params?.text === "string" ? params.text : "";
      if (!text.trim() || text.length > COORDINATOR_LIMITS.cardChars) return refuse(`the card must be text of at most ${COORDINATOR_LIMITS.cardChars} characters.`);
      st.revision++;
      st.card = text;
      st.revisions.push({ rev: st.revision, at: new Date().toISOString(), text });
      if (st.revisions.length > COORDINATOR_LIMITS.revisions) st.revisions.splice(0, st.revisions.length - COORDINATOR_LIMITS.revisions);
      publish(st);
      return say(`Card updated (revision ${st.revision}).`);
    },
  };

  const verbs: ToolSpec = redactingTool(
    {
      name: "project_verbs", label: "Projects",
      description: "See what is running across the user's projects, with status (no project means all of them). up and down {project, instance or branch} ask the user on your card first and never touch a project's main checkout.",
      parameters: { type: "object", properties: { verb: { type: "string", enum: ["status", "up", "down"] }, project: { type: "string" }, instance: { type: "string" }, branch: { type: "string" } }, required: ["verb"], additionalProperties: false },
      async execute(_id, params: { verb?: string; project?: string; instance?: string; branch?: string }) {
        const st = state();
        if (isResult(st)) return st;
        const verb = params?.verb;
        const caller = { kind: "design-coordinator" as const, id: parent.sessionId };
        if (verb === "status") {
          const roots = params.project ? [params.project] : p().projects().map((x) => x.root);
          const out: unknown[] = [];
          for (const project of roots) {
            const r = await p().verbs("status", { project }, caller);
            out.push(r.error ? { project, error: r.error.message } : { project, instances: slimCopies(r.instances) });
          }
          return say(JSON.stringify(out, null, 1));
        }
        if (verb !== "up" && verb !== "down") return refuse("this tool only does status, up and down.");
        const project = str(params.project);
        const instance = str(params.instance);
        const branch = str(params.branch);
        if (!project) return refuse(`${verb} needs a project.`);
        if (verb === "down" && !instance) return refuse("down needs the copy's instance id.");
        if (!instance && !branch) return refuse("up needs an instance or a branch: the main checkout is never started from here.");
        if (instance && readRegistry().instances.find((r) => r.id === instance)?.slot === 0) return refuse("that is the project's main checkout, which a coordinator never starts or stops.");
        const body = { project, ...(instance ? { instance } : {}), ...(branch ? { branch } : {}) };
        const target = instance ?? branch!;
        return verb === "up"
          ? raiseAsk(st, { kind: "start-project", project, ...(instance ? { instance } : {}), ...(branch ? { branch } : {}), text: `Start a copy of ${project} (${target})?` }, { verb, body })
          : raiseAsk(st, { kind: "stop-project", project, instance: instance!, text: `Stop the copy ${target} of ${project}?` }, { verb, body });
      },
    },
    serverRedactor,
  );

  return [status, launch, confirm, browse, send, create, card, verbs];
}

/** What a coordinator needs of a project's copies: which is running, and the addresses to open. */
function slimCopies(v: unknown): unknown[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const i = raw as { instance?: string; slot?: number; branch?: string | null; state?: string; services?: { name?: string; state?: string; ports?: Record<string, number> }[] };
    return {
      instance: i.instance, slot: i.slot, branch: i.branch ?? null, state: i.state,
      main: i.slot === 0,
      addresses: (i.services ?? []).flatMap((s) => (s.state === "ready" ? Object.values(s.ports ?? {}).map((p) => `http://127.0.0.1:${p}`) : [])),
    };
  });
}

/** The real project verbs, for the ports. */
export const engineVerbs: CoordinatorPorts["verbs"] = async (verb, body, caller) => projectEngine().run(verb, body, caller) as unknown as VerbAnswer;
