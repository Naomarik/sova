// One steer handed to pi, taken back out on its own (quirk P29 steer-remove, QUIRKS.md;
// §chat.transcript/a-queued-message). pi can only clear its queues whole (`clearQueue()`), so this reaches
// in: the agent's real steering lane (`Agent.steeringQueue.messages`, what the loop drains) and the
// session's text mirror of it (`AgentSession._steeringMessages`, what `clearQueue()` hands back and what
// `message_start` splices by text). Both are spliced in one synchronous step, so the mirror stays at
// least as long as the lane and a Stop after a removal never hands the removed text back.
//
// Identity: pi's `_queueSteer` pushes the mirror's text, announces it (`queue_update`) and hands the
// message object to `agent.steer` in one synchronous block. A wrap of `agent.steer` (one per agent,
// after the call) sees that object; the ticket whose async context the call runs in claims the first one
// (as UserTurns and SendKeys tell a user message, quirk P7). A steer another sender queues meanwhile runs
// in its own context and is never the ticket's; a second steer inside the ticket's own context makes it
// `unknown` (refused, never guessed). Pi-free at load.
import { AsyncLocalStorage } from "node:async_hooks";
import type { SteerTicket } from "../../../shared/harness";

/** The pi objects reached, structurally. */
interface PiAgentLike {
  steer(message: unknown): void;
}
interface PiSessionLike {
  agent: PiAgentLike;
}

const handing = new AsyncLocalStorage<PiSteerTicket>();
const tapped = new WeakSet<object>();

/** Wrap `agent.steer` once: after pi queued a message, the ticket whose hand-off it belongs to sees it. */
export function tapSteers(agent: PiAgentLike): void {
  if (tapped.has(agent)) return;
  tapped.add(agent);
  const sink = agent as unknown as Record<"steer", (...args: unknown[]) => unknown>;
  const inner = sink.steer!;
  sink.steer = (...args: unknown[]) => {
    const out = inner.apply(agent, args);
    handing.getStore()?.queued(args[0]);
    return out;
  };
}

/** The agent's real steering lane, read fresh (pi reassigns the array on every drain); null if pi reshaped it. */
function laneOf(agent: PiAgentLike): unknown[] | null {
  const lane = (agent as unknown as { steeringQueue?: { messages?: unknown } }).steeringQueue?.messages;
  return Array.isArray(lane) ? lane : null;
}

/** The session's text mirror of the steering lane; null if pi reshaped it. */
function mirrorOf(session: PiSessionLike): string[] | null {
  const mirror = (session as unknown as { _steeringMessages?: unknown })._steeringMessages;
  return Array.isArray(mirror) ? (mirror as string[]) : null;
}

/** The text pi's mirror holds for a message: its text blocks joined (pi's `contentText(content, "")`). */
function mirrorText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && (c as { type?: unknown }).type === "text").map((c) => String((c as { text?: unknown }).text ?? "")).join("");
}

/**
 * Take `message` out of both of pi's copies, synchronously. `taken`: the lane no longer holds that very
 * object (the loop drained it, or a clear did); `unknown`: pi's shape is not the one this reads.
 */
export function takeSteerOut(session: PiSessionLike, message: object): "removed" | "taken" | "unknown" {
  const lane = laneOf(session.agent);
  const mirror = mirrorOf(session);
  if (!lane || !mirror) return "unknown";
  const i = lane.indexOf(message);
  if (i < 0) return "taken";
  lane.splice(i, 1);
  // The mirror holds texts only: any entry with this text stands for it (equal texts are interchangeable
  // there, and message_start splices them by text too).
  const j = mirror.lastIndexOf(mirrorText(message));
  if (j >= 0) mirror.splice(j, 1);
  // pi's own announcement, so its listeners (Sova's queue, extensions) see the shorter queue.
  (session as unknown as { _emitQueueUpdate?: () => void })._emitQueueUpdate?.();
  return "removed";
}

class PiSteerTicket implements SteerTicket {
  private message: object | null = null;
  private pushes = 0;
  private settled = false;
  private wanted = false;
  private removed = false;

  constructor(private readonly session: PiSessionLike) {}

  run<T>(handOff: () => T): T {
    tapSteers(this.session.agent);
    let out: T;
    try {
      out = handing.run(this, handOff);
    } catch (err) {
      this.settled = true;
      throw err;
    }
    const done = () => {
      this.settled = true;
      // A removal asked for while the hand-off ran: now its pushes are all known. Exactly one is this
      // hand-off's own message; any other count (an input handler's own steer pushed in this context
      // too, or nothing) names no one message, and nothing is spliced.
      if (this.wanted && this.pushes === 1 && this.message) this.removed = takeSteerOut(this.session, this.message) === "removed";
    };
    if (out && typeof (out as { then?: unknown }).then === "function") (out as unknown as Promise<unknown>).then(done, done);
    else done();
    return out;
  }

  /** pi queued `message` inside this ticket's hand-off (tapSteers). */
  queued(message: unknown): void {
    this.pushes++;
    if (this.pushes !== 1 || !message || typeof message !== "object") return;
    // Only recorded, even when a removal is waiting: the first push in this context may be an input
    // handler's own steer, so nothing is taken out before the hand-off settles (run's `done`).
    this.message = message;
  }

  remove(): "removed" | "later" | "taken" | "unknown" {
    if (this.removed) return "removed";
    if (!this.settled) {
      this.wanted = true;
      return "later";
    }
    if (this.pushes !== 1 || !this.message) return "unknown";
    const out = takeSteerOut(this.session, this.message);
    if (out === "removed") this.removed = true;
    return out;
  }
}

/** A ticket for the next steer handed to `session` (HarnessQueue.steerTicket). */
export function steerTicket(session: PiSessionLike): SteerTicket {
  return new PiSteerTicket(session);
}
