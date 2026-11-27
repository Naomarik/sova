import type { Context, Hono } from "hono";
import type { DetectedNetwork, NetworksView, RangeCheck } from "../../shared/networks";
import { fromTourRecorder, tailnetPairOrigin } from "../auth";
import { localRequest } from "../mesh/proxy";
import { yourClickRefusal } from "../page-only";
import { networkLabel } from "./detect";
import { detectedNetworks, isWildcard, refreshTrustedListeners, trustedNetworks } from "./listeners";
import { detectNetworks, routedFrom } from "./probe";
import { cidrContains, cidrOverlaps, cidrSize, cidrText, firstHost, needsRetype, parseCidr, rangeRefusal, REFUSAL_WORDS, sizeNumber } from "./ranges";
import { addTrusted, removeTrusted } from "./store";

// The Access page's networks (§app.access/networks): the list, a range's check before the
// confirmation, Trust (the operator's own click in the page only) and Stop Trusting. Every route is
// local-only: never a peer's call or one relayed through a peer, never a guided-tour recorder.

const host = (): string => process.env.HOST || "127.0.0.1";

const FORBIDDEN = { error: "Forbidden" } as const;
const notHere = (c: Context): Response | null => (!localRequest(c) || fromTourRecorder((n) => c.req.header(n)) ? c.json(FORBIDDEN, 403) : null);

const count = (n: bigint): string => (n > 1_000_000_000_000n ? `2^${n.toString(2).length - 1}` : n.toLocaleString("en-US"));

/** What a range would be, for the confirmation: its size, where its devices reach this computer, and the warnings. */
export async function checkRange(text: string, networks?: DetectedNetwork[], route: (address: string) => Promise<string | null> = routedFrom): Promise<RangeCheck> {
  const c = parseCidr(text);
  const refusal = rangeRefusal(text);
  if (!c || refusal) return { ok: false, ...(c ? { range: cidrText(c) } : {}), error: REFUSAL_WORDS[refusal ?? "unparsable"] };
  const list = networks ?? (await detectNetworks().catch(() => []));
  // The listed network the range sits on: one whose own range overlaps it, or whose address it holds.
  let net = list.find((n) => cidrContains(c, n.address)) ?? list.find((n) => n.range && cidrOverlaps(c, parseCidr(n.range)!));
  if (!net) {
    const from = await route(firstHost(c));
    net = from ? list.find((n) => n.address === from) : undefined;
  }
  const size = cidrSize(c);
  const netRange = net?.range ? parseCidr(net.range) : null;
  const out: RangeCheck = { ok: true, range: cidrText(c), count: sizeNumber(c), countLabel: count(size), needsRetype: needsRetype(c) };
  if (net) {
    out.address = net.address;
    out.iface = net.iface;
    out.kind = net.kind;
    out.vpn = net.vpn;
    if (netRange) out.networkCount = sizeNumber(netRange);
  }
  // A Wi-Fi or wired network's own warning (`vpn: false`) is the page's to say.
  if (!net) out.warning = "No network of this computer reaches that range now. Sova will listen once one does.";
  else if (netRange && size > cidrSize(netRange)) out.warning = `This range is larger than ${networkLabel(net)} (${count(cidrSize(netRange))} addresses): devices outside that network can reach Sova too.`;
  return out;
}

export async function networksView(): Promise<NetworksView> {
  await refreshTrustedListeners({ look: true });
  const networks = detectedNetworks();
  const tailnet = tailnetPairOrigin();
  return {
    wildcard: isWildcard(host()),
    tailscale: tailnet ? { ready: true, url: tailnet.origin } : networks.some((n) => n.kind === "tailscale") ? { ready: false } : null,
    networks,
    trusted: trustedNetworks(),
  };
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerNetworkRoutes(app: Hono<any>): void {
  app.get("/api/auth/networks", async (c) => {
    c.header("Cache-Control", "no-store");
    return notHere(c) ?? c.json(await networksView());
  });

  app.post("/api/auth/networks/check", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = notHere(c);
    if (refused) return refused;
    const { range } = await body(c);
    if (typeof range !== "string") return c.json({ error: REFUSAL_WORDS.unparsable }, 400);
    return c.json(await checkRange(range));
  });

  app.post("/api/auth/networks/trust", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = notHere(c) ?? yourClickRefusal(c, "trustNetwork");
    if (refused) return refused;
    if (isWildcard(host())) return c.json({ error: "Sova already answers on every network (it was started with HOST set to every address), so there is nothing to trust per network." }, 409);
    const { range, confirm } = await body(c);
    if (typeof range !== "string") return c.json({ error: REFUSAL_WORDS.unparsable }, 400);
    const networks = await detectNetworks().catch(() => []);
    const check = await checkRange(range, networks);
    if (!check.ok || !check.range) return c.json({ error: check.error ?? REFUSAL_WORDS.unparsable }, 400);
    if (check.needsRetype && (typeof confirm !== "string" || parseCidr(confirm) === null || cidrText(parseCidr(confirm)!) !== check.range))
      return c.json({ error: `That range holds ${check.countLabel} addresses: type it again to confirm.`, needsRetype: true }, 400);
    const net = networks.find((n) => n.iface === check.iface && n.address === check.address);
    addTrusted({ range: check.range, ...(net ? { iface: net.iface, kind: net.kind, label: networkLabel(net) } : {}) });
    return c.json(await networksView());
  });

  app.post("/api/auth/networks/untrust", async (c) => {
    c.header("Cache-Control", "no-store");
    const refused = notHere(c);
    if (refused) return refused;
    const { range } = await body(c);
    if (typeof range !== "string" || !parseCidr(range)) return c.json({ error: REFUSAL_WORDS.unparsable }, 400);
    if (!removeTrusted(range)) return c.json({ error: "That range isn't trusted." }, 404);
    // Closes that network's listener and every connection it holds before answering.
    return c.json(await networksView());
  });
}
