import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OFF_ID, OFF_KEY, type DefaultProfileInfo, type JoinedProfile } from "../shared/profiles";
import {
  loadSubagentProfiles, profilesDefaultOf, readProfilesDefault, writeProfilesDefault,
} from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { joinedProfiles, pickJoined } from "./joined-profiles";
import { readMode, writeMode, type ModePatch } from "./mode-state";
import { agentRoot, stateRoot } from "./state-root";
import { loadDefaults, saveDefaults } from "./web-defaults";

/**
 * This computer's one default profile (§chat.profiles/default): `<state root>/default-profile.json`,
 * `{"version": 1, "profile": <id or "off">}`, never synced. Choosing one also keeps the three older
 * default files written for what the profile sets (mode.json's default, defaults.json, and
 * subagent-profiles-default.json), so pi-config's extensions and an older Sova read the same default.
 * Before one is chosen, the default is read from the older files and nothing is written.
 */

export const DEFAULT_PROFILE_FILE_NAME = "default-profile.json";
export const defaultProfileFile = () => join(stateRoot(), DEFAULT_PROFILE_FILE_NAME);

export type DefaultFileState = { state: "absent" } | { state: "ok"; profile: string } | { state: "malformed"; error: string };

export function readDefaultProfileFile(file = defaultProfileFile()): DefaultFileState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "malformed", error: (err as Error).message };
  }
  try {
    const o = JSON.parse(raw) as { version?: unknown; profile?: unknown };
    if (o?.version === 1 && typeof o.profile === "string" && o.profile.trim()) return { state: "ok", profile: o.profile };
    return { state: "malformed", error: 'expected {"version": 1, "profile": <id or "off">}' };
  } catch (err) {
    return { state: "malformed", error: (err as Error).message };
  }
}

function writeDefaultProfileFile(profile: string, file = defaultProfileFile()): void {
  const text = `${JSON.stringify({ version: 1, profile }, null, 2)}\n`;
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch { /* absent: written below */ }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The default among `rows` (pure). `file`: default-profile.json as read; `libraryDefault`: the id
 * subagent-profiles-default.json resolves to (profilesDefaultOf), used only while no default was chosen.
 */
export function defaultAmong(rows: readonly JoinedProfile[], file: DefaultFileState, libraryDefault: string): { row: JoinedProfile; info: DefaultProfileInfo } {
  const off = rows.find((r) => r.kind === "off")!;
  const info = (row: JoinedProfile, chosen: boolean, note?: string) => ({ row, info: { key: row.key, id: row.id, name: row.name, chosen, ...(note ? { note } : {}) } });
  if (file.state === "ok") {
    if (file.profile === OFF_ID) return info(off, true);
    const row = pickJoined(rows, file.profile);
    return row ? info(row, true) : info(off, true, `The default, "${file.profile}", isn't a profile here, so new chats start on Off.`);
  }
  if (file.state === "malformed") return info(off, true, `${DEFAULT_PROFILE_FILE_NAME} can't be read (${file.error}), so new chats start on Off.`);
  if (libraryDefault === OFF_ID) return info(off, false);
  // Not chosen yet: the pair linking the saved default helpers (the first by name), else that library profile's own row.
  const linking = rows.filter((r) => r.libraryId === libraryDefault && r.kind !== "library");
  const yours = linking.find((r) => r.group === "yours");
  const row = yours ?? rows.find((r) => r.kind === "library" && r.id === libraryDefault) ?? linking[0] ?? off;
  return info(row, false);
}

/** The default a session in `cwd` starts on now, and how the listing shows it. */
export async function resolveDefaultProfile(cwd?: string | null, rows?: readonly JoinedProfile[], dir = agentRoot()): Promise<{ row: JoinedProfile; info: DefaultProfileInfo }> {
  const list = rows ?? (await joinedProfiles(cwd, {}, dir));
  return defaultAmong(list, readDefaultProfileFile(), profilesDefaultOf(loadSubagentProfiles(dir), readProfilesDefault(dir)).id);
}

/** What choosing `row` writes to each older default file (pure): absent = that file is left as it is. */
export function olderDefaultsOf(row: JoinedProfile): { mode?: ModePatch; model?: string; thinking?: string; subagents?: string } {
  if (row.kind === "off") return { subagents: OFF_ID };
  const s = row.session;
  const mode: ModePatch = {};
  if (s?.mode) mode.mode = s.mode as ModePatch["mode"];
  if (s?.minorModes) mode.minorModes = [...s.minorModes];
  return {
    ...(mode.mode || mode.minorModes ? { mode } : {}),
    ...(s?.model ? { model: s.model } : {}),
    ...(s?.thinking ? { thinking: s.thinking } : {}),
    // Its helpers' id where it has them, "off" where it names Off; a profile with no helpers here (none
    // linked, or a link whose half isn't on this device) follows the default helpers as they stand.
    ...(row.library ? { subagents: row.library.id } : s?.subagents === OFF_ID ? { subagents: OFF_ID } : {}),
  };
}

export class DefaultRefusal extends Error {}

/**
 * Make `row` this computer's default: the older files first (only where what the profile sets
 * differs from what they hold, so an untouched file stays byte for byte), then default-profile.json.
 * `extraMode`: what else the mode menu's Make Default saves into mode.json (the chat's strict flag).
 */
export function chooseDefaultProfile(row: JoinedProfile, rows: readonly JoinedProfile[], extraMode: Pick<ModePatch, "strict"> = {}, dir = agentRoot()): DefaultProfileInfo {
  if (row.kind === "project" && rows.some((r) => r.group === "yours" && r.kind !== "library" && r.id === row.id))
    throw new DefaultRefusal(`One of your profiles has the id "${row.id}" too, so this project's profile can't be the default.`);
  if (row.approval === "needed") throw new DefaultRefusal(`${row.name} needs your approval first (Settings → Profiles).`);
  const older = olderDefaultsOf(row);
  const mode: ModePatch = { ...(older.mode ?? {}), ...extraMode };
  if (mode.mode || mode.minorModes || mode.strict !== undefined) {
    const now = readMode();
    const same =
      (mode.mode === undefined || mode.mode === now.mode) &&
      (mode.strict === undefined || mode.strict === now.strict) &&
      (mode.minorModes === undefined || (mode.minorModes.length === now.minorModes.length && mode.minorModes.every((m) => now.minorModes.includes(m))));
    if (!same) writeMode(mode);
  }
  const was = loadDefaults();
  const patch = { ...(older.model && older.model !== was.model ? { model: older.model } : {}), ...(older.thinking && older.thinking !== was.thinking ? { thinking: older.thinking } : {}) };
  if (Object.keys(patch).length) saveDefaults(patch);
  const lib = readProfilesDefault(dir);
  if (older.subagents && !(lib.state === "ok" && lib.value.default === older.subagents)) writeProfilesDefault(dir, { version: 1, default: older.subagents });
  writeDefaultProfileFile(row.kind === "off" ? OFF_ID : row.id);
  return { key: row.key, id: row.id, name: row.name, chosen: true };
}

export { OFF_KEY };
