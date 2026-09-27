import type { Context, Hono } from "hono";
import { OPERATOR, type BatonInfo, type BatonSession, type BatonStartInput, type OfferInfo, type OfferLink } from "../shared/baton";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { CommitNowOutcome, OrgDetail, OrgNeedsYou, OrgsInfo, PersonInput } from "../shared/orgs";
import { attentionChanged } from "./attention-memo";
import { readConflicts } from "./decisions";
import { allBatons, batonById, batonOfPath, batonSummaryField, closeBaton, createBaton, extendBudget, linkTimes, liveLinkCount, nameOf, namesOf, revokeCurrent, rotateLink, sessionPathOf } from "./baton";
import { moveBaton, offerBaton, scheduleWrapup } from "./baton-loadout";
import { readBatonSettings, writeBatonSettings } from "./baton-settings";
import { BusyError } from "./chat-manager";
import {
  addPerson,
  addProject,
  applyChange,
  approvePerson,
  attachOrg,
  createOrg,
  declinePerson,
  detachOrg,
  orgDetail,
  orgDir,
  orgsInfo,
  OrgError,
  patchOrg,
  patchProject,
  readHistory,
  readOrg,
  readProjects,
  readRoster,
  recentChanges,
  revertChange,
  revertOrgChange,
  setOperatorName,
} from "./orgs";
import { resolveSessionPath } from "./paths";
import { refreshShare } from "./share/hub";
import { shareInfo } from "./share/listener";
import { nudgeMarks } from "./session-feed";
import { personPage, previewAs } from "./person-page";
import { findLink, linksOfOrg, revokePersonLinks } from "./baton-links";
import { lastVisits } from "./visits";
import { commitAll, setRemote } from "./workspace-git";

/**
 * The operator's routes for organizations and baton sessions (§app/organizations, §app/baton). On
 * the main listener only (loopback + tailnet, peer-reachable like every /api route); the share
 * listener never registers them.
 */

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return typeof b === "object" && b !== null && !Array.isArray(b) ? b : {};
  } catch {
    throw new OrgError("Expected a JSON object body");
  }
}

/** A link as the operator copies it: the share listener's public address when known, else the path. */
const linkUrl = (token: string): string => `${shareInfo().publicUrl ?? ""}/h/${token}`;

/** With no share address known, a link is only a path nobody outside can open: every response that
    carries one says so, and the strip shows it (BatonInfo.share). */
export const NO_SHARE_WARNING =
  "No share listener is running on this host, so this link can't be opened from outside. Set SOVA_SHARE_HOST and SOVA_SHARE_PORT (and SOVA_SHARE_PUBLIC_URL behind a proxy), then restart Sova.";
const linkWarning = (): { linkWarning?: string } => (shareInfo().publicUrl ? {} : { linkWarning: NO_SHARE_WARNING });

/** The operator's strip for a baton row (GET /api/baton and every baton route that answers with it). */
export function batonInfo(row: BatonSession): BatonInfo {
  const roster = readRoster(row.orgId);
  const nm = (id: string) => nameOf(row.orgId, id, roster);
  const last = row.offers?.find((o) => o.id === row.offerId) ?? row.offers?.[row.offers.length - 1];
  const offer: OfferInfo | null = last
    ? {
        id: last.id,
        n: last.n,
        to: last.to.map((id) => ({ id, name: nm(id) })),
        state: last.state,
        ...(last.holder ? { holder: { id: last.holder, name: nm(last.holder) } } : {}),
        ...(last.leaseUntil ? { leaseUntil: last.leaseUntil } : {}),
        ...(last.lastActivityAt ? { lastActivityAt: last.lastActivityAt } : {}),
        createdAt: last.createdAt,
      }
    : null;
  return {
    session: row,
    orgName: readOrg(row.orgId).name,
    projectName: readProjects(row.orgId).find((p) => p.id === row.projectId)?.name ?? "",
    names: namesOf(row.orgId),
    active: roster.filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name, role: p.role })),
    liveLinks: liveLinkCount(row),
    linkAt: linkTimes(row),
    share: shareInfo(),
    offer,
    proposed: roster
      .filter((p) => p.status === "proposed" && p.referral?.sessionId === row.sessionId)
      .map((p) => {
        const by = p.referral?.referredBy ?? "";
        return {
          id: p.id,
          name: p.name,
          role: p.role,
          why: p.referral?.why ?? "",
          decides: p.decides,
          referredBy: by === OPERATOR || roster.some((x) => x.id === by) ? nm(by) : by,
          ...(p.referral?.quote ? { quote: p.referral.quote } : {}),
        };
      }),
    wrapup: row.wrapup ?? null,
  };
}

const infoOf = (sid: string): BatonInfo => {
  const hit = batonById(sid);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  return batonInfo(hit.row);
};

/** When a link just minted was minted (its record's own time, so it compares with BatonInfo.linkAt). */
const mintedAt = (token: string): { at?: string } => {
  const at = findLink(token)?.createdAt;
  return at ? { at } : {};
};

const offerLinks = (orgId: string, links: { personId: string; token: string }[]): OfferLink[] =>
  links.map((l) => ({ personId: l.personId, name: nameOf(orgId, l.personId), link: linkUrl(l.token), ...mintedAt(l.token) }));

/** The newest of some ISO times and epoch ms ("" when none parses). */
export function latestTime(times: readonly (string | number | undefined)[]): string {
  let best = -Infinity;
  for (const t of times) {
    const ms = typeof t === "number" ? t : t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms) && ms > best) best = ms;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : "";
}

/** What in one org waits on the operator: the counts, each baton session's reason, each project's conflicts. */
interface Waiting {
  needsYou: OrgNeedsYou;
  batons: Map<string, "reply" | "link">;
  projectConflicts: Record<string, number>;
}

/**
 * What waits on the operator in one org (§app.organizations/org-cards): the items the attention list
 * raises for a baton session (its Needs-you reply, a link to send), the roster's proposed people,
 * and open conflicts routed to the operator that no baton session asks about yet (one that has a
 * session is already that session's reply). `rows` are the org's baton rows.
 */
function waitingIn(orgId: string, dir: string, rows: readonly BatonSession[]): Waiting {
  const w: Waiting = { needsYou: { replies: 0, links: 0, proposals: 0, conflicts: 0, stakeholders: 0 }, batons: new Map(), projectConflicts: {} };
  try {
    w.needsYou.proposals = readRoster(orgId).filter((p) => p.status === "proposed").length;
    for (const project of readProjects(orgId)) {
      if (project.stakeholderCleared) w.needsYou.stakeholders = (w.needsYou.stakeholders ?? 0) + 1;
      const n = readConflicts(orgId, project.id).filter((c) => c.state === "open" && c.routedTo === OPERATOR && !c.batonSessionId).length;
      if (n) w.projectConflicts[project.id] = n;
      w.needsYou.conflicts += n;
    }
  } catch {
    // an unreadable roster counts nothing; its page names the problem
  }
  for (const r of rows) {
    if (r.state !== "open" && r.state !== "needs-you") continue;
    const field = batonSummaryField(sessionPathOf(dir, r));
    if (field?.needsYou) {
      w.needsYou.replies++;
      w.batons.set(r.sessionId, "reply");
    } else if (field?.sendLink) {
      w.needsYou.links++;
      w.batons.set(r.sessionId, "link");
    }
  }
  return w;
}

/**
 * The list's per-org extras (§app.organizations/org-cards): what waits on the operator, and the
 * newest activity: the org's creation, a roster change, a baton row's events, an open baton
 * session file's last write. Files the org already reads for its summary, and one stat per open
 * baton session.
 */
export function withOrgActivity(info: OrgsInfo): OrgsInfo {
  const rows = allBatons();
  return {
    ...info,
    orgs: info.orgs.map((o) => {
      const mine = rows.filter((r) => r.orgId === o.id);
      const times: (string | number | undefined)[] = [o.createdAt];
      try {
        times.push(readHistory(o.id).at(-1)?.at);
      } catch {
        // as above
      }
      for (const r of mine) {
        times.push(r.createdAt, r.closedAt, r.handoffs.at(-1)?.at, ...(r.offers ?? []).map((x) => x.lastActivityAt));
        if (r.state !== "open" && r.state !== "needs-you") continue;
        try {
          times.push(statSync(join(o.dir, r.file)).mtimeMs);
        } catch {
          // not written yet
        }
      }
      const lastActivityAt = latestTime(times);
      return { ...o, needsYou: waitingIn(o.id, o.dir, mine).needsYou, ...(lastActivityAt ? { lastActivityAt } : {}) };
    }),
  };
}

/** An org's page (§app.organizations/org-page): its detail, with what waits on the operator for the tabs' dots. */
export async function orgPage(orgId: string): Promise<OrgDetail> {
  const d = await orgDetail(orgId);
  const w = waitingIn(orgId, d.dir, allBatons().filter((r) => r.orgId === orgId));
  return {
    ...d,
    needsYou: w.needsYou,
    batons: d.batons.map((b) => {
      const why = w.batons.get(b.sessionId);
      return why ? { ...b, waiting: why } : b;
    }),
    projectConflicts: w.projectConflicts,
    ...lastOpenedOf(orgId),
  };
}

/** The People cards' "Last opened" (§app.baton/visits): never fails the page. */
function lastOpenedOf(orgId: string): { lastOpened?: Record<string, { at?: string; minted: boolean }> } {
  try {
    const at = lastVisits(orgId);
    const minted = new Set(linksOfOrg(orgId).map((l) => l.personId));
    const out: Record<string, { at?: string; minted: boolean }> = {};
    for (const pid of new Set([...Object.keys(at), ...minted])) out[pid] = { ...(at[pid] ? { at: at[pid] } : {}), minted: minted.has(pid) };
    return Object.keys(out).length ? { lastOpened: out } : {};
  } catch {
    return {};
  }
}

/** A route param ("" when absent: every lookup then answers 404). */
const p = (c: Context, name: string): string => c.req.param(name) ?? "";

/** Run a handler, turning OrgError (and BusyError) into their statuses. */
const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      const res = await fn(c);
      // A write that landed may have moved Needs you (a hand-off, a link, an approval).
      if (c.req.method !== "GET" && res.ok) attentionChanged();
      return res;
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      if (err instanceof BusyError) return c.json({ error: err.message }, 409);
      throw err;
    }
  };

export function registerOrgRoutes(app: Hono<any>): void {
  app.get("/api/orgs", (c) => c.json(withOrgActivity(orgsInfo())));
  app.post(
    "/api/orgs",
    handle(async (c) => {
      const b = await body(c);
      const org = await createOrg({ name: b.name, dir: b.dir });
      return c.json(await orgPage(org.id), 201);
    }),
  );
  app.post(
    "/api/orgs/attach",
    handle(async (c) => {
      const b = await body(c);
      const org = await attachOrg({ dir: b.dir, confirm: b.confirm });
      return c.json(await orgPage(org.id), 201);
    }),
  );
  app.put(
    "/api/orgs/operator",
    handle(async (c) => {
      setOperatorName((await body(c)).name);
      return c.json(orgsInfo());
    }),
  );
  app.get(
    "/api/orgs/:id",
    handle(async (c) => c.json(await orgPage(p(c, "id")))),
  );
  app.patch(
    "/api/orgs/:id",
    handle(async (c) => {
      const b = await body(c);
      patchOrg(p(c, "id"), { name: b.name, about: b.about });
      return c.json(await orgPage(p(c, "id")));
    }),
  );
  app.post(
    "/api/orgs/:id/about/revert",
    handle(async (c) => {
      const id = p(c, "id");
      const at = (await body(c)).at;
      if (typeof at !== "string") throw new OrgError("at is required");
      revertOrgChange(id, at);
      return c.json(await orgPage(id));
    }),
  );
  app.delete(
    "/api/orgs/:id",
    handle(async (c) => {
      await detachOrg(p(c, "id"));
      return c.json({ ok: true });
    }),
  );
  app.post(
    "/api/orgs/:id/commit",
    handle(async (c) => {
      const id = p(c, "id");
      const out = await commitAll(orgDir(id), `Commit now (${readOrg(id).name})`);
      if (out.error) return c.json({ error: out.error }, 502);
      const commit: CommitNowOutcome = { committed: out.committed, ...(out.sha ? { sha: out.sha } : {}), ...(out.pushed ? { pushed: true } : {}) };
      return c.json({ ...(await orgPage(id)), commit });
    }),
  );
  app.put(
    "/api/orgs/:id/remote",
    handle(async (c) => {
      const id = p(c, "id");
      const url = (await body(c)).url;
      if (typeof url !== "string" || url.length > 500 || /\s/.test(url.trim())) throw new OrgError("url must be a git remote URL, or empty to remove it");
      await setRemote(orgDir(id), url.trim());
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/people",
    handle(async (c) => {
      const id = p(c, "id");
      addPerson(id, (await body(c)) as unknown as PersonInput);
      return c.json(await orgPage(id), 201);
    }),
  );
  app.patch(
    "/api/orgs/:id/people/:pid",
    handle(async (c) => {
      const id = p(c, "id");
      applyChange(id, p(c, "pid"), await body(c), { kind: "operator" });
      nudgeMarks(); // a renamed or re-statused person may be a baton holder or a waiting referral
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/people/:pid/approve",
    handle(async (c) => {
      const id = p(c, "id");
      approvePerson(id, p(c, "pid"));
      nudgeMarks(); // the session that proposed them loses its Approve item: re-diff the list now
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/people/:pid/decline",
    handle(async (c) => {
      const id = p(c, "id");
      declinePerson(id, p(c, "pid"));
      nudgeMarks();
      return c.json(await orgPage(id));
    }),
  );
  app.get(
    "/api/orgs/:id/changes",
    handle((c) => {
      const limit = Number(c.req.query("limit") ?? 50);
      return c.json(recentChanges(p(c, "id"), Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50));
    }),
  );
  app.get(
    "/api/orgs/:id/people/:pid",
    handle((c) => c.json(personPage(p(c, "id"), p(c, "pid")))),
  );
  app.get(
    "/api/orgs/:id/people/:pid/preview",
    handle(async (c) => c.json(await previewAs(p(c, "id"), p(c, "pid"), c.req.query("session") ?? ""))),
  );
  app.post(
    "/api/orgs/:id/people/:pid/links/revoke",
    handle(async (c) => {
      const id = p(c, "id");
      const pid = p(c, "pid");
      if (!readRoster(id).some((x) => x.id === pid)) throw new OrgError("Unknown person", 404);
      const b = await body(c).catch(() => ({}) as Record<string, unknown>);
      const one = b.sessionId !== undefined || b.n !== undefined;
      if (one && (typeof b.sessionId !== "string" || !Number.isInteger(b.n))) throw new OrgError("Give both sessionId and n, or neither");
      const changed = revokePersonLinks(id, pid, one ? { sessionId: b.sessionId as string, n: b.n as number } : undefined);
      if (one && !changed.length) throw new OrgError("That link isn't open.", 409);
      for (const sid of changed) refreshShare(sid);
      return c.json(personPage(id, pid));
    }),
  );
  app.get(
    "/api/orgs/:id/people/:pid/history",
    handle((c) => c.json(readHistory(p(c, "id"), p(c, "pid")).reverse())),
  );
  app.post(
    "/api/orgs/:id/people/:pid/revert",
    handle(async (c) => {
      const id = p(c, "id");
      const at = (await body(c)).at;
      if (typeof at !== "string") throw new OrgError("at is required");
      revertChange(id, p(c, "pid"), at);
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/projects",
    handle(async (c) => {
      const id = p(c, "id");
      const b = await body(c);
      addProject(id, { name: b.name, root: b.root });
      return c.json(await orgPage(id), 201);
    }),
  );
  app.patch(
    "/api/orgs/:id/projects/:pid",
    handle(async (c) => {
      const id = p(c, "id");
      const b = await body(c);
      patchProject(id, p(c, "pid"), { name: b.name, root: b.root, ...(b.spec !== undefined ? { spec: b.spec } : {}), ...(b.stakeholder !== undefined ? { stakeholder: b.stakeholder } : {}) });
      return c.json(await orgPage(id));
    }),
  );

  // ---- baton sessions --------------------------------------------------------------------------------

  app.post(
    "/api/baton",
    handle(async (c) => {
      const b = await body(c);
      // `owner` is for in-process callers (the project overseer, the reconciler), never a request.
      const { owner: _owner, mintLink: _mint, ...input } = b;
      const created = createBaton(input as unknown as BatonStartInput);
      const orgId = String(b.orgId);
      return c.json(
        {
          path: created.path,
          sessionId: created.sessionId,
          ...(created.token ? { link: linkUrl(created.token) } : {}),
          ...(created.links ? { links: offerLinks(orgId, created.links) } : {}),
          ...(created.token || created.links ? linkWarning() : {}),
        },
        201,
      );
    }),
  );
  app.get("/api/baton/settings", (c) => c.json(readBatonSettings()));
  app.put(
    "/api/baton/settings",
    handle(async (c) => {
      const result = writeBatonSettings(await body(c));
      if ("error" in result) throw new OrgError(result.error, 400);
      return c.json(result);
    }),
  );
  app.post(
    "/api/baton/:sid/extend",
    handle(async (c) => {
      const sid = p(c, "sid");
      extendBudget(sid, (await body(c)).by);
      refreshShare(sid);
      return c.json(infoOf(sid));
    }),
  );
  app.get(
    "/api/baton",
    handle((c) => {
      const path = resolveSessionPath(c.req.query("path"));
      const hit = path ? batonOfPath(path) : null;
      if (!hit) return c.json({ error: "Not a baton session" }, 404);
      return c.json(batonInfo(hit.row));
    }),
  );
  app.get(
    "/api/baton/:sid/link",
    handle((c) => {
      const person = c.req.query("person");
      const { token, n } = rotateLink(p(c, "sid"), person || undefined);
      return c.json({ link: linkUrl(token), n, ...mintedAt(token), ...linkWarning() });
    }),
  );
  app.post(
    "/api/baton/:sid/revoke",
    handle((c) => {
      const sid = p(c, "sid");
      revokeCurrent(sid);
      refreshShare(sid);
      return c.json({ ok: true });
    }),
  );
  app.post(
    "/api/baton/:sid/take",
    handle(async (c) => {
      const sid = p(c, "sid");
      const hit = batonById(sid);
      if (!hit) throw new OrgError("Unknown baton session", 404);
      if (hit.row.holder === OPERATOR) throw new OrgError("You already hold the baton.", 409);
      await moveBaton(sid, OPERATOR, "(taken back)", "", { interrupt: true });
      return c.json({ ok: true });
    }),
  );
  app.post(
    "/api/baton/:sid/close",
    handle((c) => {
      const sid = p(c, "sid");
      closeBaton(sid);
      refreshShare(sid);
      // Closing ends it as goal_done does: the wrap-up runs (now, or when a running reply settles).
      scheduleWrapup(sid);
      return c.json({ ok: true });
    }),
  );
  app.post(
    "/api/baton/:sid/offer",
    handle(async (c) => {
      const sid = p(c, "sid");
      const b = await body(c);
      if (!Array.isArray(b.to)) throw new OrgError("to must be a list of people");
      const hit = batonById(sid);
      if (!hit) throw new OrgError("Unknown baton session", 404);
      const out = await offerBaton(sid, b.to, typeof b.question === "string" ? b.question : "", typeof b.briefing === "string" ? b.briefing : "", { interrupt: true });
      return c.json({ info: infoOf(sid), links: offerLinks(hit.row.orgId, out.links), ...linkWarning() }, 201);
    }),
  );
  app.post(
    "/api/baton/:sid/offer/withdraw",
    handle(async (c) => {
      const sid = p(c, "sid");
      const hit = batonById(sid);
      if (!hit) throw new OrgError("Unknown baton session", 404);
      if (!hit.row.offerId) throw new OrgError("There is no open offer.", 409);
      await moveBaton(sid, OPERATOR, "(offer withdrawn)", "", { interrupt: true });
      return c.json(infoOf(sid));
    }),
  );
  app.post(
    "/api/baton/:sid/handoff",
    handle(async (c) => {
      const sid = p(c, "sid");
      const b = await body(c);
      const hit = batonById(sid);
      if (!hit) throw new OrgError("Unknown baton session", 404);
      const to = typeof b.to === "string" ? b.to : "";
      const target = readRoster(hit.row.orgId).find((x) => x.id === to);
      if (!target) throw new OrgError("to must be a roster person's id", 400);
      if (target.status !== "active") throw new OrgError(target.status === "proposed" ? `Approve ${target.name} first.` : `${target.name} is not active.`, 409);
      const question = typeof b.question === "string" ? b.question.trim().slice(0, 1000) : "";
      if (!question) throw new OrgError("question is required");
      const briefing = typeof b.briefing === "string" ? b.briefing.trim().slice(0, 4000) : "";
      await moveBaton(sid, to, question, briefing, { interrupt: true });
      const { token } = rotateLink(sid);
      return c.json({ info: infoOf(sid), link: linkUrl(token), ...mintedAt(token), ...linkWarning() });
    }),
  );
}

