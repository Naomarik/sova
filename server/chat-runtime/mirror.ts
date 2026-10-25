// What the server may read about a hosted chat without asking it (shared/chat-runtime.ts
// ChatStateMirror). In the server's process the mirror reads the chat as it is at each read
// (LiveMirror); a chat in its own process sends it as data (mirrorOf), whenever it changes.
import type { ChatStateMirror } from "../../shared/chat-runtime";
import type { HeldChatState } from "../../shared/protocol";
import type { ChatSession } from "../chat-manager";

/** The mirror of a chat in this process: every field read from the chat as it is now. */
export class LiveMirror implements ChatStateMirror {
  constructor(private readonly chat: ChatSession) {}
  get chatId() {
    return this.chat.path;
  }
  get sessionId() {
    return this.chat.harness.id;
  }
  get cwd() {
    return this.chat.harness.cwd;
  }
  get cwdFallback() {
    return this.chat.cwdFallback;
  }
  get closed() {
    return this.chat.disposed;
  }
  get special() {
    return this.chat.special;
  }
  get running() {
    return this.chat.harness.isRunning();
  }
  get compacting() {
    return this.chat.isCompacting();
  }
  get starting() {
    return this.chat.turnStarting;
  }
  get model() {
    const m = this.chat.harness.model();
    return m ? { ref: m.ref, provider: m.provider, images: m.images } : null;
  }
  get thinking() {
    return this.chat.harness.thinking();
  }
  get leafId() {
    return this.chat.leafId();
  }
  get lastStop() {
    const branch = this.chat.harness.branch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i]!;
      if (e.kind === "assistant") return e.stop ?? null;
    }
    return null;
  }
  get queue() {
    return { web: this.chat.queue.size, agent: this.chat.harness.queue.hasQueued() };
  }
  get dialogs() {
    return this.chat.pendingDialogs();
  }
  get mode() {
    const s = this.chat.modeState;
    return { mode: s.mode, minorModes: [...s.minorModes], strict: s.strict };
  }
  get held(): HeldChatState {
    const chat = this.chat;
    const s = chat.modeState;
    return {
      model: chat.harness.model()?.ref ?? null,
      thinking: chat.harness.thinking(),
      mode: s.mode,
      minorModes: [...s.minorModes],
      strict: s.strict,
      applies: chat.modeApplies,
      ...chat.saidState(),
    };
  }
  get memory() {
    return this.chat.memoryOffered() ? this.chat.memory.choiceNow() : null;
  }
  get streamTrip() {
    return this.chat.lastStreamTrip;
  }
  get foreignWrite() {
    return !!this.chat.foreignWrite;
  }
  get pendingSends() {
    return this.chat.hasPendingSends();
  }
  get pristine() {
    return this.chat.pristine;
  }
  get subagentPick() {
    return this.chat.subagentPick;
  }
  get profile() {
    return this.chat.profileState?.data ?? null;
  }
  get loadout() {
    const chat = this.chat;
    return chat.loadoutState ? { off: chat.loadoutState.data, toggleable: chat.loadoutToggleable } : null;
  }
  get attended() {
    return this.chat.userTurns?.attended() ?? false;
  }
  get confirmedCard() {
    return this.chat.userTurns?.confirmedCard() ?? null;
  }
}

/** The fields of a mirror, every one read once, now. */
const FIELDS = [
  "chatId", "sessionId", "cwd", "cwdFallback", "closed", "special", "running", "compacting", "starting", "model", "thinking", "leafId",
  "lastStop", "queue", "dialogs", "mode", "held", "memory", "streamTrip", "foreignWrite", "pendingSends", "pristine",
  "subagentPick", "profile", "loadout", "attended", "confirmedCard",
] as const satisfies readonly (keyof ChatStateMirror)[];
/** Every field of the mirror is in FIELDS (a field added to ChatStateMirror and left out fails here). */
const everyField: [Exclude<keyof ChatStateMirror, (typeof FIELDS)[number]>] extends [never] ? true : never = true;
void everyField;

/** The chat's mirror as plain data, read now (what a chat process sends its server). */
export function mirrorOf(chat: ChatSession): ChatStateMirror {
  const live = new LiveMirror(chat);
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = live[k];
  return out as unknown as ChatStateMirror;
}
