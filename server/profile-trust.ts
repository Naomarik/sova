import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GRANTABLE, powersText, powersToApprove, type Grantable, type ListedProfile, type Profile } from "../shared/profiles";
import { stateRoot } from "./state-root";

/**
 * Approvals of what a project's profile may do (§chat.profiles/trust), `<state root>/profile-trust.json`
 * `{version: 1, approved: {<identity>: {grant, overseerMayStart, at}}}`: outside every repo, so no
 * branch or clone can approve itself. An approval covers the powers it recorded and anything less;
 * a wider file needs approving again.
 */

export const trustFile = () => join(stateRoot(), "profile-trust.json");

export interface Approved {
  grant: Grantable[];
  overseerMayStart: boolean;
  at: string;
}

export function readTrust(file = trustFile()): Record<string, Approved> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; approved?: unknown };
    if (raw?.version !== 1 || !raw.approved || typeof raw.approved !== "object") return {};
    const out: Record<string, Approved> = {};
    for (const [key, v] of Object.entries(raw.approved as Record<string, Record<string, unknown>>)) {
      if (!v || typeof v !== "object" || !Array.isArray(v.grant)) continue;
      out[key] = {
        grant: GRANTABLE.filter((g) => (v.grant as unknown[]).includes(g)),
        overseerMayStart: v.overseerMayStart === true,
        at: typeof v.at === "string" ? v.at : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Whether `p` (a project profile) needs approving, is approved, or needs nothing (undefined). */
export function approvalOf(p: Pick<ListedProfile, "source" | "key" | "grant" | "overseerMayStart">, trust: Record<string, Approved> = readTrust()): "needed" | "approved" | undefined {
  if (p.source !== "project" || !powersToApprove(p)) return undefined;
  const a = trust[p.key];
  if (!a) return "needed";
  const covered = p.grant.every((g) => a.grant.includes(g)) && (!p.overseerMayStart || a.overseerMayStart);
  return covered ? "approved" : "needed";
}

/** The refusal sentence for an unapproved project profile. */
export function approvalRefusal(p: Pick<ListedProfile, "label" | "projectName" | "grant" | "overseerMayStart">): string {
  return `${p.label} is a profile from ${p.projectName ?? "this project"}'s files that can ${powersText(p)}. Approve it in Settings → Profiles or on the picker first.`;
}

/**
 * Record `p`'s powers as approved. `seen`: the powers the person approving was shown; refused when
 * the file has other powers now, so what is approved is what was seen.
 */
export function approve(p: Pick<ListedProfile, "key" | "grant" | "overseerMayStart">, seen: Pick<Profile, "grant" | "overseerMayStart">, file = trustFile()): void {
  const same = seen.grant.length === p.grant.length && p.grant.every((g) => seen.grant.includes(g)) && seen.overseerMayStart === p.overseerMayStart;
  if (!same) throw new Error("The profile's file changed since it was shown: it now asks for other powers. Look at it again, then approve.");
  let all: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; approved?: unknown };
    if (raw?.version === 1 && raw.approved && typeof raw.approved === "object") all = raw.approved as Record<string, unknown>;
  } catch {
    // missing or unreadable: start over
  }
  all[p.key] = { grant: [...p.grant], overseerMayStart: p.overseerMayStart, at: new Date().toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, approved: all }, null, 2)}\n`);
  renameSync(tmp, file);
}
