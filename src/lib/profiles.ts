import type { IconName } from "../components/ui";
import {
  CAPABILITY_LABEL,
  CAPABILITY_TOOLS,
  DEFAULT_PROFILE_ID,
  GRANTABLE,
  limitsLine,
  REMOVABLE,
  toolRemoved,
  type Grantable,
  type Profile,
  type ProfilesListing,
  type Removable,
} from "../../shared/profiles";
import type { ChatProfileInfo } from "../../shared/protocol";

/** The Icon a profile's icon names (an unknown one reads as the wrench). */
export function profileIconName(icon: string | undefined): IconName {
  const known: IconName[] = ["grid", "eye", "network", "branch", "wrench", "shield", "search", "terminal", "bulb", "building"];
  return (known as string[]).includes(icon ?? "") ? (icon as IconName) : "wrench";
}

/** The pickers' list: built-ins not hidden (Default always), then yours. */
export function pickerProfiles(l: ProfilesListing | undefined): { builtins: Profile[]; yours: Profile[] } {
  if (!l) return { builtins: [], yours: [] };
  return { builtins: l.builtins.filter((p) => p.id === DEFAULT_PROFILE_ID || !l.hiddenBuiltins.includes(p.id)), yours: l.profiles };
}

/** One row of "What changes vs Default". */
export interface ChangeRow {
  sign: "+" | "−";
  cap: Removable | Grantable;
  label: string;
  detail: string;
}

/** The rows a profile changes, grants first (§chat.profiles/picker). `present`: the tools Default has here. */
export function changeRows(p: Pick<Profile, "remove" | "grant" | "limits">, present: readonly string[]): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const g of GRANTABLE)
    if (p.grant.includes(g))
      rows.push({
        sign: "+",
        cap: g,
        label: CAPABILITY_LABEL[g],
        detail:
          g === "sessions.read"
            ? "Marked untrusted when read"
            : g === "sessions.message"
              ? `${limitsLine(p.limits)}. Its messages arrive tagged with this session's title.`
              : "Every session Sova lists on this host",
      });
  for (const r of REMOVABLE)
    if (p.remove.includes(r)) {
      const names = present.filter((t) => toolRemoved(t, [r]));
      const shown = names.length ? names : CAPABILITY_TOOLS[r].map((t) => t.replace("*", "…"));
      rows.push({ sign: "−", cap: r, label: CAPABILITY_LABEL[r], detail: shown.length > 3 ? `${shown.slice(0, 2).join(", ")}, ${shown.length - 2} more` : shown.join(", ") });
    }
  return rows;
}

/** The tools Default would have in this runtime: what is active, less the grants, plus what the removals took. */
export function defaultTools(info: Pick<ChatProfileInfo, "tools" | "granted" | "removed">): string[] {
  return [...info.tools.filter((t) => !info.granted.includes(t)), ...info.removed].sort();
}

/** The guardrail note, or null when nothing is removed (§chat.profiles/picker). */
export function guardrailNote(remove: readonly string[]): string | null {
  if (!remove.length) return null;
  return remove.includes("shell")
    ? "The shell is off, so these removals hold."
    : "The shell is on, so removals are guardrails, not a boundary. Bash can still change files and call Sova's API.";
}
