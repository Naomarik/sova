import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seedReviewer } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { agentRoot, stateRoot } from "./state-root";
import type { AlignmentWebSettings, ExperimentalSettings, WebSettings } from "../shared/protocol";

/**
 * Sova's own settings — the ones that belong to the webapp rather than to pi or to an
 * extension's shared file. Today that is Settings → Alignment's Adversarial review switch
 * (`alignment.review`, §chat.alignment-review/flag) and Settings → Experimental's switches, of which
 * there are none right now. Adversarial review used to be Experimental's `adversarialReview`: a file
 * that has no `alignment.review` reads that value instead, and the first write stores it as
 * `alignment.review` (the old key is left as it was, never read again). The Claude Code provider used
 * to be an Experimental switch too; it is always on now, and an old file's
 * `experimental.claudeCodeProvider` is ignored, never written. Unlike server/settings.ts, whose
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
 * merge-write all follow this list. Any other key in the file or in a request is ignored. Empty
 * while there is no experiment (the tab says so).
 */
const EXPERIMENTAL_KEYS: readonly ExperimentalKey[] = [];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The known switches out of a stored or requested `experimental` object: `true` is on, anything else off. */
function knownSwitches(experimental: Record<string, unknown>): ExperimentalSettings {
  const out: Record<string, boolean> = {};
  for (const key of EXPERIMENTAL_KEYS) out[key] = experimental[key] === true;
  return out as unknown as ExperimentalSettings;
}

/**
 * The stored review switch: `alignment.review` when it is a boolean, else (a file an older build
 * wrote) Experimental's `adversarialReview`, else off.
 */
function storedReview(data: Record<string, unknown>): boolean {
  const alignment = isObject(data.alignment) ? data.alignment : {};
  if (typeof alignment.review === "boolean") return alignment.review;
  return isObject(data.experimental) && data.experimental.adversarialReview === true;
}

/** Everything off: what a missing, unreadable or foreign-shaped file reads as. */
const defaults = (): WebSettings => ({ experimental: knownSwitches({}), alignment: { review: false } });

/**
 * Read the stored settings, tolerantly: anything unexpected reads as the defaults rather than
 * throwing, because a broken settings file must not stop the server from serving.
 */
export function readWebSettings(): WebSettings {
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8")) as unknown;
    if (!isObject(data) || data.version !== 1) return defaults();
    return { experimental: knownSwitches(isObject(data.experimental) ? data.experimental : {}), alignment: { review: storedReview(data) } };
  } catch {
    return defaults(); // missing or corrupt: everything off
  }
}

/**
 * Validate and persist. The body is `{ experimental?: {...}, alignment?: { review? } }`: each part,
 * when present, must be an object, and a known key a boolean; an unknown key (an old
 * `claudeCodeProvider` or `adversarialReview`, a newer build's switch) is ignored, and `{}` writes
 * nothing new. Writes are re-read + merge (like web-sessions.ts): the file on disk is the source of
 * truth, and only the known keys this request carries are replaced, so a setting another server
 * instance added survives. Atomic via tmp + rename.
 */
export function writeWebSettings(raw: unknown): WebSettings | { error: string } {
  const bad = { error: "Expected { experimental?: { <switch>: boolean }, alignment?: { review?: boolean } }" };
  if (!isObject(raw)) return bad;
  if (raw.experimental !== undefined && !isObject(raw.experimental)) return bad;
  if (raw.alignment !== undefined && !isObject(raw.alignment)) return bad;
  const requested = isObject(raw.experimental) ? raw.experimental : {};
  const changes: Record<string, boolean> = {};
  for (const key of EXPERIMENTAL_KEYS) {
    if (!(key in requested)) continue;
    const value = requested[key];
    if (typeof value !== "boolean") return { error: `Expected experimental.${key} to be a boolean` };
    changes[key] = value;
  }
  const requestedAlignment = isObject(raw.alignment) ? raw.alignment : {};
  if (requestedAlignment.review !== undefined && typeof requestedAlignment.review !== "boolean") return { error: "Expected alignment.review to be a boolean" };
  const review = requestedAlignment.review as boolean | undefined;

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
  // The migration, once: the first write stores the review value as alignment.review (the old
  // Experimental key's, when this file has none), so the old key is never consulted again.
  const storedAlignment = isObject(stored.alignment) ? stored.alignment : {};
  const alignment = { ...storedAlignment, review: review ?? storedReview(stored) };
  // The first save that turns adversarial review on gives every subagent profile without a
  // reviewer the default one (§chat.alignment-review/route). `seeded` remembers it ran, so an
  // off-and-on again seeds nothing; a library that can't be read leaves it unmarked, to retry.
  const seeded: Record<string, unknown> = isObject(stored.seeded) ? { ...stored.seeded } : {};
  if (review === true && seeded.adversarialReview !== true) {
    try {
      if (seedReviewer(agentRoot()).ok) seeded.adversarialReview = true;
    } catch (error) {
      console.warn("[settings] seeding the default reviewer failed:", error instanceof Error ? error.message : error);
    }
  }
  const next = { ...stored, version: 1, experimental, alignment, ...(Object.keys(seeded).length > 0 ? { seeded } : {}) };
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
  renameSync(tmp, FILE);
  return { experimental: knownSwitches(experimental), alignment: { review: alignment.review } };
}

/** The review switch as saved now, for a chat's first start (chat-manager.ts sessionFlags). */
export const reviewSaved = (): AlignmentWebSettings["review"] => readWebSettings().alignment.review;
