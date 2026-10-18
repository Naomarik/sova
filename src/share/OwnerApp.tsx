import { createSignal, onCleanup } from "solid-js";
import type { OwnerRoute } from "../lib/owner-words";
import { ownerHash, parseOwnerHash } from "../lib/owner-words";
import { type OwnerAnswer, OwnerLoadError, OwnerPage } from "./owner-view";
import type { AssistantApi } from "./assistant-view";
import type { AssistantServerMessage, AssistantView } from "../../shared/project-assistant";
import { visitTab } from "./visit-tab";

/**
 * The Owner page from its link (§app.owner-page/link): `/i/<token>`, the view in the hash
 * (`#p/q_…`, `#c/k_…`) so Back works. Re-read every minute while visible; a link that turned off
 * unused can ask for a new one.
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
    const body = (await res.json().catch(() => ({}))) as { why?: unknown; asked?: unknown };
    throw new OwnerLoadError(body.why === "expired" ? "expired" : "gone", body.asked === true);
  }
  // "missing": a project or conversation that isn't on the page (hidden and never-existed answer
  // alike); anything else is the link itself.
  if (res.status === 404) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    throw new OwnerLoadError(body.code === "missing" && r.kind !== "home" ? "missing" : "unknown");
  }
  if (res.status === 429) throw new OwnerLoadError("busy");
  // A public gateway's answer for a host that is offline (§mesh.public/offline): the page keeps
  // what it shows and reads again.
  if (res.status === 503) throw new OwnerLoadError("offline");
  if (!res.ok) throw new OwnerLoadError("failed");
  return (await res.json()) as OwnerAnswer;
}

/** Ask for a new link (a link that turned off unused): true once the operator was told. */
async function ask(): Promise<boolean> {
  if (!TOKEN) return false;
  const res = await fetch(`/i/${TOKEN}/ask-link`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
  return res?.status === 202;
}

/** The Project Assistant's conversation through the link (§app.project-assistant/chat). */
const assistant: AssistantApi = {
  async load() {
    const res = await fetch(`/api/i/${TOKEN}/assistant`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as AssistantView;
  },
  async send(text) {
    const res = await fetch(`/api/i/${TOKEN}/assistant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null);
    if (res?.status === 202) return { ok: true };
    const body = (await res?.json().catch(() => ({}))) as { code?: string; error?: string } | undefined;
    return { ok: false, code: body?.code ?? (res?.status === 429 ? "rate-limited" : "failed"), message: body?.error ?? "" };
  },
  subscribe(on) {
    let ws: WebSocket | null = null;
    let stop = false;
    let delay = 1000;
    const open = () => {
      if (stop || !TOKEN) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/i?token=${TOKEN}&v=${VISIT}`);
      ws.onmessage = (e) => {
        try {
          on(JSON.parse(String(e.data)) as AssistantServerMessage);
        } catch {
          // not a frame of ours
        }
      };
      ws.onopen = () => (delay = 1000);
      ws.onclose = (e) => {
        if (stop || e.code === 4410 || e.code === 4000) return;
        setTimeout(open, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    open();
    return () => {
      stop = true;
      ws?.close();
    };
  },
};

export function OwnerApp() {
  const [route, setRoute] = createSignal<OwnerRoute>(parseOwnerHash(location.hash));
  const onHash = () => {
    setRoute(parseOwnerHash(location.hash));
    window.scrollTo(0, 0);
  };
  window.addEventListener("hashchange", onHash);
  onCleanup(() => window.removeEventListener("hashchange", onHash));
  return <OwnerPage route={route()} load={load} href={ownerHash} onTitle={(t) => (document.title = t)} ask={ask} assistant={assistant} versionHref={(h) => `/i/${TOKEN}/v/${h}`} />;
}
