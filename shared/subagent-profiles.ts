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
}
