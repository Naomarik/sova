// Sova's chat mode engine (§chat.mode-menu/sova-runs-modes): the major modes (normal, Delegate, Create)
// and the minor modes (align, spec, vis, memory, project and personal modes) of one chat or worker,
// lifted from the hub of pi-config/extensions/mode/index.ts with no change in what the model sees: the
// same `mode` prompt section, the same hidden notes at the same moments, the same entries, the same
// tools at the same times. Only the terminal's surfaces (status line, palette, shortcuts, the align
// viewer and widget, `/mode status`, `/mode default`) are gone.
//
// Harness-neutral: the engine speaks ModePort (the runtime) and ModeCtx (one event's context), both in
// port.ts; server/harness/pi/modes.ts wires pi's events to the methods below. The pure modules (state,
// prompt, minor, align, routing, spec-guard, project-*) are the extension's own, imported, never copied,
// so the old extension (the Experimental switch off) and this engine read and write the same formats.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ALIGN_NUDGE_MESSAGE,
  ALIGN_NUDGE_TEXT,
  ALIGN_STATE_MESSAGE,
  ALIGN_TOOL,
  alignStateNote,
  looksLikeUncapturedPlan,
  marksChangeRequest,
  openDocsOf,
  reviewRequestMessage,
  type AlignDocument,
  type AlignReviewerSlot,
  type AlignReviewPhase,
  type LegacyAlignDoc,
} from "../../pi-config/extensions/mode/align.ts";
import type { AlignToolHost } from "../../pi-config/extensions/mode/align-tool.ts";
import { reviewStartText } from "../../pi-config/extensions/mode/review-prompt.ts";
import { delegateKey, type DelegateBackend } from "../../pi-config/extensions/mode/delegate.ts";
import { MODE_WORKER_DISCOVER_EVENT, MODE_WORKER_EVENT, WORKER_ROLE_DISCOVER_EVENT, WORKER_ROLE_EVENT, type ModeWorkerEvent } from "../../pi-config/extensions/mode/events.ts";
import {
  adoptableMinorModes,
  isMinorMode,
  MINOR_MODES,
  MINOR_SURFACES,
  normalizeMinorModes,
  parseMinorFlag,
  visToolsWanted,
  webMinorRefusal,
  workerMinorModes,
  type MinorMode,
} from "../../pi-config/extensions/mode/minor.ts";
import { ALIGN_SETTINGS_FILE, alignSettingsReader, resolveAlign, type AlignEagerness, type AlignStyle } from "../../pi-config/extensions/mode/align-settings.ts";
import { applyModeSection, buildAlignEagernessNote, buildAlignStyleNote, buildModeNote, buildProjectModeNote, buildSpecWriterPrompt, composePrompt, composeWorkerPrompt, DEFAULT_ROUTES, workerProjectModes } from "../../pi-config/extensions/mode/prompt.ts";
import { discoverProjectModes, readProjectMode } from "../../pi-config/extensions/mode/project-discovery.ts";
import { PROJECT_MODE_PREFIX, PROJECT_MODES_DIR, projectModeArg, projectToolName, type ProjectModeListing, type ProjectModeProblem, type ProjectModeRef, type ProjectModeSnapshot } from "../../pi-config/extensions/mode/project-format.ts";
import { isApproved } from "../../pi-config/extensions/mode/project-tools-approval.ts";
import { projectToolDefinitions, withdrawnDefinition } from "../../pi-config/extensions/mode/project-tools.ts";
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT } from "../../pi-config/extensions/sandbox/state.ts";
import { backendsOf, routeAll, routeNotice, routeWriter, slotNotice, usable, type Discovery, type ProfileRoute, type SlotRoute } from "../../pi-config/extensions/mode/routing.ts";
import { SPEC_WRITER_LABEL, specBackends, specKey } from "../../pi-config/extensions/mode/spec.ts";
import { OFF_PROFILE_ID, profilesReader, resolveSubagents, type ResolvedSubagents } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { CensusHook, driftNote, LANDED_FILE_ENV, SpecWriteGuard, writeLanded } from "../../pi-config/extensions/mode/spec-guard.ts";
import {
  activeOf,
  DEFAULT_MODES,
  hasMinor,
  insideSova,
  isDefaultMode,
  loadState,
  MODE_DISCOVER_EVENT,
  MODE_NOTE_TYPE,
  MODE_STATE_EVENT,
  modeSwitch,
  orchestrates,
  parseMode,
  projectModesOf,
  webModeRefusal,
  withMinor,
  withProjectMode,
  type Mode,
  type ModeActive,
  type ModeNoteDetails,
} from "../../pi-config/extensions/mode/state.ts";
import type { HiddenNote, ModeCtx, ModePort } from "./port";

/** remote/workers.ts: a session on a target announces itself; asking makes it announce again. */
const REMOTE_SESSION_EVENT = "remote:session";
const REMOTE_DISCOVER_EVENT = "remote:discover";

/** How long one backend's discovery stands (index.ts DISCOVERY_TTL_MS). */
const DISCOVERY_TTL_MS = { models: 10 * 60 * 1000, error: 60 * 1000, missing: 0 } as const;
const discoveryTtl = (discovery: Discovery): number =>
  "models" in discovery ? DISCOVERY_TTL_MS.models : discovery.missing ? DISCOVERY_TTL_MS.missing : DISCOVERY_TTL_MS.error;

/** Tools removed from the orchestrator while strict delegate is on. */
const STRICT_REMOVED_TOOLS = new Set(["edit", "write"]);
/** The launch flags Sova passes per hosted session (index.ts REVIEW_FLAG, VISUALS_FLAG). */
export const REVIEW_FLAG = "adversarial-review";
export const VISUALS_FLAG = "align-visuals";

/** A switch's marker, without the snapshot recordSwitch adds (index.ts SwitchMarker). */
type SwitchMarker = { mode: Mode } | { minor: MinorMode; on: boolean } | { project: string; on: boolean } | { strict: boolean };
type ModeMarker = SwitchMarker & { active?: ModeActive; head?: MinorMode[]; projectHead?: ProjectModeRef[] };

const refsKey = (refs: readonly ProjectModeRef[]): string => refs.map((ref) => `${ref.id}@${ref.sha}`).join(",");

/** The listing with one mode's fresh read in place of what it had for that id (index.ts withListed). */
function withListed(listing: ProjectModeListing, read: ProjectModeSnapshot | ProjectModeProblem): ProjectModeListing {
  const modes = listing.modes.filter((m) => m.id !== read.id);
  const problems = listing.problems.filter((p) => p.id !== read.id);
  if ("kind" in read) {
    if (read.kind !== "no-entry" || existsSync(read.path)) problems.push(read);
  } else modes.push(read);
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { ...listing, modes: modes.sort(byId), problems: problems.sort(byId) };
}

/** Where a chat's modes come from: its checkout's (and, with personal modes, the user's) listing, and a fresh read of one. */
export interface ModeSource {
  listing(cwd: string): ProjectModeListing;
  /** A fresh read of `id` for a turn-on, from the folder `listing` has it in (or would). */
  read(listing: ProjectModeListing, id: string): ProjectModeSnapshot | ProjectModeProblem;
  /** Whether `copy`'s tools are approved where it came from. */
  approved(listing: ProjectModeListing, copy: Pick<ProjectModeSnapshot, "id" | "toolsHash" | "dir">): boolean;
  /** The project root a copy's programs are told when it isn't the checkout its folder sits in (a personal mode); undefined: the default. */
  projectRoot?(copy: Pick<ProjectModeSnapshot, "dir">, cwd: string): string | undefined;
}

/** Today's source: the checkout's `.sova/minor-modes/` alone (index.ts). */
export const CHECKOUT_MODES: ModeSource = {
  listing: (cwd) => discoverProjectModes(cwd),
  read: (listing, id) => readProjectMode(join(listing.root!, PROJECT_MODES_DIR), id),
  approved: (listing, copy) => listing.root !== null && isApproved(listing.root, copy.id, copy.toolsHash),
};

export interface ModeEngineOptions {
  /** The agent dir (mode.json, mode-align.json, subagent profiles). */
  agentDir: string;
  /** The trusted spec tools (`<agent dir>/extensions/spec/core`). */
  specCore: () => string;
  /** Where project (and personal) modes are read. */
  modes?: ModeSource;
  /** Test-only: replaces process.env for PI_SPEC_CENSUS_HOOK and the landed file. */
  env?: NodeJS.ProcessEnv;
}

/** before_agent_start's answer: the section to write and the hidden align-state message, as index.ts returned it. */
export interface BeforeStartResult {
  message?: HiddenNote;
  systemPrompt?: string;
}

/** What agent_before_settle may answer: the nudge appended and one more request. */
export interface SettleResult {
  entries: unknown[];
  continue: true;
}

export class ModeEngine {
  readonly stateFile: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly source: ModeSource;
  private active: ModeActive;
  private head: MinorMode[] | undefined;
  private told: MinorMode[] = [];
  private guides: MinorMode[] = [];
  private projectHead: ProjectModeRef[] | undefined;
  private toldProjects: ProjectModeRef[] = [];
  private projectGuides: string[] = [];
  private snapshots = new Map<string, ProjectModeSnapshot>();
  private listing: ProjectModeListing = { root: null, name: "", modes: [], problems: [] };
  private sessionCwd = process.cwd();
  private sandboxOn = false;
  private readonly registeredTools = new Map<string, string>();
  private running = false;
  private pick: string | undefined;
  private readonly readProfiles: ReturnType<typeof profilesReader>;
  private reviewFlag = false;
  private readonly readAlignSettings: ReturnType<typeof alignSettingsReader>;
  private alignVisuals = false;
  private headStyle: AlignStyle | undefined;
  private toldStyle: AlignStyle | undefined;
  private headEagerness: AlignEagerness | undefined;
  private toldEagerness: AlignEagerness | undefined;
  private routes: readonly ProfileRoute[] = DEFAULT_ROUTES;
  private writerRoute: SlotRoute | null = null;
  private toldWriter: string | undefined;
  private discoveries: Partial<Record<DelegateBackend, Discovery>> = {};
  private readonly discoveredAt: Partial<Record<DelegateBackend, number>> = {};
  private probedKey: string | undefined;
  private inflight: { key: string; notify: boolean; done: Promise<void> } | undefined;
  private toolsSnapshot: string[] | undefined;
  private probeGeneration = 0;
  private alignDocs: AlignDocument[] = [];
  private legacyAlign: LegacyAlignDoc | null = null;
  private runAlignCalls = 0;
  private lastReplyText = "";
  private nudged = false;
  private runUserAsked = false;
  private runMarked = false;
  private workerRole = false;
  private hostPromptOptions: (() => { sections?: Record<string, string> }) | undefined;
  private remoteTarget: string | undefined;
  private alignForm = { review: false, visual: false };
  private reviewRegistered = false;
  private readonly specCensus: CensusHook;
  private readonly specWrites = new SpecWriteGuard();
  private readonly hoistedNotes = new Map<string, string[]>();
  private readonly hoistedProcedure = new Map<string, string>();
  /** The align tool's host (align-tool.ts), registered by the adapter. */
  readonly alignHost: AlignToolHost;
  /** Called once, at the first session start with the review flag on, to register `/review`. */
  onReviewNeeded: (() => void) | undefined;

  constructor(
    private readonly port: ModePort,
    private readonly opts: ModeEngineOptions,
  ) {
    this.env = opts.env ?? process.env;
    this.source = opts.modes ?? CHECKOUT_MODES;
    this.stateFile = join(opts.agentDir, "mode.json");
    this.active = activeOf(loadState(this.stateFile));
    this.readProfiles = profilesReader(opts.agentDir);
    this.readAlignSettings = alignSettingsReader(join(opts.agentDir, ALIGN_SETTINGS_FILE));
    this.specCensus = new CensusHook({ core: () => opts.specCore(), worker: () => this.workerRole });

    port.on(WORKER_ROLE_EVENT, (data) => {
      if ((data as { version?: unknown } | null)?.version === 1) this.workerRole = true;
    });
    port.emit(WORKER_ROLE_DISCOVER_EVENT, { version: 1 });

    this.alignHost = {
      docs: () => this.alignDocs,
      changed: (doc) => {
        this.alignDocs = [...this.alignDocs.filter((d) => d.id !== doc.id), doc];
      },
      remoteTarget: () => this.remoteTarget,
      review: () => (this.reviewFlag ? { reviewer: () => this.reviewerSlot(), startText: reviewStartText } : undefined),
      style: () => this.alignNow().style,
      specOn: () => hasMinor(this.active, "spec"),
      specProcedure: () => (this.specOn() && this.env.PI_SPEC_CENSUS_HOOK !== "0" ? this.specCensus.takeProcedure() : Promise.resolve(undefined)),
    };
  }

  /**
   * The rest of the bus: what workers get, the active state on request, the remote target and the sandbox.
   * Called by the harness after it declared the launch flags, where index.ts listened.
   */
  listen(): void {
    const port = this.port;
    port.on(MODE_WORKER_DISCOVER_EVENT, (data) => {
      if ((data as { version?: unknown } | null)?.version === 1) this.publishWorkerModes();
    });
    port.on(MODE_DISCOVER_EVENT, () => this.publishActive());
    port.on(REMOTE_SESSION_EVENT, (data) => {
      const target = (data as { target?: unknown } | undefined)?.target;
      if (typeof target === "string" && target !== "") this.remoteTarget = target;
    });
    port.emit(REMOTE_DISCOVER_EVENT, { version: 1 });
    port.on(SANDBOX_STATE_EVENT, (data) => {
      if ((data as { version?: unknown } | undefined)?.version === 1) this.sandboxOn = (data as { on?: unknown }).on === true;
    });
    port.emit(SANDBOX_DISCOVER_EVENT, { version: 1 });
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** This chat's active state now (mode, strict, minor modes, project modes). */
  activeState(): ModeActive {
    return activeOf(this.active);
  }

  /** This session is a worker (the subagents marker answered). */
  isWorker(): boolean {
    return this.workerRole;
  }

  private subagents(): ResolvedSubagents {
    const s = this.readProfiles();
    return resolveSubagents(this.opts.agentDir, this.pick, s.profiles, s.default);
  }
  private readDelegate() {
    return this.subagents().delegate;
  }
  private readSpec() {
    return this.subagents().spec;
  }
  private alignNow() {
    return resolveAlign(this.readAlignSettings(), this.subagents().alignment);
  }
  private alignOptions(style: AlignStyle, eagerness: AlignEagerness) {
    return { eagerness, style, visuals: this.alignVisuals };
  }
  private probedReviewer() {
    return this.reviewFlag && hasMinor(this.active, "align") && !this.workerRole ? this.subagents().reviewer : null;
  }
  private refreshPick(ctx: ModeCtx): void {
    try {
      this.pick = ctx.branch.pick();
    } catch {
      // No branch to read: keep the last pick.
    }
  }
  private writerInstruction(): string {
    return this.writerRoute ? buildSpecWriterPrompt(this.writerRoute) : "Spec writer: no worker is configured; write draft claims and evidence yourself.";
  }
  private specOn(): boolean {
    return hasMinor(this.active, "spec") && this.remoteTarget === undefined;
  }
  private censusOff(): boolean {
    return this.env.PI_SPEC_CENSUS_HOOK === "0";
  }

  // ── The prompt ───────────────────────────────────────────────────────────

  /** Adopt a command context's base prompt options (index.ts adoptHost). */
  adoptHost(get: (() => { sections?: Record<string, string> }) | undefined): void {
    if (typeof get === "function") this.hostPromptOptions = get;
  }

  /** What every `/mode` call did first: adopt the caller's base options and bring them in step. */
  private enter(ctx: ModeCtx): void {
    this.adoptHost(ctx.hostOptions());
    this.syncHostSection();
  }

  private publishWorkerModes(): void {
    const minors = workerMinorModes(this.active.minorModes);
    const copies = this.workerRole ? [] : this.activeSnapshots();
    const projects = workerProjectModes(minors.length, copies);
    const prompt = composeWorkerPrompt(this.active, copies);
    const event: ModeWorkerEvent = {
      version: 1,
      minorModes: minors,
      ...(prompt === undefined ? {} : { prompt }),
      ...(projects.length > 0 ? { projectModes: projects } : {}),
    };
    try {
      this.port.emit(MODE_WORKER_EVENT, event);
    } catch {
      // Best-effort: without it, workers get no mode text.
    }
  }

  private syncHostSection(block: string | undefined = this.modeBlock()): void {
    if (this.hostPromptOptions === undefined) return;
    let sections: Record<string, string> | undefined;
    try {
      sections = this.hostPromptOptions().sections;
    } catch {
      this.hostPromptOptions = undefined;
      return;
    }
    if (sections) applyModeSection(sections, block);
  }

  private headMinors(): MinorMode[] {
    return this.head ?? this.active.minorModes;
  }
  private headProjects(): ProjectModeRef[] {
    return this.projectHead ?? projectModesOf(this.active);
  }
  private copiesOf(refs: readonly ProjectModeRef[]): ProjectModeSnapshot[] {
    return refs.map((ref) => this.snapshots.get(ref.sha)).filter((copy): copy is ProjectModeSnapshot => copy !== undefined);
  }
  private activeSnapshots(): ProjectModeSnapshot[] {
    return this.copiesOf(projectModesOf(this.active));
  }

  /** The `mode` section now (index.ts modeBlock). */
  modeBlock(): string | undefined {
    return this.workerRole
      ? composeWorkerPrompt({ minorModes: this.headMinors() })
      : composePrompt(
          this.active,
          this.routes,
          this.writerRoute,
          this.headMinors(),
          this.alignOptions(this.headStyle ?? this.alignNow().style, this.headEagerness ?? this.alignNow().eagerness),
          this.copiesOf(this.headProjects()).map((copy) => copy.text),
        );
  }

  private fixHead(): void {
    if (this.head !== undefined) return;
    this.head = [...this.active.minorModes];
    this.told = [...this.head];
    this.guides = [];
    this.projectHead = projectModesOf(this.active);
    this.toldProjects = [...this.projectHead];
    this.projectGuides = [];
    this.toldWriter = this.head.includes("spec") ? this.writerInstruction() : undefined;
    if (this.headStyle === undefined || this.headEagerness === undefined) {
      const now = this.alignNow();
      this.headStyle ??= now.style;
      this.headEagerness ??= now.eagerness;
      if (!this.workerRole && this.head.includes("align") && (this.headStyle !== "default" || this.headEagerness !== "eager")) {
        try {
          this.port.recordHead({ v: 1, style: this.headStyle, ...(this.headEagerness === "careful" ? { eagerness: this.headEagerness } : {}) });
        } catch {
          // Best-effort: without it, a reopen reads this head as Default, Eager.
        }
      }
    }
    this.toldStyle ??= this.headStyle;
    this.toldEagerness ??= this.headEagerness;
  }

  private takeNote(): HiddenNote | undefined {
    const head = this.head;
    if (head === undefined) return undefined;
    const { style, eagerness } = this.alignNow();
    const worker = this.workerRole;
    const note = worker
      ? buildModeNote(workerMinorModes(this.told), workerMinorModes(this.active.minorModes), { head: workerMinorModes(head), guides: this.guides }, null, true)
      : buildModeNote(this.told, this.active.minorModes, { head, guides: this.guides }, this.writerRoute, false, this.alignOptions(style, eagerness));
    const instruction = this.writerInstruction();
    const routeNote =
      !worker && this.active.minorModes.includes("spec") && !head.includes("spec") && !note?.guides.includes("spec") && this.toldWriter !== instruction
        ? `Spec writer routing now applies instead of any earlier writer routing.\n\n${instruction}`
        : undefined;
    const alignGuide = note?.guides.includes("align") ?? false;
    const was = this.toldStyle ?? this.headStyle ?? "default";
    const styleNote = !worker && hasMinor(this.active, "align") && !alignGuide && was !== style ? buildAlignStyleNote(was, style) : undefined;
    const wasEagerness = this.toldEagerness ?? this.headEagerness ?? "eager";
    const eagernessNote = !worker && hasMinor(this.active, "align") && !alignGuide && wasEagerness !== eagerness ? buildAlignEagernessNote(eagerness) : undefined;
    const projectNote = worker
      ? undefined
      : buildProjectModeNote(this.toldProjects, projectModesOf(this.active), { head: this.projectHead ?? [], guides: this.projectGuides }, this.snapshots);
    if (!note && !routeNote && !styleNote && !eagernessNote && !projectNote) return undefined;
    if (this.active.minorModes.includes("spec")) this.toldWriter = instruction;
    const toldAlignStyle = alignGuide || styleNote !== undefined;
    if (toldAlignStyle) this.toldStyle = style;
    const toldAlignEagerness = alignGuide || eagernessNote !== undefined;
    if (toldAlignEagerness) this.toldEagerness = eagerness;
    this.told = [...this.active.minorModes];
    this.guides = normalizeMinorModes([...this.guides, ...(note?.guides ?? [])]);
    this.toldProjects = projectModesOf(this.active);
    this.projectGuides = [...new Set([...this.projectGuides, ...(projectNote?.guides ?? [])])];
    const details: ModeNoteDetails = {
      v: 1,
      minorModes: [...this.told],
      guides: note?.guides ?? [],
      ...(this.toldProjects.length > 0 ? { projectModes: [...this.toldProjects] } : {}),
      ...(projectNote && projectNote.guides.length > 0 ? { projectGuides: projectNote.guides } : {}),
    };
    if (toldAlignStyle) Object.assign(details, { style, headStyle: this.headStyle ?? style });
    if (toldAlignEagerness) Object.assign(details, { eagerness, headEagerness: this.headEagerness ?? eagerness });
    return {
      customType: MODE_NOTE_TYPE,
      content: [note?.text, projectNote?.text, routeNote, styleNote, eagernessNote].filter(Boolean).join("\n\n"),
      display: false,
      details,
    };
  }

  // ── Routing (Delegate, the spec writer, the reviewer) ───────────────────────

  private recomputeRoutes(): void {
    const denial = this.port.denial();
    if (orchestrates(this.active.mode)) {
      const delegate = this.readDelegate();
      this.routes = delegate ? routeAll(delegate, this.discoveries, denial) : [];
    }
    this.writerRoute =
      (hasMinor(this.active, "spec") || this.headMinors().includes("spec")) && !this.workerRole ? routeWriter(this.readSpec(), this.discoveries, denial) : null;
  }

  private probeScope(): { key: string; backends: DelegateBackend[] } {
    const delegate = orchestrates(this.active.mode) ? (this.readDelegate() ?? undefined) : undefined;
    const spec = hasMinor(this.active, "spec") && !this.workerRole ? this.readSpec() : undefined;
    const reviewer = this.probedReviewer();
    const backends = new Set<DelegateBackend>([
      ...(delegate ? backendsOf(delegate) : []),
      ...(spec ? specBackends(spec) : []),
      ...(reviewer ? specBackends({ version: 1, writer: reviewer }) : []),
    ]);
    const key = [delegate ? delegateKey(delegate) : null, spec ? specKey(spec) : null];
    return { key: JSON.stringify(reviewer ? [...key, specKey({ version: 1, writer: reviewer })] : key), backends: [...backends] };
  }

  private probeWanted(): boolean {
    return this.probeScope().backends.length > 0;
  }

  private applyStrictTools(): void {
    if (this.toolsSnapshot === undefined) this.toolsSnapshot = this.port.activeTools();
    this.port.setActiveTools(this.toolsSnapshot.filter((name) => !STRICT_REMOVED_TOOLS.has(name)));
  }

  private restoreTools(): void {
    if (this.toolsSnapshot === undefined) return;
    this.port.setActiveTools(this.toolsSnapshot);
    this.toolsSnapshot = undefined;
  }

  private refreshRouting(ctx: ModeCtx, notifyDegraded: boolean): Promise<void> {
    const { key, backends } = this.probeScope();
    if (this.inflight && this.inflight.key === key) {
      this.inflight.notify ||= notifyDegraded;
      return this.inflight.done;
    }
    const generation = ++this.probeGeneration;
    const run: { key: string; notify: boolean; done: Promise<void> } = { key, notify: notifyDegraded || !!this.inflight?.notify, done: Promise.resolve() };
    run.done = (async () => {
      const found = await Promise.all(backends.map(async (backend) => [backend, await ctx.discover(backend)] as const));
      if (this.inflight === run) this.inflight = undefined;
      if (generation !== this.probeGeneration || !this.probeWanted()) return;
      const now = Date.now();
      for (const [backend, discovery] of found) {
        this.discoveries = { ...this.discoveries, [backend]: discovery };
        this.discoveredAt[backend] = now;
      }
      this.probedKey = key;
      this.recomputeRoutes();
      this.syncHostSection();
      if (!run.notify) return;
      const notices = orchestrates(this.active.mode) ? this.routes.map(routeNotice).filter((line): line is string => line !== undefined) : [];
      if (notices.length > 0) ctx.notify(`Delegate routing:\n${notices.join("\n")}`, "warning");
      const writerNotice = this.writerRoute ? slotNotice(SPEC_WRITER_LABEL, this.writerRoute, "the agent") : undefined;
      if (writerNotice) ctx.notify(writerNotice, "warning");
    })();
    this.inflight = run;
    return run.done;
  }

  private routingStale(): boolean {
    const { key, backends } = this.probeScope();
    if (key !== this.probedKey) return true;
    const now = Date.now();
    return backends.some((backend) => {
      const discovery = this.discoveries[backend];
      return discovery === undefined || now - (this.discoveredAt[backend] ?? 0) >= discoveryTtl(discovery);
    });
  }

  private dropProbe(): void {
    ++this.probeGeneration;
    this.inflight = undefined;
  }

  private reviewerSlot(): AlignReviewerSlot | null {
    const reviewer = this.subagents().reviewer;
    if (!reviewer) return null;
    const route = routeWriter({ version: 1, writer: reviewer }, this.discoveries, this.port.denial())!;
    const why = [route.primary.reason, route.fallback?.reason].filter(Boolean).join("; ");
    return {
      use: route.use,
      via: route.via,
      retry: route.via === "primary" && route.fallback && usable(route.fallback) ? route.fallback.choice : null,
      ...(route.via === "fallback" ? { reason: route.primary.reason ?? "primary unavailable" } : {}),
      ...(route.via === "none" ? { reason: `${why || "primary unavailable"}${route.fallback ? "" : "; no fallback is set"}` } : {}),
    };
  }

  // ── Switches ─────────────────────────────────────────────────────────────

  private appendSwitch(marker: SwitchMarker): void {
    const data: ModeMarker = { ...marker, active: activeOf(this.active) };
    if (this.head !== undefined && (this.head.join(",") !== this.active.minorModes.join(",") || refsKey(this.projectHead ?? []) !== refsKey(projectModesOf(this.active)))) {
      data.head = [...this.head];
      if (this.projectHead && this.projectHead.length > 0) data.projectHead = [...this.projectHead];
    }
    try {
      this.port.recordSwitch(data);
    } catch {
      // Appending is impossible before session_start; nothing else here depends on it.
    }
  }

  private publishActive(): void {
    this.port.emit(MODE_STATE_EVENT, activeOf(this.active));
  }

  /** Switch the major mode (index.ts setMode); resolves once the Delegate probe a switch into it starts has landed. */
  async setMode(next: Mode, ctx: ModeCtx): Promise<void> {
    this.enter(ctx);
    if (next === this.active.mode) return;
    const refused = webModeRefusal(next, ctx.sessionId());
    if (refused) {
      ctx.notify(`Mode not changed: ${refused}`, "warning");
      return;
    }
    const { lastMode: _left, ...rest } = this.active;
    this.active = { ...rest, ...modeSwitch(this.active, next) };
    this.publishActive();
    this.appendSwitch({ mode: next });
    this.publishWorkerModes();
    this.syncCreateGuideTool();
    if (orchestrates(next)) {
      if (this.active.strict) this.applyStrictTools();
      this.recomputeRoutes();
      this.syncHostSection();
      ctx.notify(`Mode: ${next}`, "info");
      await this.refreshRouting(ctx, true);
    } else {
      this.restoreTools();
      this.recomputeRoutes();
      this.syncHostSection();
      ctx.notify("Mode: normal", "info");
      if (this.probeWanted()) void this.refreshRouting(ctx, false);
      else this.dropProbe();
    }
  }

  /** Turn a built-in minor mode on or off (index.ts setMinor). */
  setMinor(minor: MinorMode, on: boolean, ctx: ModeCtx): void {
    this.enter(ctx);
    if (hasMinor(this.active, minor) === on) return;
    const refused = on ? webMinorRefusal(minor, ctx.sessionId()) : undefined;
    if (refused) {
      ctx.notify(`Minor mode ${minor} not turned on: ${refused}`, "warning");
      return;
    }
    this.active = withMinor(this.active, minor, on);
    this.publishActive();
    this.appendSwitch({ minor, on });
    this.publishWorkerModes();
    if (minor === "spec") this.recomputeRoutes();
    this.syncHostSection();
    if (minor === "align") this.syncAlignTool();
    if ((minor === "vis" || minor === "align") && !this.running) this.syncVisGuideTool();
    ctx.notify(`Minor mode: ${minor} ${on ? "on" : "off"}`, "info");
    if (minor === "spec") {
      if (this.probeWanted()) void this.refreshRouting(ctx, on);
      else this.dropProbe();
    }
  }

  /** Turn a project (or personal) mode on or off (index.ts setProject). */
  setProject(id: string, on: boolean, ctx: ModeCtx): void {
    this.enter(ctx);
    const current = projectModesOf(this.active).find((ref) => ref.id === id);
    if ((current !== undefined) === on) return;
    if (on) {
      const refuse = (why: string): void => {
        ctx.notify(`Minor mode ${id} not turned on: ${why}`, "warning");
      };
      if (this.workerRole) return refuse("a worker gets its project modes from the session that started it");
      // A chat without a checkout has only the listing's other folders (personal modes): any other id has nowhere to come from.
      if (this.listing.root === null && !this.listing.modes.some((m) => m.id === id) && !this.listing.problems.some((p) => p.id === id)) return refuse("this chat has no local checkout");
      const read = this.source.read(this.listing, id);
      const known = this.listing.modes.some((m) => m.id === id) || this.listing.problems.some((p) => p.id === id);
      this.listing = withListed(this.listing, read);
      if ("kind" in read) return refuse(read.kind === "no-entry" && !known ? `no project mode ${id} in ${this.listing.name}` : `${read.path}: ${read.error}`);
      if (read.toolsHash !== "" && !this.source.approved(this.listing, read)) return refuse(`${id} runs the project's own tools: approve it from a Sova chat's mode menu first`);
      if (!this.snapshots.has(read.sha)) {
        try {
          this.port.recordProjectCopy(read);
        } catch {
          return refuse("its copy couldn't be saved in this chat");
        }
        this.snapshots.set(read.sha, read);
      }
      this.active = withProjectMode(this.active, id, { id, sha: read.sha });
    } else {
      this.active = withProjectMode(this.active, id, undefined);
    }
    this.publishActive();
    this.appendSwitch({ project: id, on });
    this.publishWorkerModes();
    this.syncHostSection();
    if (!this.running) this.syncProjectTools();
    ctx.notify(`Minor mode: ${id} ${on ? "on" : "off"}`, "info");
  }

  /** Strict on or off (index.ts `/mode strict on|off`). */
  setStrict(strict: boolean, ctx: ModeCtx): void {
    this.enter(ctx);
    const changed = strict !== this.active.strict;
    if (changed) {
      this.active = { ...this.active, strict };
      this.publishActive();
      this.appendSwitch({ strict });
      if (orchestrates(this.active.mode)) {
        if (strict) this.applyStrictTools();
        else this.restoreTools();
      }
      this.syncHostSection();
    }
    const appliedNow = changed && orchestrates(this.active.mode);
    ctx.notify(`Strict mode ${strict ? "on" : "off"}${appliedNow ? ` (edit/write ${strict ? "removed from" : "restored to"} the orchestrator)` : ""}`, "info");
  }

  /** `/mode subagents <id|off>` (index.ts setSubagentProfile). */
  setSubagentProfile(arg: string, ctx: ModeCtx): void {
    this.enter(ctx);
    const { profiles: state } = this.readProfiles();
    if (state.state !== "ok") {
      ctx.notify(`Subagent profiles can't be used now: ${state.state === "malformed" ? `${state.file} is malformed` : "no profiles file"}.`, "warning");
      return;
    }
    const wanted = arg.toLowerCase();
    const id = wanted === OFF_PROFILE_ID ? OFF_PROFILE_ID : state.value.profiles.find((p) => p.id === arg || p.name.toLowerCase() === wanted)?.id;
    if (!id) {
      ctx.notify(`No subagent profile "${arg}". Profiles: off, ${state.value.profiles.map((p) => p.id).join(", ")}`, "warning");
      return;
    }
    this.refreshPick(ctx);
    let entry: { customType: string; data: unknown } | null = null;
    try {
      entry = ctx.branch.pickEntry(id);
    } catch {
      entry = null;
    }
    if (entry) this.port.recordPick(entry);
    this.pick = id;
    this.recomputeRoutes();
    this.syncHostSection();
    if (this.probeWanted()) void this.refreshRouting(ctx, true);
    ctx.notify(`Subagent profile: ${this.profileLine()}`, "info");
  }

  private profileLine(): string {
    const r = this.subagents();
    const from = r.source === "pick" ? "this chat's pick" : r.source === "default" ? "the default" : "the legacy settings files";
    return `${r.name} (${from})${r.note ? ` — ${r.note}` : ""}`;
  }

  /** `/mode sync`'s replacement: adopt the base options, write the block there, republish what workers get. */
  sync(get?: () => { sections?: Record<string, string> }): void {
    this.adoptHost(get);
    this.syncHostSection();
    this.publishWorkerModes();
  }

  /** The project mode ids `/mode <id>` may name bare: those on, and the listing's usable or broken ones. */
  private projectIds(): string[] {
    const ids = new Set<string>(projectModesOf(this.active).map((ref) => ref.id));
    for (const mode of this.listing.modes) ids.add(mode.id);
    for (const problem of this.listing.problems) ids.add(problem.id);
    return [...ids];
  }

  /** Completions for typed `/mode` (index.ts, without the terminal-only arguments). */
  modeCompletions(prefix: string): { value: string; label: string }[] | null {
    const minorItems = MINOR_MODES.flatMap((minor) => [minor, `${minor} on`, `${minor} off`]);
    const usableProjects = new Set<string>([...projectModesOf(this.active).map((ref) => ref.id), ...this.listing.modes.map((m) => m.id)]);
    const projectItems = [...usableProjects].flatMap((id) => [id, `${id} on`, `${id} off`]);
    const items = [...DEFAULT_MODES, "strict on", "strict off", "subagents", ...minorItems, ...projectItems]
      .filter((value) => value.startsWith(prefix.trim()))
      .map((value) => ({ value, label: value }));
    return items.length > 0 ? items : null;
  }

  /** The usage line typed `/mode` answers with (§chat.mode-menu/typed-commands). */
  modeUsage(): string {
    return `Usage: /mode [${DEFAULT_MODES.join("|")}|strict on|strict off|subagents <profile>|${MINOR_MODES.map((minor) => `${minor} [on|off]`).join("|")}|<project mode> [on|off]|${PROJECT_MODE_PREFIX}<project mode> [on|off]]`;
  }

  /** Typed `/mode <args>` (index.ts's handler; bare, `status` and `default` answer with the usage line). */
  async modeCommand(args: string, ctx: ModeCtx): Promise<void> {
    this.enter(ctx);
    const arg = args.trim();
    if (arg === "sync") {
      this.publishWorkerModes();
      return;
    }
    if (arg === "" || arg === "status" || arg === "default") {
      ctx.notify(this.modeUsage(), "warning");
      return;
    }
    const mode = parseMode(arg);
    if (mode !== undefined) return this.setMode(mode, ctx);
    const subagentsArg = /^subagents\s+(.+)$/.exec(arg);
    if (subagentsArg) return this.setSubagentProfile(subagentsArg[1]!.trim(), ctx);
    const strictToggle = /^strict\s+(on|off)$/.exec(arg);
    if (strictToggle) return this.setStrict(strictToggle[1] === "on", ctx);
    const minorToggle = /^([a-z-]+)(?:\s+(on|off))?$/.exec(arg);
    if (minorToggle && isMinorMode(minorToggle[1])) {
      const minor = minorToggle[1];
      const on = minorToggle[2] === undefined ? !hasMinor(this.active, minor) : minorToggle[2] === "on";
      return this.setMinor(minor, on, ctx);
    }
    const projectToggle = /^(\S+)(?:\s+(on|off))?$/.exec(arg);
    const projectId = projectToggle ? projectModeArg(projectToggle[1]!) : undefined;
    if (projectToggle && projectId !== undefined && (projectToggle[1]!.startsWith(PROJECT_MODE_PREFIX) || this.projectIds().includes(projectId))) {
      const isOn = projectModesOf(this.active).some((ref) => ref.id === projectId);
      return this.setProject(projectId, projectToggle[2] === undefined ? !isOn : projectToggle[2] === "on", ctx);
    }
    ctx.notify(`Unknown argument "${arg}". ${this.modeUsage()}`, "warning");
  }

  /** Typed `/align on|off` (the terminal's viewer, status and export are gone). */
  alignCommand(args: string, ctx: ModeCtx): void {
    this.enter(ctx);
    const arg = args.trim();
    if (arg === "on" || arg === "off") return this.setMinor("align", arg === "on", ctx);
    ctx.notify(`${arg === "" ? "" : `Unknown argument "${arg}". `}Usage: /align on|off`, "warning");
  }

  /** Typed `/review plan|implementation [al_N]` (index.ts). */
  reviewCommand(args: string, ctx: ModeCtx): void {
    const m = /^(plan|implementation|diff)(?:\s+(al_[1-9]\d*))?$/.exec(args.trim());
    if (!m) {
      ctx.notify("Usage: /review plan|implementation [al_N]", "warning");
      return;
    }
    if (!hasMinor(this.active, "align")) {
      ctx.notify("Review needs the align minor mode on (/align on)", "warning");
      return;
    }
    const phase: AlignReviewPhase = m[1] === "plan" ? "plan" : "diff";
    const open = openDocsOf(this.alignDocs);
    const id = m[2] ?? (open.length === 1 ? open[0]!.id : undefined);
    if (!id) {
      ctx.notify(open.length === 0 ? "No open alignment to review" : `Name the alignment: /review ${m[1]} ${open.map((d) => d.id).join(" | ")}`, "warning");
      return;
    }
    if (!this.alignDocs.some((d) => d.id === id)) {
      ctx.notify(`No alignment ${id} on this branch`, "warning");
      return;
    }
    this.port.sendUser(reviewRequestMessage(id, phase), !ctx.isIdle());
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  private syncProjectTools(): void {
    const want = new Map<string, ProjectModeSnapshot>();
    if (!this.workerRole) for (const copy of this.activeSnapshots()) for (const tool of copy.tools) want.set(projectToolName(copy.id, tool.name), copy);
    for (const [name, copy] of want) {
      if (this.registeredTools.get(name) !== copy.sha) {
        const projectRoot = this.source.projectRoot?.(copy, this.sessionCwd);
        const definition = projectToolDefinitions(copy, {
          ...(projectRoot !== undefined ? { projectRoot } : {}),
          cwd: () => this.sessionCwd,
          sandboxOn: () => this.sandboxOn,
          isOn: (id) => projectModesOf(this.active).some((ref) => ref.id === id && ref.sha === copy.sha),
        }).find((d) => d.name === name);
        try {
          if (definition) this.port.registerTool(definition);
          this.registeredTools.set(name, copy.sha);
        } catch {
          continue;
        }
      }
      this.syncTool(name, true);
    }
    const ours = new Set([...this.registeredTools.keys(), ...[...this.snapshots.values()].flatMap((copy) => copy.tools.map((tool) => projectToolName(copy.id, tool.name)))]);
    for (const name of ours) {
      if (want.has(name)) continue;
      this.syncTool(name, false);
      if (this.registeredTools.has(name) && this.registeredTools.get(name) !== "") {
        try {
          this.port.registerTool(withdrawnDefinition(name));
          this.registeredTools.set(name, "");
        } catch {
          // Its definition refuses on its own (isOn).
        }
      }
    }
  }

  private syncAlignTool(): void {
    this.syncTool(ALIGN_TOOL, hasMinor(this.active, "align"));
  }
  private syncVisGuideTool(): void {
    this.syncTool(VIS_GUIDE_TOOL_NAME, visToolsWanted(this.active.minorModes, this.alignVisuals));
  }
  private syncCreateGuideTool(): void {
    this.syncTool(CREATE_GUIDE_TOOL_NAME, this.active.mode === "create");
  }

  private syncTool(tool: string, want: boolean): void {
    try {
      const fix = (tools: string[]) => (want ? (tools.includes(tool) ? tools : [...tools, tool]) : tools.filter((t) => t !== tool));
      const current = this.port.activeTools();
      const next = fix(current);
      if (next.length !== current.length) this.port.setActiveTools(next);
      if (this.toolsSnapshot !== undefined) this.toolsSnapshot = fix(this.toolsSnapshot);
    } catch {
      // Before the session exists there is no loadout to change; session_start syncs it.
    }
  }

  private syncAlignForm(): void {
    const want = { review: this.reviewFlag, visual: this.alignVisuals };
    if (want.review === this.alignForm.review && want.visual === this.alignForm.visual) return;
    this.alignForm = want;
    this.port.registerAlign(want);
  }

  private registerReview(): void {
    if (this.reviewRegistered || !this.reviewFlag) return;
    this.reviewRegistered = true;
    this.onReviewNeeded?.();
  }

  // ── Restoring ────────────────────────────────────────────────────────────

  private restoreActiveState(reason: string | undefined, ctx: ModeCtx): void {
    let next = activeOf(loadState(this.stateFile));
    next = { ...next, minorModes: adoptableMinorModes(next.minorModes) };
    let restored: ModeActive | undefined;
    try {
      restored = this.workerRole ? undefined : ctx.branch.active();
    } catch {
      restored = undefined;
    }
    if (this.workerRole) {
      // As index.ts builds it (no `version`: activeOf adds it wherever the state is published or written).
      next = { mode: "normal", strict: false, minorModes: workerMinorModes(parseMinorFlag(this.port.flag("minor"))?.minorModes ?? []) } as ModeActive;
    } else if (restored !== undefined) {
      next = restored.mode === "create" && !insideSova() ? { ...restored, mode: "delegate" } : restored;
    } else if (reason === undefined || reason === "startup") {
      const flag = this.port.flag("major");
      if (isDefaultMode(flag)) next = { ...next, mode: flag };
      const minorFlag = parseMinorFlag(this.port.flag("minor"));
      if (minorFlag) {
        const webOnly = minorFlag.minorModes.filter((minor) => MINOR_SURFACES[minor] === "web");
        next = { ...next, minorModes: minorFlag.minorModes.filter((minor) => MINOR_SURFACES[minor] !== "web") };
        if (webOnly.length > 0) ctx.notify(`--minor ${webOnly.join(", ")}: ${webOnly.map((minor) => webMinorRefusal(minor, undefined)).join("; ")}`, "warning");
        if (minorFlag.unknown.length > 0) ctx.notify(`Unknown minor mode in --minor: ${minorFlag.unknown.join(", ")} (known: ${MINOR_MODES.join(", ")})`, "warning");
      }
    }
    try {
      this.snapshots = this.workerRole ? new Map() : ctx.branch.snapshots();
    } catch {
      this.snapshots = new Map();
    }
    const runnable = projectModesOf(next).filter((ref) => this.snapshots.has(ref.sha));
    next = runnable.length > 0 ? { ...next, projectModes: runnable } : withProjectMode(next, "", undefined);
    this.active = next;
    this.publishActive();
    this.publishWorkerModes();
    let restoredHead: ReturnType<ModeCtx["branch"]["head"]> = { head: undefined, told: undefined, guides: [] };
    try {
      if (!this.workerRole) restoredHead = ctx.branch.head();
    } catch {
      // An unreadable branch: the head follows the active set until the next run fixes it.
    }
    this.head = restoredHead.head;
    this.told = restoredHead.told ?? [...(this.head ?? [])];
    this.guides = restoredHead.guides;
    this.projectHead = this.head === undefined ? undefined : (restoredHead.projectHead ?? []);
    this.toldProjects = this.head === undefined ? [] : (restoredHead.projectTold ?? []);
    this.projectGuides = restoredHead.projectGuides ?? [];
    this.headStyle = restoredHead.headStyle;
    this.toldStyle = restoredHead.style?.told ?? this.headStyle;
    this.headEagerness = restoredHead.headEagerness;
    this.toldEagerness = restoredHead.eagerness?.told ?? this.headEagerness;
    if (orchestrates(this.active.mode) && this.active.strict) this.applyStrictTools();
    else this.restoreTools();
    this.syncAlignTool();
    this.syncVisGuideTool();
    this.syncCreateGuideTool();
    this.syncProjectTools();
    this.recomputeRoutes();
    this.syncHostSection();
    if (this.probeWanted()) void this.refreshRouting(ctx, false);
    else this.dropProbe();
  }

  private restoreAlign(ctx: ModeCtx): void {
    try {
      const fold = ctx.branch.align();
      this.alignDocs = fold.docs;
      this.legacyAlign = fold.legacy;
    } catch {
      this.alignDocs = [];
      this.legacyAlign = null;
    }
  }

  // ── pi's events, 1:1 with index.ts's handlers ────────────────────────────────

  sessionStart(reason: string | undefined, ctx: ModeCtx): void {
    this.running = false;
    let told = false;
    try {
      told = ctx.branch.procedureTold();
    } catch {
      told = false;
    }
    this.specCensus.reset(told);
    this.toldWriter = undefined;
    this.reviewFlag = this.port.flag(REVIEW_FLAG) === true;
    this.registerReview();
    this.refreshPick(ctx);
    const visualsFlag = this.port.flag(VISUALS_FLAG);
    this.alignVisuals = this.workerRole ? false : visualsFlag === "on" ? true : visualsFlag === "off" ? false : this.alignNow().visuals;
    this.syncAlignForm();
    this.sessionCwd = ctx.cwd();
    this.listing = this.workerRole ? { root: null, name: "", modes: [], problems: [] } : this.source.listing(ctx.cwd());
    this.restoreActiveState(reason, ctx);
    this.restoreAlign(ctx);
  }

  tree(ctx: ModeCtx): void {
    this.refreshPick(ctx);
    this.restoreActiveState("tree", ctx);
    this.restoreAlign(ctx);
  }

  shutdown(): void {
    this.dropProbe();
    this.alignDocs = [];
    this.legacyAlign = null;
  }

  beforeAgentStart(event: { prompt?: string; systemPrompt: string; sections?: Record<string, string> }, ctx: ModeCtx): BeforeStartResult | undefined {
    this.runUserAsked = /\?\s*$/.test(event.prompt ?? "");
    this.refreshPick(ctx);
    if (orchestrates(this.active.mode) || hasMinor(this.active, "spec")) {
      const { key } = this.probeScope();
      this.recomputeRoutes();
      if (this.probeWanted() && this.routingStale()) void this.refreshRouting(ctx, this.probedKey !== undefined && key !== this.probedKey);
    }
    this.fixHead();
    this.syncVisGuideTool();
    this.syncProjectTools();
    const modeNote = this.takeNote();
    if (modeNote) this.port.note(modeNote, true);
    const block = this.modeBlock();
    this.syncHostSection(block);
    const note = hasMinor(this.active, "align") ? alignStateNote(this.alignDocs) : undefined;
    const message: BeforeStartResult = note ? { message: { customType: ALIGN_STATE_MESSAGE, content: note, display: false } } : {};
    if (event.sections) {
      applyModeSection(event.sections, block);
      return note ? message : undefined;
    }
    if (block === undefined) return note ? message : undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}`, ...message };
  }

  async agentStart(ctx: ModeCtx): Promise<void> {
    if (!this.running) {
      this.refreshPick(ctx);
      this.recomputeRoutes();
      this.running = true;
      this.hoistedNotes.clear();
      this.hoistedProcedure.clear();
      if (this.specOn() && !this.censusOff()) await this.specCensus.prime(ctx.cwd());
      this.fixHead();
      const modeNote = this.takeNote();
      if (modeNote) this.port.note(modeNote, false);
    }
    this.syncHostSection();
  }

  toolExecutionStart(toolName: string, args: unknown): void {
    if (toolName === ALIGN_TOOL && marksChangeRequest(args)) this.runMarked = true;
  }

  /** index.ts's two tool_execution_end handlers, in their order: the align count, then the census close. */
  toolExecutionEnd(event: { toolName: string; toolCallId: string; isError?: boolean; result?: unknown }): void {
    if (event.toolName === ALIGN_TOOL && !event.isError) {
      const details = (event.result as { details?: { doc?: unknown; exempt?: unknown } } | undefined)?.details;
      if (details?.doc !== undefined || details?.exempt !== undefined) this.runAlignCalls++;
    }
    this.specCensus.close(event.toolCallId);
  }

  turnEnd(message: unknown): void {
    const m = message as { role?: string; content?: unknown } | undefined;
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return;
    const blocks = m.content as { type?: string; text?: string }[];
    this.lastReplyText = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }

  beforeSettle(event: { outcome?: string; entries: unknown[] }): SettleResult | undefined {
    if (!hasMinor(this.active, "align") || this.nudged || this.runAlignCalls > 0 || event.outcome !== "completed") return undefined;
    if (!this.runMarked && this.alignNow().eagerness === "careful") return undefined;
    if (!looksLikeUncapturedPlan(this.lastReplyText, { userAsked: this.runUserAsked })) return undefined;
    this.nudged = true;
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: ALIGN_NUDGE_MESSAGE, display: false, content: ALIGN_NUDGE_TEXT }],
      continue: true,
    };
  }

  agentSettled(): void {
    this.running = false;
    this.runAlignCalls = 0;
    this.lastReplyText = "";
    this.runUserAsked = false;
    this.runMarked = false;
    this.nudged = false;
    this.syncVisGuideTool();
    this.syncProjectTools();
  }

  compact(): void {
    const note = hasMinor(this.active, "align") ? alignStateNote(this.alignDocs, true) : undefined;
    if (note) this.port.note({ customType: ALIGN_STATE_MESSAGE, content: note, display: false }, false);
    this.head = undefined;
    this.told = [];
    this.guides = [];
    this.projectHead = undefined;
    this.toldProjects = [];
    this.projectGuides = [];
    this.headStyle = undefined;
    this.toldStyle = undefined;
    this.headEagerness = undefined;
    this.toldEagerness = undefined;
    this.specCensus.rearmProcedure();
    this.syncHostSection();
  }

  /** Whether the prompt head is fixed (the `context` filter drops pre-compaction notes only then; modes.ts). */
  headFixed(): boolean {
    return this.head !== undefined;
  }

  async toolCall(event: { toolCallId: string; toolName: string; input: unknown }, ctx: ModeCtx): Promise<void> {
    if (!this.workerRole) {
      try {
        ctx.branch.setAgreeSource(this.specOn());
      } catch {
        // Best-effort, as setAgreeSource is.
      }
    }
    if (!this.specOn() || this.censusOff()) return;
    await this.specWrites.before(event.toolCallId, { cwd: ctx.cwd(), toolName: event.toolName, input: event.input, signal: ctx.signal() });
    await this.specCensus.before({ id: event.toolCallId, cwd: ctx.cwd(), toolName: event.toolName, input: event.input, signal: ctx.signal() });
  }

  async toolResult(
    event: { toolCallId: string; toolName: string; input: unknown; content: unknown[]; parentToolCallId?: unknown; structuredContent?: unknown },
    ctx: ModeCtx,
  ): Promise<{ content: unknown[]; structuredContent?: unknown } | undefined> {
    if (!this.specOn() || this.censusOff()) return undefined;
    const { text: forbidden, lost } = await this.specWrites.after(event.toolCallId, { cwd: ctx.cwd(), toolName: event.toolName, input: event.input, signal: ctx.signal() });
    let commands: string[] = [];
    try {
      commands = ctx.branch.bashCommands();
    } catch {
      commands = [];
    }
    const { text: census, failure, procedure } = await this.specCensus.after({
      id: event.toolCallId,
      cwd: ctx.cwd(),
      orphansSaid: lost,
      toolName: event.toolName,
      input: event.input,
      signal: ctx.signal(),
      commands,
      sessionStart: ctx.sessionStartedAt(),
    });
    writeLanded(this.env[LANDED_FILE_ENV], this.specCensus.snapshot());
    const text = [forbidden, driftNote(event.toolName, event.input, event.content), census, failure].filter(Boolean).join("\n");
    const parent = event.parentToolCallId;
    if (typeof parent === "string" && text) this.hoistedNotes.set(parent, [...(this.hoistedNotes.get(parent) ?? []), text]);
    if (typeof parent === "string" && procedure) this.hoistedProcedure.set(parent, procedure);
    const hoisted = this.hoistedNotes.get(event.toolCallId);
    this.hoistedNotes.delete(event.toolCallId);
    const handedOver = this.hoistedProcedure.get(event.toolCallId) ?? procedure;
    this.hoistedProcedure.delete(event.toolCallId);
    const all = [[...new Set((hoisted ?? []).flatMap((t) => t.split("\n")))].join("\n"), text, handedOver ? `\n${handedOver}` : ""].filter(Boolean).join("\n");
    if (!all) return undefined;
    const structured = event.structuredContent;
    return { content: [...event.content, { type: "text" as const, text: all }], ...(structured !== undefined ? { structuredContent: structured } : {}) };
  }
}

/** The guide tools' names (vis-guide-tool.ts, create-guide-tool.ts); kept here so the engine imports no tool module. */
export const VIS_GUIDE_TOOL_NAME = "vis_guide";
export const CREATE_GUIDE_TOOL_NAME = "create_guide";
