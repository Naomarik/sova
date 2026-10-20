import { createSignal, onCleanup } from "solid-js";
import type { OwnerRoute } from "../lib/owner-words";
import { ownerHash, parseOwnerHash, readsHome } from "../lib/owner-words";
import { type OwnerAnswer, OwnerPage } from "./owner-view";
import { OwnerLoadError, ownerProblemOf } from "../lib/owner-problem";
import type { AssistantApi } from "./assistant-view";
import type { AssistantSend, AssistantServerMessage, AssistantView } from "../../shared/project-assistant";
import { visitTab } from "./visit-tab";
import { uploadPhoto } from "./photos";

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
  // "missing": a project or conversation that isn't on the page (hidden and never-existed answer
  // alike); a 404 otherwise is the link itself. A 503 is a public gateway's answer for a host that
  // is offline (§mesh.public/offline): the page keeps what it shows and reads again.
  // Home, the Assistant and Requests read the Home answer: a 404 there is the link itself.
  const problem = await failure(res, readsHome(r) ? "home" : "sub");
  if (problem) throw problem;
  return (await res.json()) as OwnerAnswer;
}

/** The problem a failed answer means (null: it didn't fail), its body read only when it did. */
async function failure(res: Response, read: "home" | "sub" | "assistant"): Promise<OwnerLoadError | null> {
  if (res.ok) return null;
  return ownerProblemOf(res.status, await res.json().catch(() => ({})), read);
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
    if (!TOKEN) throw new OwnerLoadError("unknown");
    const res = await fetch(`/api/i/${TOKEN}/assistant`, { cache: "no-store" }).catch(() => null);
    if (!res) throw new OwnerLoadError("failed");
    // Read as the page's own reads are; a 404 with no code is a gateway that doesn't pass this address yet.
    const problem = await failure(res, "assistant");
    if (problem) throw problem;
    return (await res.json()) as AssistantView;
  },
  async send(text, images) {
    const body: AssistantSend = { text, ...(images?.length ? { images } : {}) };
    const res = await fetch(`/api/i/${TOKEN}/assistant`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (res?.status === 202) return { ok: true };
    const refusal = (await res?.json().catch(() => ({}))) as { code?: string; error?: string } | undefined;
    return { ok: false, code: refusal?.code ?? (res?.status === 429 ? "rate-limited" : "failed"), message: refusal?.error ?? "" };
  },
  // The owner's photos (§app.project-assistant/photos): staged at attach, read back by their number in the view.
  uploadPhoto: (blob, progress) => uploadPhoto(`/api/i/${TOKEN}/assistant/image`, blob, progress),
  photo: (n) => `/api/i/${TOKEN}/assistant/img/${n}`,
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
  return <OwnerPage route={route()} load={load} href={ownerHash} tourBase={(conversation, handle) => `/api/i/${TOKEN}/c/${encodeURIComponent(conversation)}/tours/${encodeURIComponent(handle)}`} onTitle={(t) => (document.title = t)} ask={ask} assistant={assistant} versionHref={(h) => `/i/${TOKEN}/v/${h}`} />;
}
