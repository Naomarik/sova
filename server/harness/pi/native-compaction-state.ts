import { isDeepStrictEqual } from 'node:util';

/** Opaque provider items are JSON, not assistant text or reasoning signatures. */
export type NativeItem = Record<string, unknown>;
export interface NativeIdentity {
  provider: 'openai-codex';
  api: 'openai-codex-responses';
  modelId: string;
  endpointOrigin: 'https://chatgpt.com';
  accountFingerprint: string;
}
export interface NativeCompactionState extends NativeIdentity {
  v: 1;
  protocol: 'codex-responses-v2';
  boundary: { kind: 'pi-old-prefix'; firstKeptEntryId: string };
  replacementHistory: NativeItem[];
  responseId: string;
}

export const NATIVE_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const NATIVE_RETAINED_MAX_BYTES = 64 * 1024;
export const NATIVE_RETAINED_MAX_ITEMS = 8;

function record(value: unknown): value is NativeItem {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function bytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? Infinity : Buffer.byteLength(json, 'utf8');
  } catch { return Infinity; }
}
/** Reject non-JSON input, cycles and nested request controls, not just the top-level type. */
function durableJson(value: unknown, seen = new Set<object>(), depth = 0, budget = { nodes: 100_000 }): boolean {
  if (--budget.nodes < 0 || depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const valid = Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    if (typeof key !== 'string' || /^(authorization|proxy-authorization|access_token|refresh_token|api_key|credentials)$/i.test(key)) return false;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !('value' in property)) return false;
    if (key === 'type' && property.value === 'compaction_trigger') return false;
    return durableJson(property.value, seen, depth + 1, budget);
  });
  seen.delete(value);
  return valid;
}
function userItem(item: unknown): item is NativeItem {
  return record(item) && item.role === 'user' && (item.type === undefined || item.type === 'message') &&
    Array.isArray(item.content) && item.content.length > 0 && item.content.every(part =>
      record(part) && ((part.type === 'input_text' && typeof part.text === 'string') ||
        (part.type === 'input_image' && nonempty(part.image_url))));
}
export function isCompactionItem(item: unknown): item is NativeItem {
  return record(item) && item.type === 'compaction' && nonempty(item.id) && nonempty(item.encrypted_content);
}

/** Unknown versions and incomplete/malformed checkpoints always use the portable summary. */
export function parseNativeCompaction(value: unknown): NativeCompactionState | null {
  if (!record(value) || !durableJson(value) || bytes(value) > NATIVE_STATE_MAX_BYTES) return null;
  const keys = new Set(['v', 'protocol', 'provider', 'api', 'modelId', 'endpointOrigin', 'accountFingerprint',
    'boundary', 'replacementHistory', 'responseId']);
  if (Object.keys(value).some(key => !keys.has(key))) return null;
  if (value.v !== 1 || value.protocol !== 'codex-responses-v2' ||
      value.provider !== 'openai-codex' || value.api !== 'openai-codex-responses' ||
      value.endpointOrigin !== 'https://chatgpt.com' || !nonempty(value.modelId) ||
      typeof value.accountFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.accountFingerprint) ||
      !nonempty(value.responseId) || !record(value.boundary) || value.boundary.kind !== 'pi-old-prefix' ||
      !nonempty(value.boundary.firstKeptEntryId) || Object.keys(value.boundary).some(key => key !== 'kind' && key !== 'firstKeptEntryId') ||
      !Array.isArray(value.replacementHistory)) return null;
  const history = value.replacementHistory;
  if (!history.length || history.length > NATIVE_RETAINED_MAX_ITEMS + 1 || !isCompactionItem(history.at(-1))) return null;
  const retained = history.slice(0, -1);
  if (!retained.every(userItem) || bytes(retained) > NATIVE_RETAINED_MAX_BYTES) return null;
  // Detach from the parsed entry: no request-local patch may mutate durable history.
  return JSON.parse(JSON.stringify(value)) as NativeCompactionState;
}
export function compatibleNative(state: NativeCompactionState, identity: NativeIdentity): boolean {
  return state.provider === identity.provider && state.api === identity.api &&
    state.modelId === identity.modelId && state.endpointOrigin === identity.endpointOrigin &&
    state.accountFingerprint === identity.accountFingerprint;
}

/** Caller supplies active ancestry, never the complete session file. A text checkpoint is a barrier. */
export function latestNativeCompaction(branch: readonly { type: string; details?: unknown }[]): NativeCompactionState | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== 'compaction') continue;
    return record(entry.details) ? parseNativeCompaction(entry.details.sovaNativeCompaction) : null;
  }
  return null;
}

/** Retention is bounded in UTF-8 bytes, including images, and preserves chronological order. */
export function retainNativeUsers(input: readonly unknown[]): NativeItem[] {
  const retained: NativeItem[] = [];
  for (let i = input.length - 1; i >= 0 && retained.length < NATIVE_RETAINED_MAX_ITEMS; i--) {
    const item = input[i];
    if (!userItem(item) || !durableJson(item)) continue;
    if (bytes([item, ...retained]) > NATIVE_RETAINED_MAX_BYTES) continue;
    retained.unshift(JSON.parse(JSON.stringify(item)) as NativeItem);
  }
  return retained;
}

/**
 * Exact whole-item matching only. A collision is fallback, never permission to guess.
 * The caller must separately witness a genuine compactionSummary in the final transformed
 * request context. A user quoting the summary is not that witness. Payload text alone cannot
 * distinguish the quote after a context hook has removed the actual checkpoint.
 */
export function replayNativePrefix(
  payload: unknown, expectedSummaryItem: unknown, state: NativeCompactionState,
  provenance?: { summaryPresent: boolean },
): unknown {
  if (!provenance?.summaryPresent || !record(payload) || !Array.isArray(payload.input) || !userItem(expectedSummaryItem) ||
      !parseNativeCompaction(state)) return payload;
  const matches: number[] = [];
  payload.input.forEach((item, index) => { if (isDeepStrictEqual(item, expectedSummaryItem)) matches.push(index); });
  if (matches.length !== 1) return payload;
  const index = matches[0]!;
  return { ...payload, input: [
    ...payload.input.slice(0, index),
    ...JSON.parse(JSON.stringify(state.replacementHistory)) as NativeItem[],
    ...payload.input.slice(index + 1),
  ] };
}
