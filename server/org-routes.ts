import type { Context, Hono } from "hono";
import { OPERATOR, type BatonInfo, type BatonSession, type BatonStartInput, type OfferInfo, type OfferLink } from "../shared/baton";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { CommitNowOutcome, OrgDetail, OrgNeedsYou, OrgsInfo, PersonInput } from "../shared/orgs";
import { attentionChanged } from "./attention-memo";
import { unroutedConflicts } from "./decisions";
import { allBatons, batonById, batonOfPath, batonSummaryField, closeBaton, createBaton, extendBudget, handoffTo, linkTimes, liveLinkCount, nameOf, namesOf, offerTo, revokeCurrent, rotateLink, sessionPathOf, setAbilities, setHiddenFromOwner, takeBack, withdrawOffer } from "./baton";
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
  operatorEnvelope,
  patchOrg,
  patchProject,
  readHistory,
  readOrg,
  readOrgOrPlaceholder,
  readProjects,
  readRoster,
  recentChanges,
  revertChange,
  revertOrgChange,
  revertOrgHoursChange,
  setOrgHours,
  residenceSid,
  setOperatorName,
  setProjectArchived,
  type OperatorBy,
} from "./orgs";
import { OVERSEER_SENDER_HEADER, overseerSender } from "./overseer";
import { OVERSEER_CARD_HEADER } from "./overseer-tools";
import type { EnvelopeCard } from "./org-envelope";
import { archiveBlockers } from "./project-overseer";
import { cancelHeld, heldActs, holdItem, itemTimeline, pipelineInfo } from "./project-pipeline";
import { resolveSessionPath } from "./paths";
import { refreshShare } from "./share/hub";
import { awaitShareLinks } from "./share/links-events";
import { linkUrl as shareLinkUrl, linkWarning, shareInfo, shareState } from "./share/listener";
import { nudgeMarks } from "./session-feed";
import { personPage, previewAs } from "./person-page";
import { findLink, linksOfOrg, revokePersonLinks } from "./baton-links";
import { lastVisits } from "./visits";
import type { OwnerLinkResult } from "../shared/owner";
import { mintOwnerLinkFor, ownerLinkNeeds, ownerPageInfo, revokeOwnerLinks, setOwner } from "./owner";
import { ownerView } from "./owner-page";
import { readUpdates, withdrawUpdate } from "./project-updates";
import { setRemote } from "./workspace-git";
import { actOrThrow, hostOf } from "./org-engine";

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

/** A hand-off link as the operator copies it (the one helper, server/share/listener.ts): the
    effective public address when known, else the path. Every response carrying a just-minted link
    carries its linkWarning too, when it may not open from outside (§app.baton/links). */
const linkUrl = (token: string): string => shareLinkUrl("h", token);

/** The operator's strip for a baton row (GET /api/baton and every baton route that answers with it). */
export function batonInfo(row: BatonSession): BatonInfo {
  const roster = readRoster(row.orgId);
  const nm = (id: string) => nameOf(row.orgId, id, roster);
  const last = row.offers?.find((o) => o.id === row.offerId) ?? row.offers?.[row.offers.length - 1];
  const offer: OfferInfo | null = last
    ? {
        id: last.id,
        n: last.n,
        to: last.to.map((id) => ({ id, name: nm(id), ...(last.reach?.[id] ? { reach: last.reach[id] } : {}) })),
        state: last.state,
        ...(last.holder ? { holder: { id: last.holder, name: nm(last.holder) } } : {}),
        ...(last.leaseUntil ? { leaseUntil: last.leaseUntil } : {}),
        ...(last.lastActivityAt ? { lastActivityAt: last.lastActivityAt } : {}),
        createdAt: last.createdAt,
      }
    : null;
  return {
    session: row,
    orgName: readOrgOrPlaceholder(row.orgId).name,
    projectName: readProjects(row.orgId).find((p) => p.id === row.projectId)?.name ?? "",
    names: namesOf(row.orgId),
    active: roster.filter((p) => p.status === "active").map((p) => ({ id: p.id, name: p.name, role: p.role, ...(p.tz ? { tz: p.tz } : {}), ...(p.hoursNow ? { hoursNow: p.hoursNow } : {}) })),
    liveLinks: liveLinkCount(row),
    linkAt: linkTimes(row),
    share: { ...shareInfo(), state: shareState() },
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
    owner: ownerName(row.orgId, roster),
  };
}

/** The org's owner's name for the strip's Hide From {first}, or null. */
function ownerName(orgId: string, roster: ReturnType<typeof readRoster>): { name: string } | null {
  const id = readOrgOrPlaceholder(orgId).owner;
  const p = id ? roster.find((x) => x.id === id && x.status === "active") : undefined;
  return p ? { name: p.name } : null;
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
  const w: Waiting = { needsYou: { replies: 0, links: 0, proposals: 0, conflicts: 0, stakeholders: 0, ownerLink: 0, held: 0 }, batons: new Map(), projectConflicts: {} };
  try {
    w.needsYou.ownerLink = ownerLinkNeeds(orgId);
    // Acts waiting in a hold, one each as in Needs you (the same held-act items).
    w.needsYou.held = heldActs(orgId).length;
    w.needsYou.proposals = readRoster(orgId).filter((p) => p.status === "proposed").length;
    for (const project of readProjects(orgId)) {
      if (project.stakeholderCleared) w.needsYou.stakeholders = (w.needsYou.stakeholders ?? 0) + 1;
      const n = unroutedConflicts(orgId, project.id);
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

/** What waits on the operator in one org, and why per baton session: for the global Overseer's reads,
    which never take the org detail (it carries the About text). */
export function orgWaiting(orgId: string): { needsYou: OrgNeedsYou; batons: Map<string, "reply" | "link"> } {
  const w = waitingIn(orgId, orgDir(orgId), allBatons().filter((r) => r.orgId === orgId));
  return { needsYou: w.needsYou, batons: w.batons };
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
    ownerPage: ownerPageInfo(orgId),
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

/**
 * Who a write is recorded as (§app.overseer/org-attribution): the operator, and when the request
 * carries the server's sender secret (the global Overseer's own in-process call), the operator
 * through the Overseer. Nothing in a body can claim it.
 */
export function operatorBy(c: Context): OperatorBy {
  const overseerId = overseerSender(c.req.header(OVERSEER_SENDER_HEADER));
  if (!overseerId) return { kind: "operator" };
  const card = cardOf(c.req.header(OVERSEER_CARD_HEADER));
  return { kind: "operator", via: "overseer", overseerId, ...(card ? { card } : {}) };
}

/** The confirm card the Overseer's tool call carried (overseer-tools cardHeader); null when none or unreadable. */
function cardOf(header: string | undefined): EnvelopeCard | null {
  if (!header) return null;
  try {
    const v = JSON.parse(header) as Record<string, unknown>;
    const ids = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
    return { people: ids("people"), projects: ids("projects"), sessions: ids("sessions") };
  } catch {
    return null;
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
      await patchOrg(p(c, "id"), { name: b.name, about: b.about }, operatorBy(c));
      return c.json(await orgPage(p(c, "id")));
    }),
  );
  // r13: the company's working hours (the default for anyone without their own), operator only.
  app.put(
    "/api/orgs/:id/hours",
    handle(async (c) => {
      const id = p(c, "id");
      const b = await body(c);
      await setOrgHours(id, { tz: b.tz, hours: b.hours }, operatorBy(c));
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/hours/revert",
    handle(async (c) => {
      const id = p(c, "id");
      const at = (await body(c)).at;
      if (typeof at !== "string") throw new OrgError("at is required");
      await revertOrgHoursChange(id, at, operatorBy(c));
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/about/revert",
    handle(async (c) => {
      const id = p(c, "id");
      const at = (await body(c)).at;
      if (typeof at !== "string") throw new OrgError("at is required");
      revertOrgChange(id, at, operatorBy(c));
      return c.json(await orgPage(id));
    }),
  );
  app.delete(
    "/api/orgs/:id",
    handle(async (c) => {
      // Its owner link stops working here; an attach elsewhere sends a new one.
      if (orgDir(p(c, "id"))) revokeOwnerLinks(p(c, "id"), "detached");
      await detachOrg(p(c, "id"));
      return c.json({ ok: true });
    }),
  );
  app.post(
    "/api/orgs/:id/commit",
    handle(async (c) => {
      const id = p(c, "id");
      // The residence commits at once (its `commit` effect); the answer is what that commit did.
      const act = await actOrThrow(id, residenceSid(id), "commit/now", { message: `Commit now (${readOrg(id).name})` }, operatorEnvelope(id, null, operatorBy(c)), { settle: true });
      const done = act.effects?.find((e) => e.kind === "commit");
      if (!done) return c.json({ error: "Nothing was committed: the workspace's commit did not run." }, 502);
      if (done.error) return c.json({ error: done.error }, 502);
      const out = (done.result ?? {}) as { committed?: boolean; sha?: string; pushed?: boolean; error?: string };
      if (out.error) return c.json({ error: out.error }, 502);
      const commit: CommitNowOutcome = { committed: !!out.committed, ...(out.sha ? { sha: out.sha } : {}), ...(out.pushed ? { pushed: true } : {}) };
      return c.json({ ...(await orgPage(id)), commit });
    }),
  );
  // The Workspace tab's Reload: retry what did not load (a fixed journal, a restored snapshot); the page's
  // `problems` are what is still wrong.
  app.post(
    "/api/orgs/:id/reload",
    handle(async (c) => {
      const id = p(c, "id");
      orgDir(id); // 404 for an unknown org
      await hostOf(id).reload();
      return c.json(await orgPage(id));
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
      await addPerson(id, (await body(c)) as unknown as PersonInput, operatorBy(c));
      return c.json(await orgPage(id), 201);
    }),
  );
  app.patch(
    "/api/orgs/:id/people/:pid",
    handle(async (c) => {
      const id = p(c, "id");
      await applyChange(id, p(c, "pid"), await body(c), operatorBy(c));
      nudgeMarks(); // a renamed or re-statused person may be a baton holder or a waiting referral
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/people/:pid/approve",
    handle(async (c) => {
      const id = p(c, "id");
      await approvePerson(id, p(c, "pid"), operatorBy(c));
      nudgeMarks(); // the session that proposed them loses its Approve item: re-diff the list now
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/people/:pid/decline",
    handle(async (c) => {
      const id = p(c, "id");
      await declinePerson(id, p(c, "pid"), operatorBy(c));
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
      await revertChange(id, p(c, "pid"), at, operatorBy(c));
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/projects",
    handle(async (c) => {
      const id = p(c, "id");
      const b = await body(c);
      await addProject(id, { name: b.name, root: b.root });
      return c.json(await orgPage(id), 201);
    }),
  );
  app.patch(
    "/api/orgs/:id/projects/:pid",
    handle(async (c) => {
      const id = p(c, "id");
      const b = await body(c);
      await patchProject(id, p(c, "pid"), {
        name: b.name,
        root: b.root,
        ...(b.spec !== undefined ? { spec: b.spec } : {}),
        ...(b.stakeholder !== undefined ? { stakeholder: b.stakeholder } : {}),
        ...(b.ownerHidden !== undefined ? { ownerHidden: b.ownerHidden } : {}),
      }, operatorBy(c));
      return c.json(await orgPage(id));
    }),
  );
  // Archive Project (§app.organizations/archive): refused while anything in it is open, naming each.
  app.post(
    "/api/orgs/:id/projects/:pid/archive",
    handle(async (c) => {
      const id = p(c, "id");
      const pid = p(c, "pid");
      if (!readProjects(id).some((x) => x.id === pid)) throw new OrgError("Unknown project", 404);
      await setProjectArchived(id, pid, true, operatorBy(c), await archiveBlockers(id, pid));
      nudgeMarks(); // its sessions leave the Organizations region: re-diff the list now
      return c.json(await orgPage(id));
    }),
  );
  app.post(
    "/api/orgs/:id/projects/:pid/unarchive",
    handle(async (c) => {
      const id = p(c, "id");
      await setProjectArchived(id, p(c, "pid"), false, operatorBy(c));
      nudgeMarks();
      return c.json(await orgPage(id));
    }),
  );

  // ---- the Pipeline and held acts (§app.project-overseer/pipeline, /holds) ---------------------------------

  app.get(
    "/api/orgs/:id/projects/:pid/pipeline",
    handle((c) => c.json(pipelineInfo(p(c, "id"), p(c, "pid")))),
  );
  app.post(
    "/api/orgs/:id/projects/:pid/pipeline/:itemId/hold",
    handle(async (c) => c.json(await holdItem(p(c, "id"), p(c, "pid"), p(c, "itemId"), false, operatorBy(c)))),
  );
  app.post(
    "/api/orgs/:id/projects/:pid/pipeline/:itemId/resume",
    handle(async (c) => c.json(await holdItem(p(c, "id"), p(c, "pid"), p(c, "itemId"), true, operatorBy(c)))),
  );
  app.get(
    "/api/orgs/:id/projects/:pid/pipeline/:itemId/timeline",
    handle((c) => c.json(itemTimeline(p(c, "id"), p(c, "pid"), p(c, "itemId"), { includeQuiet: c.req.query("quiet") === "1" }))),
  );
  // The operator's Cancel on a held act (Needs you, the Pipeline): the chart's hold/cancel.
  app.post(
    "/api/orgs/:id/held/:holdId/cancel",
    handle(async (c) => {
      const b = await body(c).catch(() => ({}) as Record<string, unknown>);
      const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : undefined;
      await cancelHeld(p(c, "id"), p(c, "holdId"), reason, operatorBy(c));
      attentionChanged();
      return c.json({ ok: true as const });
    }),
  );

  // ---- the owner and the Owner page (§app.owner-page) -----------------------------------------------

  app.put(
    "/api/orgs/:id/owner",
    handle(async (c) => {
      const id = p(c, "id");
      const b = await body(c);
      if (!("personId" in b)) throw new OrgError("personId is required (null: no owner)");
      await setOwner(id, b.personId, operatorBy(c));
      return c.json(await orgPage(id));
    }),
  );
  app.get(
    "/api/orgs/:id/owner/link",
    handle(async (c) => {
      const { result: rec, outcome } = await awaitShareLinks(() => mintOwnerLinkFor(p(c, "id")));
      const out: OwnerLinkResult = { link: shareLinkUrl("i", rec.token), createdAt: rec.createdAt, expiresAt: rec.expiresAt, ...linkWarning(outcome) };
      return c.json(out);
    }),
  );
  app.post(
    "/api/orgs/:id/owner/revoke",
    handle(async (c) => {
      const id = p(c, "id");
      revokeOwnerLinks(id);
      return c.json(await orgPage(id));
    }),
  );
  // Preview Owner Page: the same function the owner's link calls; no token, no visit.
  app.get(
    "/api/orgs/:id/owner/preview",
    handle(async (c) => {
      const project = c.req.query("project");
      const conversation = c.req.query("c");
      return c.json(await ownerView(p(c, "id"), { ...(project !== undefined ? { project } : {}), ...(conversation !== undefined ? { conversation } : {}) }));
    }),
  );
  app.get(
    "/api/orgs/:id/projects/:pid/updates",
    handle((c) => {
      const id = p(c, "id");
      if (!readProjects(id).some((x) => x.id === p(c, "pid"))) throw new OrgError("Unknown project", 404);
      return c.json(readUpdates(id, p(c, "pid")));
    }),
  );
  app.post(
    "/api/orgs/:id/projects/:pid/updates/:uid/withdraw",
    handle((c) => {
      const id = p(c, "id");
      if (!readProjects(id).some((x) => x.id === p(c, "pid"))) throw new OrgError("Unknown project", 404);
      withdrawUpdate(id, p(c, "pid"), p(c, "uid"));
      return c.json(readUpdates(id, p(c, "pid")));
    }),
  );

  // ---- baton sessions --------------------------------------------------------------------------------

  app.post(
    "/api/baton",
    handle(async (c) => {
      const b = await body(c);
      // `owner` is for in-process callers (the project overseer, the reconciler), never a request.
      const { owner: _owner, mintLink: _mint, startedVia: _via, ...input } = b;
      const { result: created, outcome } = await awaitShareLinks(() => createBaton(input as unknown as BatonStartInput, { by: operatorBy(c) }));
      const orgId = String(b.orgId);
      return c.json(
        {
          path: created.path,
          sessionId: created.sessionId,
          ...(created.token ? { link: linkUrl(created.token) } : {}),
          ...(created.links ? { links: offerLinks(orgId, created.links) } : {}),
          ...(created.token || created.links ? linkWarning(outcome) : {}),
          ...(created.offHours ? { offHours: created.offHours } : {}),
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
  // What it can do, the operator's change from the strip (§app.baton/abilities): from its next run.
  app.post(
    "/api/baton/:sid/abilities",
    handle(async (c) => {
      const sid = p(c, "sid");
      await setAbilities(sid, await body(c), operatorBy(c));
      return c.json(infoOf(sid));
    }),
  );
  app.post(
    "/api/baton/:sid/extend",
    handle(async (c) => {
      const sid = p(c, "sid");
      await extendBudget(sid, (await body(c)).by, operatorBy(c));
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
    handle(async (c) => {
      const person = c.req.query("person");
      const { result, outcome } = await awaitShareLinks(() => rotateLink(p(c, "sid"), person || undefined));
      const { token, n } = result;
      return c.json({ link: linkUrl(token), n, ...mintedAt(token), ...linkWarning(outcome) });
    }),
  );
  app.post(
    "/api/baton/:sid/owner",
    handle(async (c) => {
      const sid = p(c, "sid");
      const hidden = (await body(c)).hidden;
      if (typeof hidden !== "boolean") throw new OrgError("hidden must be true or false");
      await setHiddenFromOwner(sid, hidden, operatorBy(c));
      return c.json(infoOf(sid));
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
  // The operator's moves (§app.baton/hand-off): the chart checks them, stops a reply in flight, moves.
  app.post(
    "/api/baton/:sid/take",
    handle(async (c) => {
      await takeBack(p(c, "sid"), operatorBy(c));
      return c.json({ ok: true });
    }),
  );
  app.post(
    "/api/baton/:sid/close",
    handle(async (c) => {
      // Closing ends it as goal_done does: the chart runs the wrap-up (now, or when a running reply ends).
      await closeBaton(p(c, "sid"), { by: operatorBy(c) });
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
      const { result: out, outcome } = await awaitShareLinks(() => offerTo(sid, b.to as unknown[], typeof b.question === "string" ? b.question : "", typeof b.briefing === "string" ? b.briefing : "", { by: operatorBy(c) }));
      return c.json({ info: infoOf(sid), links: offerLinks(hit.row.orgId, out.links), ...linkWarning(outcome) }, 201);
    }),
  );
  app.post(
    "/api/baton/:sid/offer/withdraw",
    handle(async (c) => {
      const sid = p(c, "sid");
      await withdrawOffer(sid, operatorBy(c));
      return c.json(infoOf(sid));
    }),
  );
  app.post(
    "/api/baton/:sid/handoff",
    handle(async (c) => {
      const sid = p(c, "sid");
      const b = await body(c);
      if (!batonById(sid)) throw new OrgError("Unknown baton session", 404);
      const to = typeof b.to === "string" ? b.to : "";
      const question = typeof b.question === "string" ? b.question.trim().slice(0, 1000) : "";
      const briefing = typeof b.briefing === "string" ? b.briefing.trim().slice(0, 4000) : "";
      // The chart refuses who and what in today's words; the link is the move's own (shown once).
      const { result, outcome } = await awaitShareLinks(async () => {
        const moved = await handoffTo(sid, to, question, briefing, operatorBy(c));
        return { ...(moved.token ? { token: moved.token } : rotateLink(sid)), offHours: moved.offHours };
      });
      const { token, offHours } = result;
      return c.json({ info: infoOf(sid), link: linkUrl(token), ...mintedAt(token), ...linkWarning(outcome), ...(offHours ? { offHours } : {}) });
    }),
  );
}

