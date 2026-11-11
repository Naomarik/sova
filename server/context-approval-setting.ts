import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";

/**
 * The Sova-wide "Allow context files and skills without asking" switch, kept on this computer only:
 * `<state root>/context-approval.json` `{ allowWithoutAsking: true | false }`. No file at all: on (the default).
 * A file that can't be read, isn't JSON or doesn't hold a boolean `allowWithoutAsking` fails closed: asking stays
 * on, with a warning logged. Read at every new chat's build and first send, never cached.
 */

export const CONTEXT_APPROVAL_FILE = "context-approval.json";
export const contextApprovalPath = (): string => join(stateRoot(), CONTEXT_APPROVAL_FILE);

let warned = "";
/** One warning per distinct trouble: the file is read at every build. */
function failClosed(why: string): false {
  if (why !== warned) {
    warned = why;
    console.warn(`[context-approval] ${contextApprovalPath()}: ${why}; asking first until it is fixed or set again in Settings → General.`);
  }
  return false;
}

export function allowWithoutAsking(): boolean {
  let text: string;
  try {
    text = readFileSync(contextApprovalPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return true;
    return failClosed(`unreadable (${err instanceof Error ? err.message : String(err)})`);
  }
  let v: unknown;
  try {
    v = (JSON.parse(text) as { allowWithoutAsking?: unknown } | null)?.allowWithoutAsking;
  } catch {
    return failClosed("not JSON");
  }
  if (typeof v !== "boolean") return failClosed("no allowWithoutAsking true or false in it");
  warned = "";
  return v;
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
