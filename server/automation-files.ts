import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTOMATIONS_DIR, parseAutomation } from "../shared/automations";
import type { AutomationRead } from "./schedules";

/** A project's automation files (§chat.schedules/automation-file), each parsed or with its exact error;
    read every time, with no cache. */
export async function readAutomations(root: string): Promise<AutomationRead[]> {
  const dir = join(root, AUTOMATIONS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: AutomationRead[] = [];
  for (const n of names) {
    const id = n.slice(0, -".json".length);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, n), "utf8"));
    } catch (err) {
      out.push({ id, error: `${n} is not JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const a = parseAutomation(raw, id);
    out.push("error" in a ? { id, error: a.error } : { id, automation: a });
  }
  return out;
}
