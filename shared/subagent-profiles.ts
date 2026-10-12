// Wire types only. Runtime parsing belongs to the builtins-only extension store.
export type { SubagentProfile, SubagentProfilesFile, TeamsSetting } from "../pi-config/extensions/subagents/subagent-profiles";
import type { SubagentProfile, SubagentProfilesFile } from "../pi-config/extensions/subagents/subagent-profiles";
export interface SubagentProfilesInfo {
  settings: SubagentProfilesFile;
  /** This device's default: where new chats start. From subagent-profiles-default.json; "off" when that file is absent, malformed or dangling. */
  default: string;
  template: SubagentProfile;
  profiles: { id: string; name: string; footprint: string; providers: string[] }[];
  current: { id: string | null; name: string; source: "pick" | "default" | "legacy"; note?: string };
  file: string;
  error?: string;
  warnings?: string[];
  applies?: "now" | "after-turn";
  /**
   * Sync changed this device's library with another device's copy in the last 24 hours, and that
   * newest change isn't restored yet (§chat.subagent-profiles/replaced). `file` names the kept copy
   * Restore puts back.
   */
  replaced?: SubagentProfilesReplaced;
}
export interface SubagentProfilesReplaced {
  file: string;
  at: number;
  /** The device whose copy changed it: its name as this device's Mesh page knows it, else its id. */
  by: string;
  /** What that copy did here, by profile name; absent when unknown. */
  changes?: { added: string[]; changed: string[]; removed: string[] };
}
