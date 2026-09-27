import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectCodingMode } from "../shared/project-overseer";
import { parseModePatch } from "./mode-state";

/**
 * The mode a project's coding sessions run in (§app.project-overseer/tools, Modes): never the
 * host's mode.json default (on a busy host that is the operator's own delegate · align · spec),
 * always an explicit mode the operator controls on the project page.
 *
 * - The project setting `codingMode`, or Automatic (null): normal, with spec on when the project
 *   root has a spec (`.sova/spec/manifest.json`), read at start time. Automatic never gives
 *   delegate or align.
 * - The overseer may ask for another mode per session (sova_create_session, sova_send), under the
 *   operator's ceiling: delegate only when the setting is delegate, align never, spec never off
 *   when the base has it on. Normal and spec on are always allowed.
 * Pure, apart from the manifest's existence check.
 */

export const ALIGN_REFUSED = "Align needs someone to answer its questions, and nobody answers a coding session's.";
export const DELEGATE_REFUSED = "Delegate is off for this project's coding sessions; the operator can allow it on the project page.";
export const SPEC_OFF_REFUSED = "Spec is on for this project's coding sessions; only the operator can turn it off on the project page.";

/** The names a request carries, checked with the copy's own sentences (unknown first, then align). */
function checkNames(mode: unknown, minors: unknown): { mode?: "normal" | "delegate"; minorModes?: string[] } | { error: string } {
  const out: { mode?: "normal" | "delegate"; minorModes?: string[] } = {};
  if (mode !== undefined) {
    if (mode !== "normal" && mode !== "delegate") return { error: `Unknown mode ${String(mode)}: use normal or delegate.` };
    out.mode = mode;
  }
  if (minors !== undefined) {
    if (!Array.isArray(minors)) return { error: "minor_modes must be a list, e.g. [\"spec\"]." };
    const unknown = minors.find((m) => m !== "spec" && m !== "align");
    if (unknown !== undefined) return { error: `Unknown minor mode ${String(unknown)}: only spec is allowed.` };
    if (minors.includes("align")) return { error: ALIGN_REFUSED };
    const p = parseModePatch({ minorModes: minors });
    out.minorModes = "error" in p ? [] : (p.minorModes ?? []);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What Automatic resolves to for `root` now. */
export function automaticMode(root: string, hasSpec = existsSync(join(root, ".sova", "spec", "manifest.json"))): ProjectCodingMode {
  return { mode: "normal", minorModes: hasSpec ? ["spec"] : [] };
}

/** The base every coding session starts from: the setting, else Automatic. */
export function baseCodingMode(setting: ProjectCodingMode | null, root: string, hasSpec?: boolean): ProjectCodingMode {
  return setting ? { mode: setting.mode, minorModes: [...setting.minorModes] } : automaticMode(root, hasSpec);
}

/** A stored setting, tolerantly: anything unusable reads as null (Automatic). */
export function parseCodingMode(raw: unknown): ProjectCodingMode | null {
  if (!isObj(raw)) return null;
  const p = parseModePatch({ mode: raw.mode, minorModes: Array.isArray(raw.minorModes) ? raw.minorModes : [] });
  if ("error" in p || !p.mode || p.minorModes?.includes("align")) return null;
  return { mode: p.mode, minorModes: p.minorModes ?? [] };
}

/** A PATCH's `codingMode`, strictly: null (Automatic) or `{ mode, minorModes? }`; a sentence on a problem. */
export function checkCodingModePatch(v: unknown): ProjectCodingMode | null | { error: string } {
  if (v === null) return null;
  if (!isObj(v)) return { error: "codingMode must be null (Automatic) or { mode, minorModes }" };
  if (v.mode === undefined) return { error: "codingMode.mode is required (normal or delegate)" };
  const p = checkNames(v.mode, v.minorModes ?? []);
  if ("error" in p) return p;
  return { mode: p.mode!, minorModes: p.minorModes ?? [] };
}

/** The overseer's request (the tools' `mode` / `minor_modes`), validated by name only. */
export interface ModeRequest {
  mode?: string;
  minor_modes?: unknown;
}

/**
 * The mode a session gets for `req` over `base`, or a refusal sentence. `setting` is the operator's
 * project setting (null: Automatic), the ceiling for delegate. Checked before anything is created
 * or any cap is taken.
 */
export function codingModeChoice(req: ModeRequest, base: ProjectCodingMode, setting: ProjectCodingMode | null): { mode: ProjectCodingMode } | { error: string } {
  const asked = req.mode !== undefined && req.mode !== null && req.mode !== "";
  const minorsAsked = req.minor_modes !== undefined && req.minor_modes !== null;
  if (!asked && !minorsAsked) return { mode: { mode: base.mode, minorModes: [...base.minorModes] } };
  const p = checkNames(asked ? req.mode : undefined, minorsAsked ? req.minor_modes : undefined);
  if ("error" in p) return p;
  const mode = p.mode ?? base.mode;
  const minorModes = p.minorModes ?? [...base.minorModes];
  if (mode === "delegate" && setting?.mode !== "delegate") return { error: DELEGATE_REFUSED };
  if (base.minorModes.includes("spec") && !minorModes.includes("spec")) return { error: SPEC_OFF_REFUSED };
  return { mode: { mode, minorModes } };
}

export const sameCodingMode = (a: ProjectCodingMode, b: ProjectCodingMode): boolean =>
  a.mode === b.mode && a.minorModes.length === b.minorModes.length && a.minorModes.every((m, i) => b.minorModes[i] === m);

export const describeCodingMode = (m: ProjectCodingMode): string => [m.mode, ...m.minorModes].join(" · ");
