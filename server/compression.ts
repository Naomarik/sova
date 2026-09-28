import type { IncomingMessage } from "node:http";

/** Headers a forwarding proxy adds. `tailscale serve` (the phone's way in, proxying to loopback)
    always sets X-Forwarded-Host, and X-Forwarded-For/-Proto and Tailscale-* when it can. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "via"];

const isLoopback = (address: string | undefined): boolean =>
  !!address && (address === "::1" || /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address));

/**
 * A browser on this machine talking to the server itself: the socket's peer is loopback and no
 * proxy stepped in between. Such a client is sent nothing compressed (no bandwidth to save, and
 * compressing costs it ~90 ms on a 7 MB transcript). A proxy on this machine (tailscale serve,
 * a local reverse proxy that marks what it forwards) is loopback too, so it's the headers that
 * tell them apart. No socket at all (app.request in-process) is not direct-local.
 */
export function isDirectLocal(req: Pick<IncomingMessage, "headers"> & { socket?: { remoteAddress?: string } | null }): boolean {
  if (!isLoopback(req.socket?.remoteAddress)) return false;
  for (const name of Object.keys(req.headers)) {
    const h = name.toLowerCase();
    if (PROXY_HEADERS.includes(h) || h.startsWith("tailscale-")) return false;
  }
  return true;
}
