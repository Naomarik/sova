import { join } from "node:path";
import type { AttentionItem } from "../../shared/protocol";
import type { ReleaseRecord, ReleaseView } from "../../shared/release";
import type { ProjectDef } from "../../shared/project-contract";
import type { MergeQueues, ReleaseQueueEvent } from "../merge-queue/queue";
import { type ReleaseAttention, Releaser } from "./release";

/**
 * The server's one releaser (server/project-services/release.ts), wired by the merge queue's start (it needs the
 * queues): the `release.*` verbs on the project engine, the queue's release events, the WS feed, Needs you, the
 * release chat's start and wake, and the stall watch.
 */

export const RELEASE_THREAD_PROFILE = "release-thread";

let current: Releaser | null = null;

/** The server's releaser; null before the merge queue started (and in tests that wire none). */
export const releaser = (): Releaser | null => current;
export function setReleaserForTest(r: Releaser | null): void {
  current = r;
}

/** Each project's newest release records as the releaser last published them (or as its start found them), by root:
 *  what a project card's Release row reads (§app.projects/home-glance) without opening a record file. */
const latestReleases = new Map<string, { open: ReleaseRecord | null; last: ReleaseRecord | null }>();

/** Keep a published release view's records (the feed's `release` frame). */
export function noteReleaseView(view: Pick<ReleaseView, "project" | "open" | "last">): void {
  latestReleases.set(view.project, { open: view.open, last: view.last });
}

/** A root's newest release records as kept in memory: undefined when none was kept. Synchronous, no file read. */
export const keptReleases = (root: string): { open: ReleaseRecord | null; last: ReleaseRecord | null } | undefined => latestReleases.get(root);

/** Tests only. */
export function resetKeptReleasesForTest(): void {
  latestReleases.clear();
}

type AppRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

export interface ReleaseWireDeps {
  stateRoot: string;
  queues: () => MergeQueues;
  request?: AppRequest;
  rootOf: (path: string) => Promise<string | null>;
  definitionAt: (root: string, ref: string) => Promise<{ def: ProjectDef | null; error: string | null }>;
  projectIdOf: (root: string) => string | null;
  publishFeed: (msg: { type: "release"; project: string; view: ReleaseView }) => void;
}

export async function startReleaser(d: ReleaseWireDeps): Promise<Releaser> {
  const [{ projectEngine }, { attentionChanged }, { deployedAt }] = await Promise.all([import("./routes"), import("../attention-memo"), import("./deploy")]);
  const r = new Releaser({
    dir: join(d.stateRoot, "project-services", "release"),
    queue: (root) => d.queues().get(root),
    rootOf: d.rootOf,
    definitionAt: d.definitionAt,
    projectIdOf: d.projectIdOf,
    publish: (view) => {
      noteReleaseView(view);
      d.publishFeed({ type: "release", project: view.project, view });
    },
    attention: () => attentionChanged(),
    deployedTo: (root, sha) => deployedAt(root, sha),
    thread: {
      async start({ checkout, text, title }) {
        if (!d.request) return { error: "this server can't start chats" };
        const { createChat } = await import("../merge-queue/thread");
        const out = await createChat(d.request, checkout, RELEASE_THREAD_PROFILE, text, title);
        return out.ok ? { id: out.id, path: out.path } : { error: out.error };
      },
      retitle(session, title) {
        void import("../session-titles").then(({ writeAutoTitle }) => writeAutoTitle(session, title, { redo: true })).catch(() => {});
      },
      async wake(path, text) {
        const { promptSession } = await import("../session-prompt");
        const out = await promptSession(path, `[Sova · release] ${text}`);
        return out.ok ? { ok: true } : { ok: false, error: out.error };
      },
    },
  });
  projectEngine().releaser = (verb, body, caller) => r.run(verb, body, caller);
  r.startWatch();
  // What the cards' glance reads until the first publish: each root's records, read once here at the start.
  for (const root of r.roots()) {
    try {
      if (!latestReleases.has(root)) latestReleases.set(root, r.keptRecords(root));
    } catch {}
  }
  current = r;
  return r;
}

/** The queue's word about a release entry, for the releaser (queue.ts QueueDeps.releaseEvent). */
export const releaseEvent = (ev: ReleaseQueueEvent): void => current?.onQueueEvent(ev, ev.root);

export function stopReleaser(): void {
  current?.stopWatch();
  current = null;
  latestReleases.clear();
}

const DETAIL_MAX = 200;

/** The digest's release items: act tier, no session (Open Chat names the release chat's file). */
export function releaseItems(facts: readonly ReleaseAttention[], projectOf: (root: string) => { id: string; name: string } | null): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const f of facts) {
    const p = projectOf(f.root);
    if (!p) continue;
    const detail = f.detail.length > DETAIL_MAX ? `${f.detail.slice(0, DETAIL_MAX - 1)}…` : f.detail;
    out.push({ id: `${f.kind}:${p.id}:${f.release}`, path: "", title: p.name, where: f.root, tier: "act", kind: f.kind, since: f.since, detail, href: `#/projects/${encodeURIComponent(p.id)}/releases` });
  }
  return out;
}

/** Every release item on this host. */
export async function releaseAttentionItems(): Promise<AttentionItem[]> {
  const r = current;
  if (!r) return [];
  const { listProjects } = await import("../projects/spaces");
  const projects = listProjects();
  return releaseItems(r.attentionFacts(), (root) => {
    const p = projects.find((x) => x.root === root);
    return p ? { id: p.id, name: p.name || p.id } : null;
  });
}
