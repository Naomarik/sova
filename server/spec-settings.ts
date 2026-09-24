import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CLAUDE_EFFORTS, DELEGATE_BACKENDS, PI_EFFORTS } from "../pi-config/extensions/mode/delegate.ts";
import {
  loadSpec,
  parseSpec,
  saveSpec,
  SPEC_FILE_NAME,
  SPEC_WRITER_DESCRIPTION,
  SPEC_WRITER_LABEL,
  specDefaults,
} from "../pi-config/extensions/mode/spec.ts";
import type { SpecSaveResult, SpecSettingsInfo } from "../shared/protocol";
import { delegateOptions, verifySlots, type DelegateSources } from "./delegate";

// Settings → Modes → Spec: which worker writes the spec (draft claims and evidence) while the spec
// minor mode is on. The file (~/.pi/agent/mode-spec.json) and its rules are the mode extension's
// (pi-config/extensions/mode/spec.ts); the offer and the save check are Delegate's
// (server/delegate.ts), since a writer is the same backend · model · effort tuple. Every session
// with spec on — TUI or web, in either major mode — re-reads the file at its next turn boundary.

export const specFile = () => join(getAgentDir(), SPEC_FILE_NAME);

const BACKEND_LABELS = { pi: "pi", "claude-code": "Claude Code" } as const;

// Compile-time: the extension's shape is the wire shape.
const _wire: SpecSettingsInfo["settings"] = specDefaults();
void _wire;

export function specInfo(file = specFile()): SpecSettingsInfo {
  return {
    settings: loadSpec(file),
    writer: { label: SPEC_WRITER_LABEL, description: SPEC_WRITER_DESCRIPTION },
    backends: DELEGATE_BACKENDS.map((id) => ({ id, label: BACKEND_LABELS[id], efforts: [...(id === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS)] })),
    file,
  };
}

/** What each backend offers: exactly Delegate's discovery (one cached Claude CLI call serves both). */
export const specOptions = delegateOptions;

/**
 * Replace the writer (PUT). Shape first (the extension's strict parse), then discovery, with
 * Delegate's rule: a CHANGED tuple the backend authoritatively cannot run is refused; one that
 * can't be checked, or that the policy refuses, is saved with a warning. `writer: null` needs no
 * discovery — no worker is named.
 */
export async function saveSpecSettings(body: unknown, sources: DelegateSources, file = specFile()): Promise<SpecSaveResult | { error: string }> {
  const parsed = parseSpec(body);
  if ("error" in parsed) return parsed;
  let warnings: string[] = [];
  if (parsed.writer) {
    const stored = loadSpec(file).writer;
    const verdict = verifySlots(
      [
        { label: `${SPEC_WRITER_LABEL} primary`, choice: parsed.writer.primary, stored: stored?.primary },
        { label: `${SPEC_WRITER_LABEL} fallback`, choice: parsed.writer.fallback, stored: stored?.fallback },
      ],
      await delegateOptions(sources),
      "spec writing",
    );
    if ("error" in verdict) return verdict;
    warnings = verdict.warnings;
  }
  saveSpec(file, parsed);
  return { ...specInfo(file), warnings };
}
