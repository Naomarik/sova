import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

/**
 * The public-links security helpers (§mesh.public/forwarded-for): the interfaces later milestones
 * import, frozen here so they can be written before the reviewed implementations land. The stubs
 * fail closed: trustedClient believes no forwarded header, stripForwarded throws. The share
 * listener keeps today's rule (clientAddress, its edge default) until the security milestone
 * narrows it.
 */

type ClientRequest = Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string } };

/**
 * Today's share-listener rule, unchanged: behind the reverse proxy every connection comes from
 * the proxy, so a loopback or tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) peer's last
 * X-Forwarded-For hop is used instead — the hop the proxy itself appended. (Any tailnet device can
 * therefore choose its own key; trustedClient replaces this.)
 */
export function clientAddress(req: ClientRequest): string {
  const peer = req.socket.remoteAddress ?? "";
  const plain = peer.replace(/^::ffff:/, "");
  const proxied = plain === "127.0.0.1" || plain === "::1" || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(plain) || /^fd7a:115c:a1e0:/i.test(plain);
  const xff = req.headers["x-forwarded-for"];
  if (proxied && typeof xff === "string" && xff.trim()) return xff.split(",").pop()!.trim();
  return plain || "unknown";
}

/** Whose X-Forwarded-For a listener may believe. `local-proxy`: the gateway's configured front on
    this host's loopback, never any tailnet peer's last hop. `admitted`: a routed host's ingress,
    only on a connection its gate admitted, and only a single value. `none`: never. */
export type ForwardedTrust = "local-proxy" | "admitted" | "none";

export interface TrustedClientContext {
  trust: ForwardedTrust;
  /** The connection passed the ingress gate. Known from the listener's own control flow (its
      `client` runs only after `admit`), never from anything the request says. */
  admitted?: boolean;
}

/** The address a request is rate-limited and logged under. Until the security milestone: the
    socket's own address in every context, so no forwarded header is believed. */
export function trustedClient(req: ClientRequest, ctx: TrustedClientContext): string {
  void ctx;
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || "unknown";
}

/** The request headers a gateway forwards on a hop, with every client-supplied forwarding,
    identity and hop-by-hop header removed (INGRESS_STRIP_HEADERS, case-insensitively, and any
    header Connection names). The gateway then sets INGRESS_SET_HEADERS itself. */
export function stripForwarded(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  void headers;
  throw new Error("stripForwarded is not implemented yet");
}
