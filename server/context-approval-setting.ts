import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * The Sova-wide "Allow context files and skills without asking" switch, kept on this computer only:
 * `<state root>/context-approval.json` `{ allowWithoutAsking: false }`. Absent, unreadable or anything but
 * `false`: on (the default). Read at every new chat's build and first send, never cached.
 */

export const CONTEXT_APPROVAL_FILE = "context-approval.json";
export const contextApprovalPath = (): string => join(stateRoot(), CONTEXT_APPROVAL_FILE);

export function allowWithoutAsking(): boolean {
  try {
    return (JSON.parse(readFileSync(contextApprovalPath(), "utf8")) as { allowWithoutAsking?: unknown } | null)?.allowWithoutAsking !== false;
  } catch {
    return true;
  }
}

/** Whether new chats ask first (the switch is off). */
export const askingFirst = (): boolean => !allowWithoutAsking();

export function setAllowWithoutAsking(on: boolean): void {
  const file = contextApprovalPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ allowWithoutAsking: on }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
