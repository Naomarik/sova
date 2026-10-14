// The commands a hosted chat takes (shared/chat-runtime.ts ChatMethods), each run on the chat itself.
// One table for both places a chat runs: server/chat-handle.ts runs it for a chat in the server's
// process, server/chat-runtime/host.ts for the chat a chat process hosts, answering its socket's calls.
import { randomUUID } from "node:crypto";
import type { ChatCall, ChatMethod, ChatMethods, ChatRefusal, ChatReply, ChatSendReceipt, ChatTurnEnd } from "../../shared/chat-runtime";
import type { StateKind } from "../../shared/harness";
import { acquireChat, assertNotLive, BusyError, type ChatSession, ConfigError, drainQueueThenAbort, emitChatEvent, markRunResuming, ModeRefusedError, RefusedError } from "../chat-manager";
import { stateKindOf } from "../harness/state-kinds";
import { mergeMode } from "../mode-state";

/** A typed refusal for an error the chat threw, or null for any other error. */
export function refusalOf(err: unknown): ChatRefusal | null {
  if (err instanceof BusyError) return { kind: "busy", code: err.code, message: err.message };
  if (err instanceof RefusedError) return { kind: "refused", mode: err instanceof ModeRefusedError, message: err.message };
  if (err instanceof ConfigError) return { kind: "config", cwd: err.cwd, message: err.message };
  return null;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const kindOf = (type: string): StateKind<unknown> => {
  const kind = stateKindOf(type);
  if (!kind) throw new Error(`Unknown state kind: ${type}`);
  return kind;
};

/** What one chat's commands share: its tracked turns, until each is asked for once (a keyed one:
    until KEPT_MS after it ended, however often it is asked), and the receipts of its keyed sends
    (KEYS_MAX, each for KEPT_MS). */
export interface CallCtx {
  turns: Map<string, Promise<ChatTurnEnd>>;
  /** A keyed send's key → its first receipt, oldest first. */
  keys?: Map<string, { receipt: ChatSendReceipt; at: number }>;
  /** A keyed, tracked turn → when it ended (null: still running). */
  kept?: Map<string, { endedAt: number | null }>;
  now?: () => number;
}

/** How long a keyed send's receipt, and its tracked turn's end, are kept (al_3 stage 3 §5.1). */
export const KEPT_MS = 60 * 60_000;
/** Keyed sends remembered per chat. */
export const KEYS_MAX = 256;

/** Forget keys and kept turns older than KEPT_MS. */
function prune(ctx: CallCtx, now: number): void {
  for (const [key, k] of ctx.keys ?? []) if (now - k.at >= KEPT_MS) ctx.keys!.delete(key);
  for (const [turnId, k] of ctx.kept ?? [])
    if (k.endedAt !== null && now - k.endedAt >= KEPT_MS) {
      ctx.kept!.delete(turnId);
      ctx.turns.delete(turnId);
    }
}

type Impl = { [M in ChatMethod]: (chat: ChatSession, args: ChatMethods[M]["args"], ctx: CallCtx) => ChatMethods[M]["result"] | Promise<ChatMethods[M]["result"]> };

/** Each command, run on the chat. A method that throws a refusal answers with that refusal. */
export const METHODS: Impl = {
  send(chat, a, ctx) {
    // A send delivered again under its key (a retry after a lost reply, an invocation resumed after a
    // server restart): the first receipt, and no second turn.
    const now = (ctx.now ?? Date.now)();
    prune(ctx, now);
    const known = a.key !== undefined ? ctx.keys?.get(a.key) : undefined;
    if (known) return known.receipt;
    if (a.checkModel) chat.assertModelAllowed();
    // The next run names the tag, unless the chat refuses this message.
    const tagWas = chat.runTag.next;
    if (a.runTag !== undefined) chat.runTag.next = a.runTag;
    let accepted: ReturnType<ChatSession["acceptPrompt"]>;
    try {
      accepted = chat.acceptPrompt(a.text, a.images, a.origin ?? "server", a.clientId, {
        ...(a.replay ? { replay: true } : {}),
        ...(a.sentByOverseer ? { sentByOverseer: a.sentByOverseer } : {}),
        ...(a.sentByBaton ? { sentByBaton: a.sentByBaton } : {}),
        ...(a.sentBySession ? { sentBySession: a.sentBySession } : {}),
        ...(a.delivery ? { delivery: a.delivery } : {}),
        ...(a.confirm ? { confirm: a.confirm } : {}),
        ...(a.byPerson ? { byPerson: true as const } : {}),
      });
    } catch (err) {
      if (a.runTag !== undefined) chat.runTag.next = tagWas;
      throw err;
    }
    const { queued, turn } = accepted;
    const report = a.report !== false;
    const ended = turn.then(
      (): ChatTurnEnd => ({ ok: true }),
      (err): ChatTurnEnd => {
        if (report) chat.reportTurnFailure(err);
        return { ok: false, error: errorText(err) };
      },
    );
    let receipt: ChatSendReceipt = { queued, turnId: null };
    if (a.track && !queued) {
      const turnId = randomUUID();
      ctx.turns.set(turnId, ended);
      if (a.key !== undefined) {
        const kept = { endedAt: null as number | null };
        (ctx.kept ??= new Map()).set(turnId, kept);
        void ended.then(() => (kept.endedAt = (ctx.now ?? Date.now)()));
      }
      receipt = { queued, turnId };
    }
    if (a.key !== undefined) {
      const keys = (ctx.keys ??= new Map());
      keys.set(a.key, { receipt, at: now });
      while (keys.size > KEYS_MAX) keys.delete(keys.keys().next().value!);
    }
    return receipt;
  },
  turnEnd(_chat, { turnId }, ctx) {
    prune(ctx, (ctx.now ?? Date.now)());
    const ended = ctx.turns.get(turnId);
    if (!ended) throw new Error("That turn is not tracked.");
    // A keyed turn's end answers every ask (a retry after a lost reply, a resumed invocation)
    // until it is pruned; any other turn's, the first.
    if (!ctx.kept?.has(turnId)) ctx.turns.delete(turnId);
    return ended;
  },
  assertModelAllowed: (chat) => (chat.assertModelAllowed(), null),
  deliverTopicBatch: (chat, batch) =>
    chat.deliverTopicBatch({
      ...batch,
      entered: () => emitChatEvent(chat.path, "topicEntered", batch.batch),
      gone: () => emitChatEvent(chat.path, "topicGone", batch.batch),
    }),
  deliverToAgent: (chat, { text }) => chat.deliverToAgent(text),
  setModel: async (chat, { ref, save }) => (await chat.setModelRef(ref, save === undefined ? {} : { save }), null),
  setThinking: (chat, { level, save }) => chat.setThinking(level, save === undefined ? {} : { save }),
  findModel: async (chat, { ref }) => {
    const found = await chat.harness.findModel(ref);
    return found.ok ? { ok: true } : { ok: false, error: found.error };
  },
  switchMode: (chat, { patch }) => chat.switchMode(patch),
  applyMode: (chat, { patch }) => chat.applyMode(mergeMode(chat.modeState, patch)),
  pinMode: (chat) => chat.pinMode(),
  saveModeDefault: (chat) => chat.saveModeDefault(),
  subagentProfileInfo: (chat) => chat.subagentProfileInfo(),
  subagentSwitchRefusal: (chat) => chat.subagentSwitchRefusal(),
  switchSubagentProfile: (chat, { id }) => chat.switchSubagentProfile(id),
  appendStateRow: (chat, { kind, data }) => chat.appendStateRow(kindOf(kind), data),
  appendState: (chat, { kind: type, data }) => {
    // The kind the registry has under that type: SessionState refuses any other (server/harness/pi/state.ts).
    const kind = kindOf(type);
    return chat.harness.state.append(kind, data);
  },
  appendNote: (chat, { noteType, text, display }) => chat.appendNote(noteType, text, display),
  writeProfile: (chat, { data }) => (chat.writeProfile(data), null),
  writeLoadout: (chat, { data }) => (chat.writeLoadout(data), null),
  flushDeferredAppends: (chat) => (chat.flushDeferredAppends(), null),
  checkWrites: (chat) => chat.hasForeignWrites(),
  assertNoForeignWrites: (chat) => (chat.assertNoForeignWrites(), null),
  answerDialog: (chat, { id, value, answer, overseerId }) => (chat.answerDialog(id, value, answer, overseerId), null),
  drainAndAbort: async (chat) => (await drainQueueThenAbort(chat.harness, (m) => chat.broadcast(m), chat.queue), null),
  abort: async (chat) => (await chat.harness.abort(), null),
  interruptKeepingQueued: (chat) => chat.interruptKeepingQueued(),
  branch: (chat) => [...chat.harness.branch()],
  entries: (chat) => [...chat.harness.entries()],
  fileState: (chat, { kinds }) => {
    const file = chat.state.file();
    return kinds.flatMap((kind) => file.written(kindOf(kind)).map((r) => r.data));
  },
  activeTools: (chat) => chat.harness.activeTools(),
  setActiveTools: (chat, { names }) => (chat.harness.setActiveTools(names), null),
  declaredTools: (chat) => chat.harness.declaredTools(),
  resources: (chat) => {
    const loadout = chat.harness.resources();
    const base = chat.loadoutState;
    return {
      ...loadout,
      ...(base?.baseContext ? { context: base.baseContext.map((path) => ({ path })) } : {}),
      ...(base?.baseSkills ? { skills: base.baseSkills } : {}),
    };
  },
  memoryOutline: (chat) => (chat.memoryAvailable() ? chat.memory.outline() : null),
  memoryOpen: (chat, { id, n }) => {
    if (!chat.memoryAvailable()) return { state: "unavailable" };
    let engine;
    try {
      engine = chat.memory.engine();
    } catch {
      return { state: "no-engine" };
    }
    try {
      return { state: "ok", open: engine.open(id, n) };
    } catch (err) {
      return { state: "refused", error: errorText(err) };
    }
  },
  memoryStatus: (chat) => chat.memory.status(),
  memorySettingsChanged: (chat, { turnedOn }) => {
    if (turnedOn) chat.memory.turnedOn();
    else chat.memory.changed();
    chat.memorySwitched();
    return null;
  },
  sandboxInfo: (chat) => chat.sandboxInfo(),
  applySandbox: (chat, { state }) => chat.applySandbox(state),
  resumeWorker: (chat, { id }) => chat.resumeWorker(id),
  workerInfo: (chat, { id }) => chat.workerInfo(id),
  // In the server's process the provider bounds its own idle children: nothing to let go here.
  releaseIdleModelChild: () => "none",
  // acquireChat's own path for a chat it holds: the same guards, the same reload.
  reacquire: async (chat, { force }) => {
    assertNotLive(chat.path);
    if (!chat.hasForeignWrites()) return "ok";
    if (!force) throw new BusyError(chat.busyMessage(), "recent");
    await acquireChat(chat.path, true);
    return "reloaded";
  },
  // Whatever records this process's runs: the server's run ledger, or a chat process's marker.
  markResuming: (chat) => (markRunResuming(chat.path), null),
  // A worker chat's feed ring is its process's (host.ts); a chat in this process keeps none.
  feedSince: () => ({ gap: true }),
};

/** The reply a call that threw answers with: its typed refusal, or an error with its message. A
    caller on the other side of a socket throws it again as `errorOfRefusal(refusal)`, or an Error. */
export function failureReply(id: string, err: unknown): ChatReply {
  const refusal = refusalOf(err);
  return refusal ? { id, ok: false, refusal } : { id, ok: false, error: { message: errorText(err) } };
}

/** Run one call on the chat. */
export function runMethod<M extends ChatMethod>(chat: ChatSession, call: ChatCall<M>, ctx: CallCtx): ChatMethods[M]["result"] | Promise<ChatMethods[M]["result"]> {
  return (METHODS[call.method] as (c: ChatSession, a: ChatMethods[M]["args"], x: CallCtx) => ChatMethods[M]["result"] | Promise<ChatMethods[M]["result"]>)(chat, call.args, ctx);
}
