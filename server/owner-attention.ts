import type { AttentionItem } from "../shared/protocol";
import { ownerAskOpen, ownerPageInfo } from "./owner";
import { readIndex, readOrgOrPlaceholder, readProjects } from "./orgs";
import { orgRequests } from "./project-assistant-store";

/**
 * The owner's asks in Needs you (§app.project-assistant/requests, §app.owner-page/link), act tier,
 * every open owner request (`owner-request`; an outage `owner-outage`, which a phone notification also
 * tells), each opening the org's Requests tab at that request, and an owner who asked for a new link
 * (`owner-link-request`), opening the People tab (its Owner card). No session: `path` "".
 */

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

const KIND_WORD: Record<string, string> = { bug: "a problem", outage: "that the app is down", question: "a question", feature: "a new feature", fix: "a fix", deploy: "a release" };

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
    for (const r of requests) {
      if (r.status !== "with-team") continue;
      const project = projects.find((p) => p.id === r.projectId);
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
