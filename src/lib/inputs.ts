// The session pane's Timeline with "Inputs Only" on: this session's user messages on the active
// branch, each able to rewind the chat to just before it. Pure decisions only — which rows, when a
// row may act, the two-step confirm — so the component just renders them.
import type { RewindRefusal, TranscriptItem } from "../../shared/protocol";
import { timestampOf } from "./message";

export type { RewindRefusal };

/** What a rewind request came back with. `text` is the rewound message, handed to the composer;
    `message` is the refusal in user-facing words. */
export type RewindResult = { ok: true; text: string } | { ok: false; reason: RewindRefusal | "disconnected"; message: string };

/** The open chat's rewind hook, from ChatView through App. `entryId` is a user row's
    TranscriptItem id, which is the session entry id. */
export interface RewindControl {
  path: string;
  /** Reactive: "streaming" while a turn is in flight, "compacting" during a compaction, else null. */
  blocked(): "streaming" | "compacting" | null;
  rewind(entryId: string): Promise<RewindResult>;
}

/** Why the pane's rewind is off right now. "live" and "no-chat" are the pane's own, from a missing
    control: the session is open in a terminal, or isn't an open chat here. */
export type RewindBlock = "streaming" | "compacting" | "live" | "no-chat";

/** One user message on the branch. */
export interface InputRow {
  id: string;
  /** The first line, whitespace collapsed; "" when the message is images only. */
  preview: string;
  /** The whole text, for the row's title. */
  text: string;
  images: number;
  at: string | undefined;
}

/** The user rows of a transcript, oldest first. */
export function inputRows(items: readonly TranscriptItem[]): InputRow[] {
  return items
    .filter((it) => it.kind === "user")
    .map((it) => {
      const text = it.text ?? "";
      const first = text.trim().split("\n", 1)[0] ?? "";
      return { id: it.id, preview: first.replace(/\s+/g, " ").trim(), text, images: it.images?.length ?? 0, at: timestampOf(it.raw) };
    });
}

/** What a row shows besides its text: images-only messages say so. */
export function inputPreview(row: InputRow): string {
  if (row.preview) return row.preview;
  if (row.images > 0) return row.images === 1 ? "1 image" : `${row.images} images`;
  return "Empty message";
}

// ---- After a rewind -----------------------------------------------------------------------------

/** A rewind that landed: the message it rewound to (`boundary`), and it plus everything after it,
    as they were, so they can stay on screen greyed until the user sends something. */
export interface Rewound {
  boundary: string;
  abandoned: InputRow[];
  /** Every user row id known when the rewind landed. A fetched row outside it is a new send. */
  seen: string[];
}

/** Records a successful rewind to `id` against the rows on screen. */
export function rewoundAt(rows: readonly InputRow[], id: string): Rewound | null {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return null;
  return { boundary: id, abandoned: rows.slice(i), seen: rows.map((r) => r.id) };
}

/** True once the branch holds a user row the rewind didn't know about: the user sent again. */
export function sentSince(live: readonly InputRow[], rewound: Rewound): boolean {
  const seen = new Set(rewound.seen);
  return live.some((r) => !seen.has(r.id));
}

export type RowState = "active" | "boundary" | "abandoned";
export interface ViewRow extends InputRow {
  state: RowState;
}

/**
 * The rows in the session's own order — oldest first — with their state: the branch's user rows,
 * then, while a rewind is fresh, the rows it abandoned, the first of them the boundary. A fetch
 * still in flight from before the rewind can hold the abandoned rows too; they show once, as
 * abandoned. `displayRows` is what the list renders; this is the order everything else reasons in.
 */
export function viewRows(live: readonly InputRow[], rewound: Rewound | null): ViewRow[] {
  if (!rewound || sentSince(live, rewound)) return live.map((r) => ({ ...r, state: "active" }));
  const gone = new Set(rewound.abandoned.map((r) => r.id));
  return [
    ...live.filter((r) => !gone.has(r.id)).map((r): ViewRow => ({ ...r, state: "active" })),
    ...rewound.abandoned.map((r): ViewRow => ({ ...r, state: r.id === rewound.boundary ? "boundary" : "abandoned" })),
  ];
}

// ---- The two-step confirm -----------------------------------------------------------------------

/** One row at a time: idle, asking (the button became Confirm/Cancel), sent, or refused. */
export type RewindPhase =
  | { kind: "idle" }
  | { kind: "confirm"; id: string }
  | { kind: "pending"; id: string }
  | { kind: "failed"; id: string; error: string };

export type RewindStep =
  | { type: "ask"; id: string }
  | { type: "cancel" }
  | { type: "confirm" }
  | { type: "settled"; result: RewindResult };

export const IDLE: RewindPhase = { kind: "idle" };

/** The confirm's transitions. Nothing interrupts a pending request; asking elsewhere moves the
    question (and drops an earlier failure). */
export function stepRewind(phase: RewindPhase, step: RewindStep): RewindPhase {
  switch (step.type) {
    case "ask":
      return phase.kind === "pending" ? phase : { kind: "confirm", id: step.id };
    case "cancel":
      return phase.kind === "pending" ? phase : IDLE;
    case "confirm":
      return phase.kind === "confirm" ? { kind: "pending", id: phase.id } : phase;
    case "settled":
      if (phase.kind !== "pending") return phase;
      return step.result.ok ? IDLE : { kind: "failed", id: phase.id, error: step.result.message };
  }
}

const BLOCK_REASON: Record<RewindBlock, string> = {
  streaming: "Stop the current turn first.",
  compacting: "Wait for the compaction to finish.",
  live: "This session is open in a terminal, so pi-web won't write to it.",
  "no-chat": "Only a chat open in pi-web can rewind.",
};

/** Whether a row's rewind can act, and if not, why — the reason the disabled button carries. */
export function rowAction(row: ViewRow, blocked: RewindBlock | null, phase: RewindPhase): { enabled: boolean; reason: string | null } {
  if (row.state !== "active") return { enabled: false, reason: "Not on the current branch." };
  if (phase.kind === "pending") return { enabled: false, reason: "A rewind is already in progress." };
  if (blocked) return { enabled: false, reason: BLOCK_REASON[blocked] };
  return { enabled: true, reason: null };
}

/**
 * What the list renders: newest first, so the message you just sent is at the top and the chat's
 * history grows downwards. After a rewind that puts the abandoned rows ABOVE the boundary row —
 * they are the ones that came after it — which is why they stay greyed rather than simply looking
 * older.
 */
export function displayRows(live: readonly InputRow[], rewound: Rewound | null): ViewRow[] {
  return viewRows(live, rewound).reverse();
}
