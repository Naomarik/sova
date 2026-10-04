import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { seedReviewer } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { stateRoot } from "./state-root";
import type { ExperimentalSettings, WebSettings } from "../shared/protocol";

/**
 * Sova's own settings — the ones that belong to the webapp rather than to pi or to an
 * extension's shared file. Today that is Settings → Experimental's switches: adversarial review
 * (§chat.alignment-review/flag). The Claude Code provider used to be one; it is always on now, and an old file's
 * `experimental.claudeCodeProvider` is ignored, never written). Unlike server/settings.ts, whose
 * file shape is a contract with the subagents extension, nothing outside Sova reads this one.
 *
 * It lives under the agent dir, so PI_CODING_AGENT_DIR (the hermetic .agent) isolates it the
 * same way it isolates sessions and web-sessions.json.
 */
const FILE = join(stateRoot(), "settings.json");


type ExperimentalKey = keyof ExperimentalSettings;

/**
 * The experimental switches Sova knows, each a boolean, off unless stored `true`. A new switch is
 * one key here and in ExperimentalSettings (shared/protocol.ts); reading, validating and the
 * merge-write all follow this list. Any other key in the file or in a request is ignored.
 */
const EXPERIMENTAL_KEYS: readonly ExperimentalKey[] = ["adversarialReview"];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The known switches out of a stored or requested `experimental` object: `true` is on, anything else off. */
function knownSwitches(experimental: Record<string, unknown>): ExperimentalSettings {
  const out: Record<string, boolean> = {};
  for (const key of EXPERIMENTAL_KEYS) out[key] = experimental[key] === true;
  return out as unknown as ExperimentalSettings;
}

/** Everything off: what a missing, unreadable or foreign-shaped file reads as. */
const defaults = (): WebSettings => ({ experimental: knownSwitches({}) });

/**
 * Read the stored settings, tolerantly: anything unexpected reads as the defaults rather than
 * throwing, because a broken settings file must not stop the server from serving.
 */
export function readWebSettings(): WebSettings {
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>;
    if (data.version !== 1 || !isObject(data.experimental)) return defaults();
    return { experimental: knownSwitches(data.experimental) };
  } catch {
    return defaults(); // missing or corrupt: everything off
  }
}

/**
 * Validate and persist. The body is `{ experimental: {...} }`: a known key must be a boolean, an
 * unknown one (an old `claudeCodeProvider`, a newer build's switch) is ignored, and `{}` writes
 * nothing new. Writes are re-read + merge (like web-sessions.ts): the file on disk is the source of
 * truth, and only the known keys this request carries are replaced, so a setting another server
 * instance added survives. Atomic via tmp + rename.
 */
export function writeWebSettings(raw: unknown): WebSettings | { error: string } {
  const bad = { error: "Expected { experimental: { <switch>: boolean } }" };
  if (!isObject(raw) || !isObject(raw.experimental)) return bad;
  const requested = raw.experimental;
  const changes: Record<string, boolean> = {};
  for (const key of EXPERIMENTAL_KEYS) {
    if (!(key in requested)) continue;
    const value = requested[key];
    if (typeof value !== "boolean") return { error: `Expected experimental.${key} to be a boolean` };
    changes[key] = value;
  }

  // Re-read so keys we do not know about, or that another writer just added, are not dropped.
  let stored: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(readFileSync(FILE, "utf8"));
    if (isObject(data)) stored = data;
  } catch {
    stored = {}; // missing or corrupt: start from nothing rather than refusing the write
  }
  const storedExperimental = isObject(stored.experimental) ? stored.experimental : {};

  const experimental = { ...storedExperimental, ...changes };
  // The first save that turns adversarial review on gives every subagent profile without a
  // reviewer the default one (§chat.alignment-review/route). `seeded` remembers it ran, so an
  // off-and-on again seeds nothing; a library that can't be read leaves it unmarked, to retry.
  const seeded: Record<string, unknown> = isObject(stored.seeded) ? { ...stored.seeded } : {};
  if (changes.adversarialReview === true && seeded.adversarialReview !== true) {
    try {
      if (seedReviewer(getAgentDir()).ok) seeded.adversarialReview = true;
    } catch (error) {
      console.warn("[settings] seeding the default reviewer failed:", error instanceof Error ? error.message : error);
    }
  }
  const next = { ...stored, version: 1, experimental, ...(Object.keys(seeded).length > 0 ? { seeded } : {}) };
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
  renameSync(tmp, FILE);
  return { experimental: knownSwitches(experimental) };
}
