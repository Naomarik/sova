import { createHash } from "node:crypto";
import type { DeployDecl, ProjectDef } from "../../shared/project-contract";

/**
 * A definition's hash (§app.project-services/conform): what a conformance stamp and the software registry's
 * registration are keyed by, so a proof holds for exactly the definition it ran.
 */

/** Drop what tuning may change without changing what runs: every `timeout`, readiness paths, a service's `about` and
    `isolation` (words for builders and readers), the top-level `sources` (what drift reads), `open` (the entry
    point, which exposes nothing) and `deploy` (hashed on its own, `deployHashOf`); the default `start: "up"` too,
    so a definition hashes as it did before `start` existed. */
export function hashed(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => hashed(x, key));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    if (k === "timeout") continue;
    if (key === "" && (k === "sources" || k === "open" || k === "deploy")) continue;
    if (key === "ready" && k === "path") continue;
    if (key === "services" && (k === "about" || k === "isolation" || (k === "start" && (v as Record<string, unknown>)[k] === "up"))) continue;
    out[k] = hashed((v as Record<string, unknown>)[k], k);
  }
  return out;
}

/** The definition's hash: `sha256:<hex>` of its canonical JSON minus what `hashed` drops. */
export function defHashOf(def: ProjectDef): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(hashed(def))).digest("hex")}`;
}

/** The deploy recipe's hash (§app.project-services/deploy-plan): its canonical JSON without timeouts. */
export function deployHashOf(d: DeployDecl): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(hashed(d, "deploy"))).digest("hex")}`;
}
