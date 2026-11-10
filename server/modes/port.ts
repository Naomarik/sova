// What Sova's mode engine (engine.ts) asks of the harness that hosts it. Harness-neutral: nothing here
// names pi. The pi adapter (server/harness/pi/modes.ts) implements both interfaces over pi's extension API
// and an event's context; raw session reads and entry writes happen only there.
import type { AlignDocument, LegacyAlignDoc } from "../../pi-config/extensions/mode/align.ts";
import type { DelegateBackend } from "../../pi-config/extensions/mode/delegate.ts";
import type { ProjectModeSnapshot } from "../../pi-config/extensions/mode/project-format.ts";
import type { Discovery } from "../../pi-config/extensions/mode/routing.ts";
import type { ModeActive, ModeHead, ModeHeadRecord, ModeNoteDetails } from "../../pi-config/extensions/mode/state.ts";
import type { AlignToolForm } from "../../pi-config/extensions/mode/align-tool.ts";

/** A hidden custom message the engine sends the model (mode-note, align-state). */
export interface HiddenNote {
  customType: string;
  content: string;
  display: false;
  details?: ModeNoteDetails;
}

/** The session's branch, read through the same readers the mode extension uses. Each call reads it now; any may throw (no branch). */
export interface ModeBranch {
  active(): ModeActive | undefined;
  head(): ModeHead;
  snapshots(): Map<string, ProjectModeSnapshot>;
  align(): { docs: AlignDocument[]; legacy: LegacyAlignDoc | null };
  pick(): string | undefined;
  /** The `subagent-profile` entry that pins `profile`, or null when the branch already does. */
  pickEntry(profile: string): { customType: string; data: unknown } | null;
  procedureTold(): boolean;
  bashCommands(): string[];
  /** Where a spec `agree` run now says its go-ahead came from (spec-agree.ts), for this branch. */
  setAgreeSource(specOn: boolean): void;
}

/** One event's context: what the hub's handlers read from pi's ctx. */
export interface ModeCtx {
  sessionId(): string | undefined;
  cwd(): string;
  signal(): AbortSignal | undefined;
  /** Best-effort; never throws. */
  notify(text: string, level: "info" | "warning"): void;
  isIdle(): boolean;
  branch: ModeBranch;
  sessionStartedAt(): string | undefined;
  /** The base prompt options' getter when this context is a command's (adopted, see ModeEngine.adoptHost). */
  hostOptions(): (() => { sections?: Record<string, string> }) | undefined;
  /** Discover one backend's models (the Delegate probe). */
  discover(backend: DelegateBackend): Promise<Discovery>;
}

/** The runtime the engine lives in: entries, messages, tools, flags and the bus. */
export interface ModePort {
  /** The `mode` entry of a switch. */
  recordSwitch(data: unknown): void;
  /** The `mode-head` record. */
  recordHead(data: ModeHeadRecord): void;
  /** A project mode's saved copy (`mode-project-snapshot`). */
  recordProjectCopy(copy: ProjectModeSnapshot): void;
  /** The subagent-profile pick entry the branch reader made (ModeBranch.pickEntry). */
  recordPick(entry: { customType: string; data: unknown }): void;
  /** The model policy read now, as a denial check (subagents/policy.ts). */
  denial(): (choice: { backend: DelegateBackend; model: string }) => string | null;
  /** A hidden message: queued for the next turn, or sent now (steered ahead of a run's first request). */
  note(message: HiddenNote, nextTurn: boolean): void;
  sendUser(text: string, followUp: boolean): void;
  activeTools(): string[];
  setActiveTools(names: string[]): void;
  /** (Re-)register the align tool in this form. */
  registerAlign(form: AlignToolForm): void;
  /** Register a project tool definition (project-tools.ts). */
  registerTool(definition: unknown): void;
  emit(event: string, data: unknown): void;
  on(event: string, listener: (data: unknown) => void): void;
  flag(name: string): unknown;
}
