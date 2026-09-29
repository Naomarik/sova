import { dirname } from "node:path";
import type { ProfileChange } from "../shared/orgs";
import { revokeLinks } from "./baton-links";
import { hostOf, onOrgHostOpened, type Effect, type OrgHostApi } from "./org-engine";
import { hostIdentity, named, parseHolder, remoteHolder } from "./org-holder";
import { appendHistory, noteWorkspaceWrite, orgSid, readIndex, residenceSid, watchSid } from "./orgs";
import { revokeOwnerLinks } from "./owner";
import { revokePersonLinks } from "./person-links";
import { refreshShare } from "./share/hub";
import { changeSummary } from "./workspace-commits";
import { changedPaths, commitAll, headCommitMs, retryPush } from "./workspace-git";

/**
 * The server's side of the org charts' effects (design §2.6): each is an intent a chart step emitted,
 * run after the step is durable, answered as `effect/done {result}` or `effect/failed {detail}`
 * (a throw). Every handler is idempotent by the effect's key: the host runs a pending one again
 * after a restart. Registered on every org's engine as it opens.
 *
 * Here: the org, residence and person charts' (P1). Baton, decision, build and watch effects are
 * registered by their own modules.
 */

/** The workspace repo of the org an effect belongs to. */
function dirOf(orgId: string): string {
  const e = readIndex().orgs.find((o) => o.id === orgId);
  if (!e) throw new Error("The organization is not attached here.");
  return e.dir;
}

/** What a commit did, as the residence reads it (`head-at`, `push-failed`, `error`). */
async function commitResult(dir: string, out: { committed: boolean; sha?: string; pushed?: boolean; error?: string }) {
  const pushFailed = !!out.error?.startsWith("git push failed");
  if (out.error && !pushFailed) throw new Error(out.error);
  return { committed: out.committed, ...(out.sha ? { sha: out.sha } : {}), ...(out.pushed ? { pushed: true } : {}), headAt: (await headCommitMs(dir)) ?? Date.now(), pushFailed, ...(out.error ? { error: out.error } : {}) };
}

export function registerOrgEffects(host: OrgHostApi, orgId: string): void {
  // residence: attach's holder check (r1: the org snapshot's record, the clone's and origin's).
  host.effects.register("read-holder", async (e: Effect) => {
    const dir = typeof e.dir === "string" ? e.dir : dirOfOpen(host, orgId);
    const me = hostIdentity();
    const local = named(parseHolder(host.data(orgSid(orgId))?.holder), me);
    const remote = await remoteHolder(dir, orgId, typeof e.fetchMs === "number" ? e.fetchMs : undefined);
    return { local, remote };
  });

  // residence: commit (a message, or the changed paths named), then push when a remote is set.
  host.effects.register("commit", async (e: Effect) => {
    const dir = dirOfOpen(host, orgId);
    const message = typeof e.message === "string" && e.message ? e.message : `Workspace changes: ${changeSummary(await changedPaths(dir))}`;
    return commitResult(dir, await commitAll(dir, message));
  });

  // residence: a push that failed, retried with nothing to commit.
  host.effects.register("push", async () => {
    const dir = dirOfOpen(host, orgId);
    return commitResult(dir, await retryPush(dir));
  });

  // residence: an attach pauses every project's overseer on this host (host-local watches start fresh).
  host.effects.register("pause-overseers", async () => {
    for (const p of host.sessions("project")) {
      const pid = String(p.data.id ?? "");
      if (!pid) continue;
      const sid = watchSid(orgId, pid);
      if (host.configuration(sid)) await host.act(sid, "org/attached-here", {}, { by: "system" });
      else await host.start(sid, "watch", { orgId, projectId: pid, paused: true }, { by: "system" });
    }
    return {};
  });

  // org / residence: the owner changed, left, or the org was detached: every owner link off.
  host.effects.register("revoke-owner-links", async (e: Effect) => {
    const why = e.why === "detached" || e.why === "left" || e.why === "owner-changed" ? e.why : "off";
    return { revoked: revokeOwnerLinks(orgId, why) };
  });

  // person: someone left: every hand-off and owner link of theirs answers 410 at once.
  host.effects.register("revoke-person-links", async (e: Effect) => {
    const personId = String(e.personId ?? "");
    const sessions = new Set<string>();
    revokeLinks((l) => {
      const hit = l.orgId === orgId && l.personId === personId;
      if (hit) sessions.add(l.sessionId);
      return hit;
    }, Date.now());
    const owner = revokePersonLinks((l) => l.orgId === orgId && l.personId === personId, "left");
    for (const sid of sessions) refreshShare(sid);
    return { sessions: sessions.size, ownerLinks: owner };
  });

  // person: the history lines of a change (roster-history.jsonl, plain data with the values).
  host.effects.register("roster-history", async (e: Effect) => {
    const lines = Array.isArray(e.lines) ? (e.lines as { field: string; from: unknown; to: unknown }[]) : [];
    const rows = appendHistory(orgId, {
      personId: String(e.personId ?? ""),
      lines,
      by: (e.by ?? { kind: "operator" }) as ProfileChange["by"],
      ...(typeof e.revertOf === "string" ? { revertOf: e.revertOf } : {}),
      key: e.key,
    });
    noteWorkspaceWrite(orgId);
    return { written: rows.length };
  });
}

/** The workspace of an open host (its org may be mid-attach: not in the index yet). */
function dirOfOpen(host: OrgHostApi, orgId: string): string {
  try {
    return dirOf(orgId);
  } catch {
    return dirname(host.paths.portable);
  }
}

onOrgHostOpened(registerOrgEffects);

// ---- the residence's view of the repo -----------------------------------------------------------------

/** Every minute: a repo with changes the charts didn't see (a plain file: visits, costs, notes…) tells its residence. */
export const WORKSPACE_LOOK_MS = 60_000;

let probe: NodeJS.Timeout | null = null;
export function startWorkspaceProbe(): void {
  if (probe) return;
  probe = setInterval(() => {
    for (const o of readIndex().orgs)
      void (async () => {
        try {
          if (!hostOf(o.id).configuration(residenceSid(o.id))?.includes("clean")) return;
          if ((await changedPaths(o.dir)).length) noteWorkspaceWrite(o.id);
        } catch {
          // not open: nothing to commit
        }
      })();
  }, WORKSPACE_LOOK_MS);
  probe.unref?.();
}
