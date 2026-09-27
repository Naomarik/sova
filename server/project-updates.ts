import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_UPDATE_MAX, type ProjectUpdate } from "../shared/owner";
import { orgDir, OrgError } from "./orgs";

/**
 * Milestone updates for the org owner's page (§app.owner-page/news): `projects/<pid>/updates.jsonl`
 * in the workspace repo, append-only, so they travel with the org. The project overseer posts them
 * (sova_owner_update) at real milestones, at most one a day, unless the operator asked in their own
 * turn (server/project-overseer.ts decides); the operator can take one down (it leaves the page and
 * stays in the file).
 *
 *   {kind: "post", id: "u_…", at, by: {kind: "overseer", run: "auto" | "operator"}, text}
 *   {kind: "withdraw", id, at}
 */

type Run = "auto" | "operator";
type Line = { kind: "post"; id: string; at: string; by: { kind: "overseer"; run: Run }; text: string } | { kind: "withdraw"; id: string; at: string };

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
      if (l.kind === "post" && typeof l.text === "string")
        out.push({ kind: "post", id: l.id, at: l.at, by: { kind: "overseer", run: isObj(l.by) && l.by.run === "operator" ? "operator" : "auto" }, text: l.text });
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
    .map((l): ProjectUpdate => ({ id: l.id, at: l.at, text: l.text, by: l.by.run === "operator" ? "operator" : "overseer", ...(withdrawn.has(l.id) ? { withdrawnAt: withdrawn.get(l.id)! } : {}) }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The published ones (not withdrawn), newest first: what the Owner page shows. */
export const publishedUpdates = (orgId: string, projectId: string): ProjectUpdate[] => readUpdates(orgId, projectId).filter((u) => !u.withdrawnAt);

/** The project's newest post, taken down or not (the one-a-day rule and "since the last update" count it). */
export const lastUpdate = (orgId: string, projectId: string): ProjectUpdate | null => readUpdates(orgId, projectId)[0] ?? null;

/** A cleaned update text, or an OrgError. */
export function cleanUpdateText(v: unknown): string {
  const t = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!t) throw new OrgError("Write the update first.");
  if (t.length > OWNER_UPDATE_MAX) throw new OrgError("An update is at most 2,000 characters.");
  return t;
}

/** Append a post. `run`: "operator" when the operator asked for it in their own turn. */
export function appendUpdate(orgId: string, projectId: string, input: { text: unknown; run: Run }, now = Date.now()): ProjectUpdate {
  const text = cleanUpdateText(input.text);
  const file = fileOf(orgId, projectId);
  mkdirSync(join(file, ".."), { recursive: true });
  const line: Line = { kind: "post", id: `u_${randomBytes(6).toString("base64url")}`, at: new Date(now).toISOString(), by: { kind: "overseer", run: input.run }, text };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  return { id: line.id, at: line.at, text, by: input.run === "operator" ? "operator" : "overseer" };
}

export function withdrawUpdate(orgId: string, projectId: string, id: string, now = Date.now()): void {
  const u = readUpdates(orgId, projectId).find((x) => x.id === id);
  if (!u) throw new OrgError("No such update", 404);
  if (u.withdrawnAt) throw new OrgError("That update is already withdrawn.", 409);
  appendFileSync(fileOf(orgId, projectId), `${JSON.stringify({ kind: "withdraw", id, at: new Date(now).toISOString() })}\n`);
}
