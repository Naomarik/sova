import { join } from "node:path";
import { agentRoot } from "./state-root";
import {
  ALIGN_SETTINGS_FILE,
  alignSettingsDefaults,
  loadAlignSettings,
  parseAlignSettings,
  resolveAlign,
  saveAlignSettings,
  type AlignResolved,
} from "../pi-config/extensions/mode/align-settings.ts";
import type { AlignOverride } from "../pi-config/extensions/mode/align-settings.ts";
import { loadSubagentProfiles, readProfilesDefault, resolveSubagents } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import type { AlignSettingsInfo } from "../shared/protocol";

// The align mode's writing style and Visuals (§chat.alignment/settings-file): Settings → Alignment's
// part that is not Sova's own. The file (~/.pi/agent/mode-align.json) and its rules are the mode
// extension's (pi-config/extensions/mode/align-settings.ts): every session re-reads the style at its
// next turn boundary, Visuals at its start; Sova also reads Visuals at a chat's first start, for the
// chat's launch record (chat-manager.ts). Adversarial review stays in Sova's settings (web-settings.ts).

export const alignSettingsFile = () => join(agentRoot(), ALIGN_SETTINGS_FILE);

// Compile-time: the extension's shape is the wire shape.
const _wire: AlignSettingsInfo["settings"] = alignSettingsDefaults();
void _wire;

export function alignSettingsInfo(file = alignSettingsFile()): AlignSettingsInfo {
  return { settings: loadAlignSettings(file), file };
}

/** Replace the file (PUT): the extension's strict parse, then its atomic write. */
export function saveAlignSettingsBody(body: unknown, file = alignSettingsFile()): AlignSettingsInfo | { error: string } {
  const parsed = parseAlignSettings(body);
  if ("error" in parsed) return parsed;
  saveAlignSettings(file, parsed);
  return alignSettingsInfo(file);
}

/** What a chat would use now: its profile's override, field by field, else the host's file. */
export function alignNow(override: AlignOverride | null | undefined, file = alignSettingsFile()): AlignResolved {
  return resolveAlign(loadAlignSettings(file), override);
}

/** What a chat on this pick would use now (undefined: no pick, it follows this device's default profile). */
export function alignForPick(pick: string | undefined, dir = agentRoot()): AlignResolved {
  const override = resolveSubagents(dir, pick, loadSubagentProfiles(dir), readProfilesDefault(dir)).alignment;
  return alignNow(override, join(dir, ALIGN_SETTINGS_FILE));
}
