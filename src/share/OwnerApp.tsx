import { createSignal, onCleanup } from "solid-js";
import type { OwnerRoute } from "../lib/owner-words";
import { ownerHash, parseOwnerHash } from "../lib/owner-words";
import { type OwnerAnswer, OwnerLoadError, OwnerPage } from "./owner-view";
import { visitTab } from "./visit-tab";

/**
 * The Owner page from its link (§app.owner-page/link): `/i/<token>`, the view in the hash
 * (`#p/q_…`, `#c/k_…`) so Back works. Read-only: GETs only, re-read every minute while visible.
 */

const TOKEN = /^\/i\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1] ?? null;
const storage = (): Storage | null => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};
const VISIT = visitTab(storage());

const apiPath = (r: OwnerRoute): string =>
  `/api/i/${TOKEN}${r.kind === "project" ? `/p/${r.id}` : r.kind === "conversation" ? `/c/${r.id}` : ""}?v=${VISIT}`;

async function load(r: OwnerRoute): Promise<OwnerAnswer> {
  if (!TOKEN) throw new OwnerLoadError("unknown");
  const res = await fetch(apiPath(r), { cache: "no-store" }).catch(() => null);
  if (!res) throw new OwnerLoadError("failed");
  if (res.status === 410) {
    const body = (await res.json().catch(() => ({}))) as { why?: unknown };
    throw new OwnerLoadError(body.why === "expired" ? "expired" : "gone");
  }
  // A handle that isn't on the page answers like an unknown one; only the home answer says the link is unknown.
  if (res.status === 404) throw new OwnerLoadError(r.kind === "home" ? "unknown" : "missing");
  if (res.status === 429) throw new OwnerLoadError("busy");
  if (!res.ok) throw new OwnerLoadError("failed");
  return (await res.json()) as OwnerAnswer;
}

export function OwnerApp() {
  const [route, setRoute] = createSignal<OwnerRoute>(parseOwnerHash(location.hash));
  const onHash = () => {
    setRoute(parseOwnerHash(location.hash));
    window.scrollTo(0, 0);
  };
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));
  return <OwnerPage route={route()} load={load} href={ownerHash} onTitle={(t) => (document.title = t)} />;
}
