/**
 * Sova's own event stream (§app/events): what `/ws/events` on the main listener sends. Types and
 * constants only, no imports: a script may load this file through Node's type stripping (erasable
 * syntax only).
 *
 * Frames are flat JSON objects. The first is `hello`; then `event` frames in `seq` order, with a
 * `gap` frame standing where some seqs can't be given. The socket is read-only.
 */

export const EVENTS_PATH = "/ws/events";

export const EVENT_NAMES = [
  "session.created",
  "session.removed",
  "session.renamed",
  "session.tagged",
  "session.archived",
  "turn.started",
  "turn.ended",
  "attention.changed",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** `hosted`: from a chat this server runs, exactly once per run. `observed`: the difference between
    two reads of the session list. */
export type EventSource = "hosted" | "observed";

/** A session's tags as the list carries them (structural, so a newer list fits). */
export interface EventTags {
  user?: string[];
  topic?: unknown;
  throwaway?: true;
}

interface Base {
  type: "event";
  seq: number;
  /** When this server recorded it, ms epoch. */
  at: number;
}
interface OfSession {
  id: string;
  path: string;
}

export type StreamEvent =
  | (Base & OfSession & { name: "session.created"; source: "observed"; title: string })
  | (Base & OfSession & { name: "session.removed"; source: "observed" })
  | (Base & OfSession & { name: "session.renamed"; source: "observed"; from: string; title: string })
  | (Base & OfSession & { name: "session.tagged"; source: "observed"; tags: EventTags | null })
  | (Base & OfSession & { name: "session.archived"; source: "observed"; archived: boolean })
  | (Base & OfSession & { name: "turn.started" | "turn.ended"; source: EventSource })
  | (Base & { name: "attention.changed" });

/** An event before the hub numbers it. */
export type StreamEventBody = StreamEvent extends infer E ? (E extends StreamEvent ? Omit<E, "type" | "seq" | "at"> : never) : never;

/** Seqs `from`..`to` (inclusive) this socket will never get: dropped because the socket fell behind
    (`overflow`), no longer kept (`evicted`), or a stretch when no one listened, so nothing was
    recorded (`unobserved`, always one seq: the stream's restart point). */
export interface GapFrame {
  type: "gap";
  reason: "overflow" | "evicted" | "unobserved";
  from: number;
  to: number;
}
/** The cursor names another stream (this server restarted): every kept event follows. */
export interface RestartedFrame {
  type: "gap";
  reason: "restarted";
}
export interface HelloFrame {
  type: "hello";
  /** This stream's id, new at each server start; a resume names it. */
  stream: string;
  /** The newest seq given out (0 before any). */
  seq: number;
  /** The oldest seq still kept (seq + 1 when none is). */
  oldest: number;
}
export interface EventsErrorFrame {
  type: "error";
  message: string;
}

/** What a socket opened with `?with=command.ran` asks for (§app.command-audit/record). */
export const COMMAND_RAN = "command.ran";
export const WITH_COMMANDS = "command.ran";

/**
 * A call a token holder made, as Sova recorded it (§app.command-audit/record): only to a socket that
 * asked (`?with=command.ran`). Live only: no `seq`, never kept, never replayed, so the stream's
 * events and their numbering are the same with it or without it. The caller is `chat:<id>`,
 * `unattributed` or `no-key`; the route is the server's pattern, never the request's path.
 */
export interface CommandFrame {
  type: "command";
  name: "command.ran";
  at: string;
  caller: string;
  command?: string;
  method: string;
  route: string;
  status: number;
}

export type EventsServerFrame = HelloFrame | StreamEvent | GapFrame | RestartedFrame | EventsErrorFrame | CommandFrame;

/** A stream id's shape. */
export const STREAM_ID_RE = /^[a-z0-9]{8,32}$/;
