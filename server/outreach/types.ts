import type { ChannelId, SenderStatus } from "../../shared/outreach";
import type { SenderTarget } from "./targets";

/**
 * A channel adapter (§app.outreach/channels): the core hands it an address it resolved, the rendered
 * text and an idempotency key; nothing else about the channel reaches the core. No inbound.
 */
export type ChannelSend = { ok: true; ref: string; at: string } | { ok: false; code: string; retryable: boolean; why: string };

export interface Receipt {
  ref: string;
  status: "delivered" | "read" | "failed";
  code?: string;
}

export interface Channel {
  id: ChannelId;
  /** One sender's status (`target`, else the default; null: off), noted in ./health.ts. */
  status(target?: SenderTarget | null): Promise<SenderStatus>;
  /** Through `target` only (else the default): a send never moves to another sender. */
  send(input: { idem: string; address: string; text: string; target?: SenderTarget | null }): Promise<ChannelSend>;
  /** Receipts of this host's sends, by the ref `send` answered. */
  onReceipt(cb: (r: Receipt) => void): void;
}
