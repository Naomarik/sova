import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_FILE, parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { readRegistry } from "./store";

/**
 * Production-derived data is never shared (§app.project-services/share, §mesh.public/preview): a copy whose
 * definition declares a `sensitive` data resource gets no share link, and no port preview reaches a port one
 * of its services holds.
 */

export const SENSITIVE_REFUSAL = "Derived from production: copies are never shared.";

export const holdsSensitive = (def: Pick<ProjectDef, "data">): boolean => def.data.some((d) => d.sensitive === true);

function defAt(checkout: string): ProjectDef | null {
  const file = join(checkout, CONTRACT_FILE);
  if (!existsSync(file)) return null;
  try {
    return parseDefinition(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The copy's own definition, else (unreadable) its project's main checkout's: whether it declares sensitive data. */
function sensitiveAt(checkout: string, project: string): boolean {
  const def = defAt(checkout) ?? (checkout !== project ? defAt(project) : null);
  return !!def && holdsSensitive(def);
}

/** Why a port preview of `port` is refused for sensitive data (a copy's or a shared service's port), or null. */
export function sensitivePortRefusal(port: number): string | null {
  const reg = readRegistry();
  for (const rec of reg.instances) {
    const held = Object.values(rec.ports).some((ps) => Object.values(ps).includes(port));
    if (held && sensitiveAt(rec.checkout, rec.project)) return `Port ${port} belongs to a running copy of ${rec.project}, whose data is derived from production: copies are never shared.`;
  }
  for (const sh of reg.shared) {
    const held = Object.values(sh.ports).some((ps) => Object.values(ps).includes(port));
    if (held && sensitiveAt(sh.project, sh.project)) return `Port ${port} belongs to a shared service of ${sh.project}, whose data is derived from production: copies are never shared.`;
  }
  return null;
}
