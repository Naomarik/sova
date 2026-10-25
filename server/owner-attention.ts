import type { AttentionItem } from "../shared/protocol";
import { ownerAskOpen, ownerPageInfo } from "./owner";
import { readIndex, readOrgOrPlaceholder, readProjects, readRoster } from "./orgs";
import { featureChats, orgRequests } from "./project-assistant-store";
import { batonById } from "./baton";
import { convergeFeatureChats } from "./feature-chats";
import { heldRequestIds } from "./project-holds";

/**
 * The owner's asks in Needs you (§app.project-assistant/requests, §app.owner-page/link), act tier,
 * every open owner request (`owner-request`; an outage `owner-outage`, which a phone notification also
 * tells), each opening the org's Requests tab at that request; an open `try` request is an
 * `owner-version-request`, opening the project's Branches tab; and an owner who asked for a new link
 * (`owner-link-request`), opening the People tab (its Owner card); and a request the owner closed while it was
 * being worked on (`owner-request-closed`, until the operator's Got It). A request the owner closed otherwise leaves
 * Needs you quietly. No session: `path` "".
 */

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

const KIND_WORD: Record<string, string> = { bug: "a problem", outage: "that the app is down", question: "a question", feature: "a new feature", fix: "a fix", deploy: "a release", try: "a version to try" };

export function ownerAttention(): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const o of readIndex().orgs) {
    let orgName = "";
    let projects: { id: string; name: string }[] = [];
    let ownerName = "";
    try {
      const info = ownerPageInfo(o.id);
      if (!info.person) continue;
      ownerName = info.person.name;
      orgName = readOrgOrPlaceholder(o.id).name;
      projects = readProjects(o.id);
      if (info.link?.askedAt && ownerAskOpen(info))
        out.push({
          id: `owner-link-request:${o.id}`,
          path: "",
          title: ownerName,
          where: orgName,
          tier: "act",
          kind: "owner-link-request",
          since: Date.parse(info.link.askedAt) || 0,
          detail: `${ownerName} asks for a new owner link: theirs turned off after a week without use.`,
          href: `#/orgs/${encodeURIComponent(o.id)}/people`,
          org: { orgId: o.id, orgName },
        });
    } catch {
      continue;
    }
    let requests;
    try {
      requests = orgRequests(o.id);
    } catch {
      continue;
    }
    // Feature request chats (§app.project-assistant/feature-chats), by their request.
    // First the sweep: a former owner's chat still open is recorded as ended now and closed in the background, so
    // an owner change whose close failed, or never ran before a restart, converges on this scan.
    let chats: ReturnType<typeof featureChats> = [];
    try {
      convergeFeatureChats(o.id);
      chats = featureChats(o.id);
    } catch {
      chats = [];
    }
    // Who opened a chat: its record's person, never whoever is the owner now (an agreed plan outlives an owner change).
    const personName = (personId: string, fallback: string): string => {
      try {
        return readRoster(o.id).find((p) => p.id === personId)?.name ?? fallback;
      } catch {
        return fallback;
      }
    };
    const heldBy = new Map<string, Set<string>>();
    const held = (pid: string): Set<string> => {
      let x = heldBy.get(pid);
      if (!x) {
        try {
          x = heldRequestIds(pid);
        } catch {
          x = new Set();
        }
        heldBy.set(pid, x);
      }
      return x;
    };
    for (const r of requests) {
      // Closed by the owner while the team was working on it (§app.project-assistant/closing): one item, until Got It.
      if (r.status === "closed" && r.closed && r.closed.prior === "started" && !r.closed.noted) {
        const project = projects.find((p) => p.id === r.projectId);
        out.push({
          id: `owner-request-closed:${r.id}:${r.closed.at}`,
          path: "",
          title: r.title,
          where: orgName,
          tier: "act",
          kind: "owner-request-closed",
          since: Date.parse(r.closed.at) || 0,
          detail: clip(`${ownerName} closed a request the team was working on, on ${project?.name ?? "a project"}: ${r.title}`, 200),
          href: `#/orgs/${encodeURIComponent(o.id)}/requests/${encodeURIComponent(r.id)}`,
          org: { orgId: o.id, orgName, ...(project ? { projectId: project.id, projectName: project.name } : {}) },
        });
        continue;
      }
      if (r.status !== "with-team") continue;
      // A fix whose start waits in a hold is the held act's (its own Needs you item, with Cancel), not a request for the operator.
      if (r.kind === "fix" && held(r.projectId).has(r.id)) continue;
      const chat = r.kind === "feature" ? chats.find((c) => c.requestId === r.id) : undefined;
      if (chat?.ended) {
        const project = projects.find((p) => p.id === r.projectId);
        const former = personName(chat.personId, "The former owner");
        out.push({
          id: `owner-feature-ended:${r.id}`,
          path: "",
          title: r.title,
          where: orgName,
          tier: "act",
          kind: "owner-feature-ended",
          since: Date.parse(chat.ended.at) || 0,
          detail: clip(`${former}'s feature request chat on ${project?.name ?? "a project"} ended: they are no longer the owner. ${r.title}`, 200),
          href: `#/orgs/${encodeURIComponent(o.id)}/requests/${encodeURIComponent(r.id)}`,
          org: { orgId: o.id, orgName, ...(project ? { projectId: project.id, projectName: project.name } : {}) },
        });
        continue;
      }
      if (chat) {
        const project = projects.find((p) => p.id === r.projectId);
        const state = batonById(chat.sessionId)?.row.state;
        const who = personName(chat.personId, ownerName);
        const detail = state === "done" ? `${who} agreed a plan on ${project?.name ?? "a project"}: ${r.title}` : state === "open" || state === "needs-you" ? `${who} is planning a new feature with the assistant on ${project?.name ?? "a project"}: ${r.title}` : null;
        if (detail) {
          out.push({
            // An agreed plan is news of its own: its own id, so whatever was told or put aside about the planning
            // item (the Overseer's brief remembers items by id and kind) never covers it.
            id: state === "done" ? `owner-request:${r.id}:agreed` : `owner-request:${r.id}`,
            path: "",
            title: r.title,
            where: orgName,
            tier: "act",
            kind: "owner-request",
            since: Date.parse(r.createdAt) || 0,
            detail: clip(detail, 200),
            href: `#/orgs/${encodeURIComponent(o.id)}/requests/${encodeURIComponent(r.id)}`,
            org: { orgId: o.id, orgName, ...(project ? { projectId: project.id, projectName: project.name } : {}) },
          });
          continue;
        }
      }
      const project = projects.find((p) => p.id === r.projectId);
      // A version the owner asked to try (§app.project-assistant/requests): opens the project's Branches tab.
      if (r.kind === "try") {
        out.push({
          id: `owner-request:${r.id}`,
          path: "",
          title: r.title,
          where: orgName,
          tier: "act",
          kind: "owner-version-request",
          since: Date.parse(r.createdAt) || 0,
          detail: clip(`${ownerName} asks to try ${project?.name ?? "a project"}: ${r.title}`, 200),
          href: project ? `#/projects/${encodeURIComponent(project.id)}/branches` : `#/orgs/${encodeURIComponent(o.id)}/people`,
          org: { orgId: o.id, orgName, ...(project ? { projectId: project.id, projectName: project.name } : {}) },
        });
        continue;
      }
      out.push({
        id: `owner-request:${r.id}`,
        path: "",
        title: r.title,
        where: orgName,
        tier: "act",
        kind: r.kind === "outage" ? "owner-outage" : "owner-request",
        since: Date.parse(r.createdAt) || 0,
        detail: clip(`${ownerName} reports ${KIND_WORD[r.kind] ?? "something"}${project ? ` on ${project.name}` : ""}: ${r.title}`, 200),
        href: `#/orgs/${encodeURIComponent(o.id)}/requests/${encodeURIComponent(r.id)}`,
        org: { orgId: o.id, orgName, ...(project ? { projectId: project.id, projectName: project.name } : {}) },
      });
    }
  }
  return out;
}
