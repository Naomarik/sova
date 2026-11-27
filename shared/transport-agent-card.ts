// The Transport agent's card in a chat (§app.transport/agent): a note Sova puts in the chat being
// transported (before arrival, the original chat; after arrival, the chat where it arrived), drawn
// as a card that reads the transport's agent live by its transport id.

/** The note type (server/transport/source.ts and destination.ts write it; server/transcript.ts draws it). */
export const TRANSPORT_AGENT_NOTE = "sova-transport-agent";

/** The card's note details: the transport it reads, and the agent's title and device when it was put in. */
export interface TransportAgentNote {
  tid: string;
  title: string;
  device: string;
}

/** A note's details as the card, or null when they don't read as one (the row falls back to its text). Pure. */
export function transportAgentNoteOf(details: unknown): TransportAgentNote | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const d = details as Record<string, unknown>;
  const s = (k: string): string => (typeof d[k] === "string" ? (d[k] as string) : "");
  const card = { tid: s("tid"), title: s("title"), device: s("device") };
  return /^tr_[a-z0-9]{6,32}$/.test(card.tid) && card.title ? card : null;
}
