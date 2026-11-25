// What the two devices of a transport say to each other (§app/transport). The source decides every
// step and drives it: it offers the chat, asks how far the destination is, says when the package is
// ready, and sends the one commit. The destination pulls the package with the ticket and answers.
// Every route but the package's is a `sessions` route there; the package's is the ticket's own.
import type { CarriedSettings } from "./project-carry";
import type { TransportState } from "./store";

/** The offer's header: the click that started it, as the source minted it over the offer's body (asked back once). */
export const PROOF_HEADER = "x-sova-click-proof";
/** Its header on the package pull: the one-time ticket (never in a URL, never logged). */
export const TICKET_HEADER = "x-sova-transport-ticket";

export const peerPath = {
  offer: "/api/peer/transport/offer",
  status: (tid: string) => `/api/peer/transport/${tid}`,
  ready: (tid: string) => `/api/peer/transport/${tid}/ready`,
  commit: (tid: string) => `/api/peer/transport/${tid}/commit`,
  cancel: (tid: string) => `/api/peer/transport/${tid}/cancel`,
  retry: (tid: string) => `/api/peer/transport/${tid}/retry`,
  needs: (tid: string) => `/api/peer/transport/${tid}/needs`,
  moveBack: (tid: string) => `/api/peer/transport/${tid}/move-back`,
  allowDownloads: (tid: string) => `/api/peer/transport/${tid}/allow-downloads`,
  adminDone: (tid: string) => `/api/peer/transport/${tid}/admin-done`,
  package: (tid: string) => `/api/peer/transport/${tid}/package`,
};

export interface OfferTree {
  name: string;
  branch: string | null;
  /** The repository's own checkout (not a linked worktree): it is built whole there. */
  main: boolean;
  /** Where it goes there, relative to the folder's parent ("" for the chat's own tree: the folder). */
  rel: string;
  /** Its HEAD commit when offered (it may move on before the switch). */
  head?: string;
}

export interface OfferBody {
  v: 1;
  tid: string;
  ticket: string;
  mode: "move" | "copy";
  chat: { id: string; title: string };
  /** The folder on that device the chat's own tree (or its folder) goes to: absolute. */
  folder: string;
  /** The repository's main folder there, relative to the folder's parent, when the chat's tree is a linked worktree. */
  repoRel: string | null;
  /** The repository's remotes (no credentials) and its first commits; its submodules (nested ones too), each by its
      path from the chat's tree with its address (relative ones resolved, no credentials), for that device to check
      which it can fetch. */
  project: { remotes: string[]; roots: string[]; submodules?: { key: string; url: string }[] };
  trees: OfferTree[];
  sourceLabel: string;
  model?: string;
  /** The source chat's own model. */
  chatModel?: string;
  /** The host values the project's definition declares (`host`), and the ones this device holds for it: what that
      device asks you for on the Transport card, prefilled with these. Never another project's or name's; never logged. */
  host?: { names: string[]; values: Record<string, string> };
  /** This device's Sova settings for the project, for a device where it isn't registered (§app.transport/arrival). */
  projectSettings?: CarriedSettings;
}

export interface StatusBody {
  tid: string;
  state: TransportState | "unknown";
  steps: Record<string, string>;
  /** Commits the repository there has (the package leaves them out). */
  haves?: string[];
  /** The project comes from this device: the repository isn't there and can't be cloned there, so the package
      carries its branches and history (§app.transport/package). */
  fromSource?: boolean;
  /** The submodules (by key) whose remotes answered from there: only what those lack travels; every other checked-out
      submodule travels with its history (§app.transport/package). */
  subsFetch?: string[];
  needsYou?: string;
  received?: number;
  /** The chat's id there once published. */
  arrivedId?: string;
  renamed?: { from: string; to: string }[];
  /** The chat there has had a turn since it arrived (Move Back is gone). */
  turned?: boolean;
  /** The chat there was already stopped for a Move Back (it runs nowhere until this device restores it): asked again, it answers again. */
  movedBack?: boolean;
  /** The chat's conversation there, once it opened. */
  path?: string;
  /** The Transport agent there, once one started: what its card in the chat shows. */
  agent?: AgentView;
  /** What the agent sets up there after arrival (short names): the done line says the setup is under way. */
  settingUp?: string[];
}

/** The Transport agent as its card shows it (§app.transport/agent): its chat there, state and the checks' findings. */
export interface AgentView {
  sessionId: string;
  path: string;
  title: string;
  device?: string;
  state: "working" | "ready" | "needs-you";
  checks: { id: string; ok: boolean; detail: string }[];
  /** Its download list (§app.transport/agent "Downloads, on your click"): asked, or allowed by your click. */
  downloads?: { id: string; items: { tool: string; version: string; host: string }[]; why?: string; state: "asked" | "allowed" };
  /** Commands needing administrator rights it asked you to run yourself. */
  admin?: { id: string; command: string; why?: string; state: "asked" | "done" }[];
  /** Files outside the project on the device the chat came from it asked you to bring or place (§app.transport/agent). */
  outside?: { id: string; path: string; folder: string; why?: string; from: string; state: "asked" | "brought" | "kept" | "placed" }[];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** An agent's record, cut to what its card shows (never its link or model). Pure. */
export const agentViewOf = (a: AgentView): AgentView => {
  const d = a.downloads;
  return {
    sessionId: a.sessionId,
    path: a.path,
    title: a.title,
    ...(a.device ? { device: a.device } : {}),
    state: a.state,
    checks: (a.checks ?? []).slice(0, 40).map((c) => ({ id: c.id, ok: c.ok, detail: c.detail })),
    ...(d && typeof d.id === "string" && Array.isArray(d.items)
      ? {
          downloads: {
            id: str(d.id, 40),
            items: d.items.slice(0, 16).map((i) => ({ tool: str(i?.tool, 80), version: str(i?.version, 64), host: str(i?.host, 253) })),
            ...(d.why ? { why: str(d.why, 300) } : {}),
            state: d.state === "allowed" ? ("allowed" as const) : ("asked" as const),
          },
        }
      : {}),
    ...(Array.isArray(a.admin) && a.admin.length
      ? { admin: a.admin.slice(-16).map((s) => ({ id: str(s?.id, 40), command: str(s?.command, 1000), ...(s?.why ? { why: str(s.why, 300) } : {}), state: s?.state === "done" ? ("done" as const) : ("asked" as const) })) }
      : {}),
    ...(Array.isArray(a.outside) && a.outside.length
      ? {
          outside: a.outside.slice(-16).map((f) => ({
            id: str(f?.id, 40),
            path: str(f?.path, 1100),
            folder: str(f?.folder, 1100),
            ...(f?.why ? { why: str(f.why, 300) } : {}),
            from: str(f?.from, 200),
            state: f?.state === "brought" || f?.state === "kept" || f?.state === "placed" ? f.state : ("asked" as const),
          })),
        }
      : {}),
  };
};

export interface ReadyBody {
  sha256: string;
  size: number;
}
