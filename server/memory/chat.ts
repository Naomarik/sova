// A held chat's memory (§chat/memory): its choice, its engine (made on first use), and the status every tab
// of the chat hears. The ChatSession that holds it hands it plain readers; nothing here reaches pi.
import type { HEntry } from "../../shared/harness";
import type { ChatMemoryChoice, ChatServerMessage, MemoryLine, MemoryOutline, MemoryStatus, MemoryType, WorkerChoice } from "../../shared/protocol";
import { readModelPolicy, modelDenial } from "../model-policy";
import { claudeLoginEnv } from "../claude-accounts";
import { getModelRuntime } from "../harness/pi/open";
import type { LlmRuntime } from "../decide-llm";
import type { MemoryChoiceData } from "../harness/state-kinds";
import { MemoryEngine } from "./engine";
import { choiceOf, memorySettingsReader } from "./settings";
import { MemoryStore, memoryDir } from "./store";
import { summarize, type SummaryCall, type SummaryResult } from "./summarizer";
import type { NodeRef } from "./tree";

let reader: (() => ReturnType<ReturnType<typeof memorySettingsReader>>) | undefined;
/** Made on first use: this module sits in an import cycle with the mode state, so nothing runs at load. */
const settings = () => (reader ??= memorySettingsReader())();

/** The summarizer as every chat runs it: Settings → Memory, the model policy, this host's Claude login. */
export function summarizeForChat(call: SummaryCall): Promise<SummaryResult> {
  return summarize(call, {
    settings,
    denied: (c: WorkerChoice) => modelDenial(readModelPolicy(), c.backend === "pi" ? c.model : `claude-code/${c.model}`),
    env: claudeLoginEnv,
    runtime: () => getModelRuntime() as unknown as Promise<LlmRuntime>,
  });
}

export interface ChatMemoryDeps {
  sessionId(): string;
  cwd(): string | undefined;
  /** The active branch, as neutral history. */
  branch(): HEntry[];
  /** The branch's newest memory record (the MEMORY state kind), or null. */
  record(): MemoryChoiceData | null;
  /** Whether memory is on: the chat's minor modes, or the Overseer's own switch. */
  on(): boolean;
  send(msg: ChatServerMessage): void;
  summarize?(call: SummaryCall): Promise<SummaryResult>;
}

/** How often a status that only counts (preparing n of m, background) is sent again. */
const STATUS_THROTTLE_MS = 400;

export class ChatMemory {
  private engineRef: MemoryEngine | undefined;
  private lastSent: string | undefined;
  private lastState: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: ChatMemoryDeps) {}

  /** This chat's choice: its record, else the saved default. */
  choiceNow(): ChatMemoryChoice {
    return choiceOf(this.deps.record());
  }

  choice(): { on: boolean; type: MemoryType; size: number } {
    return { on: !this.disposed && this.deps.on(), ...this.choiceNow() };
  }

  engine(): MemoryEngine {
    if (!this.engineRef) {
      this.engineRef = new MemoryEngine(this.deps.sessionId(), new MemoryStore(memoryDir(this.deps.sessionId())), {
        summarize: this.deps.summarize ?? summarizeForChat,
        onStatus: () => this.statusChanged(),
        ...(this.deps.cwd() ? { cwd: this.deps.cwd() } : {}),
      });
    }
    return this.engineRef;
  }

  /** Memory was just turned on: summarize what the chat already has, in the background. */
  turnedOn(): void {
    const e = this.engine();
    e.sync(this.deps.branch());
    e.startPreparing();
    this.statusChanged(true);
  }

  /** Off, or the switch flipped: tell every tab. */
  changed(): void {
    this.statusChanged(true);
  }

  status(): MemoryStatus {
    if (!this.deps.on()) return { state: "off" };
    return this.engine().status();
  }

  statusMessage(): ChatServerMessage {
    return { type: "memory_status", status: this.status() };
  }

  private statusChanged(now = false): void {
    if (this.disposed) return;
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastSent) return;
    // A chat whose memory was never on hears nothing: no message means off.
    if (this.lastSent === undefined && status.state === "off") return;
    if (now || status.state !== this.lastState) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), STATUS_THROTTLE_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastSent) return;
    this.lastSent = json;
    this.lastState = status.state;
    this.deps.send({ type: "memory_status", status });
  }

  /** GET /api/memory for this chat (§chat.memory/status). */
  outline(): MemoryOutline {
    const c = this.choice();
    const e = this.engine();
    e.sync(this.deps.branch());
    const view = c.type === "uniichat" ? e.currentView() : zoomableLines(this.deps.branch());
    return {
      on: c.on,
      type: c.type,
      size: c.size,
      status: this.status(),
      messages: e.messages.length,
      bytes: e.viewBytesOf(view),
      lines: view.map((r): MemoryLine => e.memoryLine(r)),
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.engineRef?.dispose();
  }
}

/** The lines the newest zoomable compaction on a branch left (its details' `sovaMemory.lines`), else none. */
export function zoomableLines(branch: readonly HEntry[]): NodeRef[] {
  for (let k = branch.length - 1; k >= 0; k--) {
    const h = branch[k]!;
    if (h.kind !== "compaction") continue;
    const m = (h.details as { sovaMemory?: { v?: unknown; lines?: unknown } } | undefined)?.sovaMemory;
    if (m?.v === 1 && Array.isArray(m.lines) && m.lines.every((r) => Array.isArray(r) && r.length === 2 && r.every((x) => Number.isInteger(x) && x >= 0)))
      return m.lines as NodeRef[];
    return [];
  }
  return [];
}
