import type { Socket } from "node:net";

// The trusted listeners open right now (§app.access/networks, §app.access/gate): what server/auth.ts
// reads for the names and origins Sova goes by, whether the token is asked for, and the pairing
// links. Kept by server/networks/listeners.ts; nothing here binds or reads the system.

export interface OpenTrusted {
  /** The local address it is bound at (canonical: no brackets). */
  address: string;
  port: number;
  /** The ranges a source must lie inside. */
  ranges: string[];
  /** The listed network's name, when it was trusted from the list ("WireGuard · wg0"). */
  label?: string;
}

let open: readonly OpenTrusted[] = [];
/** Every socket a trusted listener accepted: never the person at this computer's keyboard (no silent sign-in),
    and always asked for the token. */
const trustedSockets = new WeakSet<object>();

export const openTrusted = (): readonly OpenTrusted[] => open;

export function setOpenTrusted(list: readonly OpenTrusted[]): void {
  open = list.map((l) => ({ ...l, ranges: [...l.ranges] }));
}

/** Tests: the live set without binding anything (pair() and the Host rules in process). */
export const setOpenTrustedForTest = setOpenTrusted;

/** Mark a socket a trusted listener accepted, or a request (an upgrade's included) it received: a runtime may
    hand a request a socket object other than the one its 'connection' event named, so both are marked. */
export function markTrusted(thing: Socket | object): void {
  trustedSockets.add(thing);
}

/** Whether a request came in on a trusted listener (by the request itself or its socket). */
export function onTrustedListener(incoming: unknown): boolean {
  if (!incoming || typeof incoming !== "object") return false;
  if (trustedSockets.has(incoming)) return true;
  const socket = (incoming as { socket?: object | null }).socket;
  return !!socket && trustedSockets.has(socket);
}

/** The open trusted listener at this address (and port, when given), or undefined. */
export function trustedAt(address: string, port?: number): OpenTrusted | undefined {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  return open.find((l) => l.address === a && (port === undefined || l.port === port));
}
