import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentModelPolicy } from "../shared/protocol";

/**
 * The subagents extension's model policy (spec/12-settings-dialog.md §12): which providers and
 * models may not be picked for workers. The FILE SHAPE is a contract with
 * pi-config/extensions/subagents/policy.ts — {version:1, disabledProviders, disabledModels} —
 * which reads it per spawn and per model discovery, in every session, TUI and webapp alike.
 * This module owns pi-web's side: read tolerantly, write atomically and canonically
 * (lowercase, deduped, sorted), never importing the extension (server files stay
 * pi-config-free except the four documented imports).
 */
const FILE = join(getAgentDir(), "subagents", "settings.json");
/** A policy is a hand-curated deny list, not a log; past this it's a bug, not a preference. */
const MAX_ENTRIES = 200;

const cleanList = (value: unknown, kind: "provider" | "model"): string[] | null => {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const v = entry.trim().toLowerCase();
    if (!v) continue; // blank entries are nothing, not an error
    if (kind === "provider" ? v.includes("/") : !v.includes("/")) return null;
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > MAX_ENTRIES) return null;
  return out.sort();
};

export function readSubagentPolicy(): SubagentModelPolicy {
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    if (data.version !== 1) return { disabledProviders: [], disabledModels: [] };
    const providers = cleanList(data.disabledProviders, "provider");
    const models = cleanList(data.disabledModels, "model");
    // A foreign shape reads as "nothing disabled", matching the extension's own parse.
    if (!providers || !models) return { disabledProviders: [], disabledModels: [] };
    return { disabledProviders: providers, disabledModels: models };
  } catch {
    return { disabledProviders: [], disabledModels: [] }; // missing or corrupt: nothing disabled
  }
}

/** Validate, canonicalize and persist a whole policy (tmp + rename, like web-sessions.json). */
export function writeSubagentPolicy(raw: unknown): SubagentModelPolicy | { error: string } {
  const providers = cleanList((raw as Record<string, unknown> | null | undefined)?.disabledProviders, "provider");
  const models = cleanList((raw as Record<string, unknown> | null | undefined)?.disabledModels, "model");
  if (!providers || !models)
    return {
      error: `Expected { disabledProviders: string[] (no "/"), disabledModels: string[] ("provider/modelId"), at most ${MAX_ENTRIES} each }`,
    };
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, disabledProviders: providers, disabledModels: models }, null, "\t")}\n`);
  renameSync(tmp, FILE);
  return { disabledProviders: providers, disabledModels: models };
}
