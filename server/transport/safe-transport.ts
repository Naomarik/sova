// Safe Transport (§app.transport/safe-transport): bringing a chat's busy helpers to rest before a
// Move's switch. The source side only: the switch (server/transport/switch.ts) calls
// bringHelpersToRest first and packs once it resolves. Safe: every coordinator of a team with work
// going on, and every working helper with no coordinator, is told to wrap up at once and go idle;
// the Move waits until none works, its progress read as "Waiting for {n} helpers to finish".
// Interrupt: every working helper is stopped at once (its turn aborted, its chat kept), and it
// arrives marked Interrupted and told to continue. A wait under way can be turned into an interrupt
// (Interrupt and Move beside the waiting line). Everything here reads and acts through SafeDeps, so
// the rule is tested on its own; server/transport/agent-wire.ts gives the live ones.

/** One helper of the chat, as the rule sees it. */
export interface HelperView {
  /** Its id in the chat (ag_NN). */
  workerId: string;
  /** Its own chat (the worker session's id): what a message or an abort goes to. */
  chatId: string;
  /** What the dialog calls it: its team role, else its id. */
  name: string;
  working: boolean;
  /** The team it belongs to, if any. */
  teamId?: string;
  /** Its standing duty in that team. */
  duty?: "coordinator" | "monitor";
}

export interface SafeDeps {
  /** The chat's helpers whose records have not ended. */
  helpers(chatId: string): Promise<HelperView[]>;
  /** Tell a helper something now (a steer: it reads it at its next step, or starts a turn if idle). */
  tell(helperChatId: string, text: string, key: string): Promise<void>;
  /** Stop a helper's turn at once (its chat stays). */
  abort(helperChatId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** How often the wait reads the helpers again. */
export const POLL_MS = 1_000;
/** An interrupt's aborts settle within this, else the Move goes on with what it has. */
export const INTERRUPT_SETTLE_MS = 30_000;

/** What a coordinator is told (Safe Transport). */
export const COORDINATOR_WRAP_UP =
  "Sova: the user is moving this chat to another device. Wrap up at once: tell every working teammate to finish the step it is in and end its turn without starting anything new, start nothing new yourself, and end your turn once they are idle. The team carries on on the other device.";
/** What a helper with no coordinator is told (Safe Transport). */
export const HELPER_WRAP_UP =
  "Sova: the user is moving this chat to another device. Wrap up at once: finish the step you are in, start nothing new, and end your turn. You carry on on the other device.";

/** What a helper hears on arrival (§app.transport/switch): interrupted ones are told to continue. */
export function arrivalNote(device: string, interrupted: boolean): string {
  return interrupted
    ? `This chat moved to ${device} while you were working, and your turn was interrupted (Interrupt and Move). Folders and ports may differ here. Continue where you stopped.`
    : `This chat moved to ${device}. Folders and ports may differ here. Continue where you left off.`;
}

/** The dialog's Busy helpers list (§app.transport/dialog): the helpers working now. Pure. */
export const busyOf = (helpers: readonly HelperView[]): HelperView[] => helpers.filter((h) => h.working);

/**
 * Who Safe Transport tells to wrap up, and with what (§app.transport/safe-transport): the coordinator
 * of each team that has a working member (itself included), and each working helper whose team has no
 * live coordinator or who is in none. A team whose members are all idle is left alone. Pure.
 */
export function wrapUpTargets(helpers: readonly HelperView[]): { helper: HelperView; text: string }[] {
  const coordinators = new Map<string, HelperView>();
  for (const h of helpers) if (h.teamId && h.duty === "coordinator") coordinators.set(h.teamId, h);
  const out = new Map<string, { helper: HelperView; text: string }>();
  for (const h of helpers) {
    if (!h.working) continue;
    const c = h.teamId ? coordinators.get(h.teamId) : undefined;
    if (c) out.set(c.chatId, { helper: c, text: COORDINATOR_WRAP_UP });
    else out.set(h.chatId, { helper: h, text: HELPER_WRAP_UP });
  }
  return [...out.values()];
}

export interface RestResult {
  /** The helpers stopped mid-turn (Interrupt and Move): they arrive marked Interrupted and are told to continue. */
  interrupted: string[];
  /** The helpers that were working when the Move began and wrapped up on their own: they resume there with a note. */
  wrapped: string[];
  /** Helpers still working after an interrupt's aborts had INTERRUPT_SETTLE_MS to settle: the switch stops them hard or refuses. */
  stillWorking: string[];
}

interface Waiting {
  interrupt: boolean;
  wake: (() => void) | null;
}
const waiting = new Map<string, Waiting>();

/** Interrupt and Move pressed while the Move waits on chat `chatId`'s helpers: the wait stops them at
    once. False: no wait under way for that chat. */
export function interruptWaiting(chatId: string): boolean {
  const w = waiting.get(chatId);
  if (!w) return false;
  w.interrupt = true;
  w.wake?.();
  return true;
}

/** Whether a Move of chat `chatId` is waiting on its helpers now. */
export const isWaiting = (chatId: string): boolean => waiting.has(chatId);

/**
 * Bring chat `chatId`'s helpers to rest for a Move's switch: `safe` tells them to wrap up and waits
 * until none works (onProgress with each new count, the first one at once); `interrupt` stops every
 * working one. Resolves with who was interrupted and who wrapped up. `signal` aborts the wait (the
 * transport was cancelled): it rejects, and nothing more is sent.
 */
export async function bringHelpersToRest(
  chatId: string,
  mode: "safe" | "interrupt",
  onProgress: (working: number) => void,
  deps: SafeDeps,
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<RestResult> {
  const now = opts.now ?? Date.now;
  if (waiting.has(chatId)) throw new Error("A Move of this chat is already waiting on its helpers.");
  const w: Waiting = { interrupt: mode === "interrupt", wake: null };
  waiting.set(chatId, w);
  const wrappedAt = new Set<string>();
  const interrupted = new Set<string>();
  let told = false;
  let last = -1;
  const progress = (n: number) => {
    if (n !== last) onProgress((last = n));
  };
  try {
    let interruptSince: number | null = null;
    for (;;) {
      opts.signal?.throwIfAborted();
      const all = await deps.helpers(chatId);
      const busy = busyOf(all);
      progress(busy.length);
      if (!busy.length) break;
      if (w.interrupt) {
        interruptSince ??= now();
        // An abort that never settles doesn't hold the Move for ever: who still works is said.
        if (now() - interruptSince > INTERRUPT_SETTLE_MS) return { interrupted: [...interrupted], wrapped: [...wrappedAt], stillWorking: busy.map((h) => h.workerId) };
        // Each poll: a helper busy again (a teammate's message, a wake right after its abort) is stopped again.
        for (const h of busy) {
          interrupted.add(h.workerId);
          wrappedAt.delete(h.workerId);
          await deps.abort(h.chatId).catch(() => undefined);
        }
      } else if (!told) {
        // Those working as the Move begins are the ones that resume there; one woken only to hear this stays idle.
        told = true;
        for (const h of busy) wrappedAt.add(h.workerId);
        for (const t of wrapUpTargets(all)) await deps.tell(t.helper.chatId, t.text, `transport-wrap-up:${chatId}:${t.helper.workerId}`).catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        w.wake = resolve;
        void deps.sleep(POLL_MS).then(resolve);
      });
      w.wake = null;
    }
    return { interrupted: [...interrupted], wrapped: [...wrappedAt], stillWorking: [] };
  } finally {
    waiting.delete(chatId);
  }
}
