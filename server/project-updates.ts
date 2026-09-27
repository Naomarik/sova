import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_MILESTONES, OWNER_UPDATE_MAX, type OwnerMilestone, type ProjectUpdate } from "../shared/owner";
import { orgDir, OrgError } from "./orgs";

/**
 * Milestone updates for the org owner's page (§app.owner-page/news): `projects/<pid>/updates.jsonl`
 * in the workspace repo, append-only, so they travel with the org. The project overseer posts them
 * (sova_owner_update) at real milestones, at most one a day per project unless the operator asked
 * in their own turn; the operator can withdraw one (it leaves the page and stays in the file).
 *
 *   {kind: "post", id: "u_…", at, by: "overseer" | "operator", milestone, text}
 *   {kind: "withdraw", id, at}
 */

type Line = { kind: "post"; id: string; at: string; by: ProjectUpdate["by"]; milestone: OwnerMilestone; text: string } | { kind: "withdraw"; id: string; at: string };

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function fileOf(orgId: string, projectId: string): string {
  if (!SAFE_ID.test(projectId)) throw new OrgError("Unknown project", 404);
  return join(orgDir(orgId), "projects", projectId, "updates.jsonl");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readLines(file: string): Line[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw);
      if (!isObj(l) || typeof l.id !== "string" || typeof l.at !== "string") continue;
      if (l.kind === "post" && typeof l.text === "string" && OWNER_MILESTONES.includes(l.milestone as OwnerMilestone))
        out.push({ kind: "post", id: l.id, at: l.at, by: l.by === "operator" ? "operator" : "overseer", milestone: l.milestone as OwnerMilestone, text: l.text });
      else if (l.kind === "withdraw") out.push({ kind: "withdraw", id: l.id, at: l.at });
    } catch {
      // a torn line: skip
    }
  }
  return out;
}

/** Every update of a project, withdrawn ones included, newest first. */
export function readUpdates(orgId: string, projectId: string): ProjectUpdate[] {
  const lines = readLines(fileOf(orgId, projectId));
  const withdrawn = new Map(lines.filter((l) => l.kind === "withdraw").map((l) => [l.id, l.at]));
  return lines
    .filter((l): l is Extract<Line, { kind: "post" }> => l.kind === "post")
    .map((l) => ({ id: l.id, at: l.at, text: l.text, milestone: l.milestone, by: l.by, ...(withdrawn.has(l.id) ? { withdrawnAt: withdrawn.get(l.id)! } : {}) }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The published ones (not withdrawn), newest first: what the Owner page shows. */
export const publishedUpdates = (orgId: string, projectId: string): ProjectUpdate[] => readUpdates(orgId, projectId).filter((u) => !u.withdrawnAt);

/** The host's calendar day of a time ("YYYY-MM-DD"): the one-a-day rule counts these. */
export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A post (withdrawn or not) already went out today. */
export function postedToday(orgId: string, projectId: string, now = Date.now()): ProjectUpdate | null {
  return readUpdates(orgId, projectId).find((u) => localDay(Date.parse(u.at)) === localDay(now)) ?? null;
}

/** A cleaned update text, or an OrgError. */
export function cleanUpdateText(v: unknown): string {
  const t = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!t) throw new OrgError("Write the update first.");
  if (t.length > OWNER_UPDATE_MAX) throw new OrgError(`An update is at most ${OWNER_UPDATE_MAX} characters (this one is ${t.length}).`);
  return t;
}

export function appendUpdate(orgId: string, projectId: string, input: { text: unknown; milestone: unknown; by: ProjectUpdate["by"] }, now = Date.now()): ProjectUpdate {
  const text = cleanUpdateText(input.text);
  const milestone = input.milestone as OwnerMilestone;
  if (!OWNER_MILESTONES.includes(milestone)) throw new OrgError(`milestone must be one of ${OWNER_MILESTONES.join(", ")}`);
  const file = fileOf(orgId, projectId);
  mkdirSync(join(file, ".."), { recursive: true });
  const line: Line = { kind: "post", id: `u_${randomBytes(6).toString("base64url")}`, at: new Date(now).toISOString(), by: input.by, milestone, text };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return { id: line.id, at: line.at, text, milestone, by: input.by };
}

export function withdrawUpdate(orgId: string, projectId: string, id: string, now = Date.now()): void {
  const u = readUpdates(orgId, projectId).find((x) => x.id === id);
  if (!u) throw new OrgError("No such update", 404);
  if (u.withdrawnAt) throw new OrgError("That update is already withdrawn.", 409);
  appendFileSync(fileOf(orgId, projectId), `${JSON.stringify({ kind: "withdraw", id, at: new Date(now).toISOString() })}\n`);
}
