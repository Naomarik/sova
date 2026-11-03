import type { ToolSpec } from "../shared/harness";
import type { OwnerProject } from "../shared/owner";
import { readBuilds } from "./build-loadout";
import { handleOf } from "./person-links";
import { orgRequests } from "./project-assistant-store";
import { outsiderRedactor } from "./share/hub";

/**
 * What's new, for the Project Assistant to tell (§app.project-assistant/news): `project_news`, read only. Per shown
 * project: the team's updates the owner's page shows, the last release (the newest deploy that succeeded), and the
 * work finished since then: the owner's requests marked done since, the decisions agreed since (both as the page
 * shows them), and how many pieces of work were finished (merged) since. Built from the owner page's own answer
 * (server/owner-page.ts ownerProject: already through the outsider filter) plus counts and the owner's own titles;
 * never a change note, commit, branch, coding session's title or to-do.
 */

/** What the tool needs per project; tests stand each one in. */
export interface NewsFacts {
  /** The owner page's view of the project (its updates and decisions, cleaned for the owner). */
  page(orgId: string, projectId: string): Promise<Pick<OwnerProject, "news" | "decisions">>;
  /** When the project's newest successful release ended (ISO), or null. */
  lastRelease(projectId: string, root: string | undefined): Promise<string | null>;
  /** When each piece of work was finished (merged), ISO. */
  finishedAt(projectId: string): string[];
}

const serverFacts: NewsFacts = {
  async page(orgId, projectId) {
    const { ownerProject } = await import("./owner-page");
    return ownerProject(orgId, handleOf("q", projectId));
  },
  async lastRelease(_projectId, root) {
    if (!root) return null;
    const { recordsOf } = await import("./project-services/deploy");
    const ok = recordsOf(root).find((r) => r.state === "succeeded");
    return ok ? (ok.endedAt ?? ok.startedAt) : null;
  },
  finishedAt: (projectId) => readBuilds(projectId).flatMap((b) => (b.merged?.at ? [b.merged.at] : [])),
};

let factsForTest: Partial<NewsFacts> | null = null;
export function setNewsFactsForTest(f: Partial<NewsFacts> | null): void {
  factsForTest = f;
}
const facts = (): NewsFacts => ({ ...serverFacts, ...(factsForTest ?? {}) });

const day = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One project's news, in plain lines for the model. */
export async function projectNewsText(orgId: string, project: { id: string; name: string; root?: string }): Promise<string> {
  const f = facts();
  const r = outsiderRedactor(orgId);
  const page = await f.page(orgId, project.id).catch(() => ({ news: [], decisions: [] }));
  const release = await f.lastRelease(project.id, project.root).catch(() => null);
  const since = release ?? "";
  const lines = [`## ${r.redact(project.name)}`];
  const news = [...page.news].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  lines.push(news.length ? "Updates from the team, newest first:" : "No updates from the team yet.");
  for (const u of news) lines.push(`- ${day(u.at)}: ${u.text}`);
  lines.push(release ? `Last release: ${day(release)}.` : "No release is recorded yet.");
  const after = (at: string) => !since || at > since;
  const done = orgRequests(orgId).filter((x) => x.projectId === project.id && x.status === "done" && after(x.updatedAt));
  const agreed = page.decisions.filter((d) => d.state === "agreed" && after(d.at));
  const finished = f.finishedAt(project.id).filter(after).length;
  lines.push(release ? "Finished since that release:" : "Finished so far:");
  if (!done.length && !agreed.length && !finished) lines.push("- nothing recorded yet.");
  for (const x of done) lines.push(`- the owner's request "${r.redact(r.said(x.title))}" (done ${day(x.updatedAt)})`);
  for (const d of agreed) lines.push(`- agreed: ${d.statement} (${day(d.at)})`);
  if (finished) lines.push(`- ${plural(finished, "piece")} of work finished`);
  return lines.join("\n");
}

const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** The tool, over the shown projects. */
export function projectNewsTool(ctx: { orgId: string; projects(): { id: string; name: string; root?: string }[] }): ToolSpec {
  return {
    name: "project_news",
    label: "What's new",
    description:
      "What's new in the owner's projects: the team's updates, the last release date, and what was finished since then (requests done, decisions agreed, how many pieces of work). Use it before you say you can't tell what's new or what changed.",
    promptSnippet: "project_news: what's new (updates, last release, what was finished since)",
    parameters: { type: "object", properties: { project: { type: "string", description: "Which project (its name); every project when left out." } }, required: [], additionalProperties: false },
    async execute(_id, params) {
      const ps = ctx.projects();
      if (!ps.length) return say("There is no project yet.");
      const asked = typeof params.project === "string" ? params.project.trim().toLowerCase() : "";
      const pick = asked ? ps.filter((p) => p.name.toLowerCase() === asked) : ps;
      if (!pick.length) throw new Error(`"${params.project}" is not one of the owner's projects. Use one of: ${ps.map((p) => p.name).join(", ")}.`);
      const parts: string[] = [];
      for (const p of pick) parts.push(await projectNewsText(ctx.orgId, p));
      return say(parts.join("\n\n"));
    },
  };
}
