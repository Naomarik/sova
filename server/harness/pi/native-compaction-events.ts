import { isDeepStrictEqual } from 'node:util';
import { isCompactionItem, type NativeItem } from './native-compaction-state';

export type NativeCompactionEventFailure =
  | 'aborted' | 'stream-failed' | 'incomplete' | 'invalid-event' | 'oversized'
  | 'missing-completion' | 'invalid-completion' | 'invalid-artifact'
  | 'multiple-artifacts' | 'conflicting-artifact' | 'invalid-usage';

/** Never attach provider text, ciphertext, raw events, or a caught exception as a cause. */
export class NativeCompactionEventError extends Error {
  constructor(readonly code: NativeCompactionEventFailure) {
    super(`Native compaction rejected: ${code}`);
    this.name = 'NativeCompactionEventError';
  }
}
export interface NativeCompactionEventLimits {
  maxEvents?: number;
  maxBytes?: number;
  maxArtifactBytes?: number;
  signal?: AbortSignal;
}
export interface NativeCompactionEventResult {
  responseId: string;
  item: NativeItem;
  /** Raw finite Responses token usage, not an invented estimate or assistant usage. */
  usage?: NativeItem;
}
const DEFAULT_EVENTS = 10_000;
const DEFAULT_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARTIFACT_BYTES = 2 * 1024 * 1024;
function record(value: unknown): value is NativeItem {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function limit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new NativeCompactionEventError('invalid-event');
  return Math.min(value, fallback);
}

/** Parsed wire JSON only: bound traversal and reject hidden non-JSON/accessor/toJSON values. */
function jsonOnly(value: unknown, depth = 0, seen = new Set<object>(), budget = { nodes: 100_000 }): boolean {
  if (--budget.nodes < 0 || depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    if (typeof key !== 'string') return false;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    return property.enumerable && 'value' in property && jsonOnly(property.value, depth + 1, seen, budget);
  });
  seen.delete(value);
  return valid;
}
/** Forward fields survive, but request controls and recognizable credentials must not become durable. */
function durable(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if (record(value) && value.type === 'compaction_trigger') return false;
  return Object.entries(value).every(([key, child]) =>
    !/^(authorization|proxy-authorization|access_token|refresh_token|api_key|credentials)$/i.test(key) && durable(child));
}
function token(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function validUsage(usage: NativeItem): boolean {
  if (!token(usage.input_tokens) || !token(usage.output_tokens)) return false;
  if (usage.total_tokens !== undefined && !token(usage.total_tokens)) return false;
  for (const key of ['input_tokens_details', 'output_tokens_details']) {
    const details = usage[key];
    if (details !== undefined && details !== null &&
        (!record(details) || !Object.values(details).every(token))) return false;
  }
  const cached = record(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : undefined;
  const reasoning = record(usage.output_tokens_details) ? usage.output_tokens_details.reasoning_tokens : undefined;
  return (cached === undefined || (token(cached) && cached <= usage.input_tokens)) &&
    (reasoning === undefined || (token(reasoning) && reasoning <= usage.output_tokens));
}

/**
 * Injectable raw-event callback. Failures latch rather than throwing from push: SDK callbacks may
 * swallow throws. finish must run only after the caller has drained the stream and checked its result.
 * This validates no normalized assistant stopReason and performs no request, IO, or persistence.
 */
export function createNativeCompactionEventCollector(options: NativeCompactionEventLimits = {}) {
  const maxEvents = limit(options.maxEvents, DEFAULT_EVENTS);
  const maxBytes = limit(options.maxBytes, DEFAULT_BYTES);
  const maxArtifactBytes = limit(options.maxArtifactBytes, DEFAULT_ARTIFACT_BYTES);
  let failure: NativeCompactionEventFailure | undefined;
  let events = 0;
  let bytes = 0;
  let completed: NativeCompactionEventResult | undefined;
  let streamed: NativeItem | undefined;
  let streamedIndex: number | undefined;
  const fail = (code: NativeCompactionEventFailure) => { failure ??= code; };
  function artifact(item: unknown): item is NativeItem {
    if (!isCompactionItem(item) || (item.status !== undefined && item.status !== 'completed') || !durable(item)) {
      fail('invalid-artifact');
      return false;
    }
    if (Buffer.byteLength(JSON.stringify(item), 'utf8') > maxArtifactBytes) {
      fail('oversized');
      return false;
    }
    return true;
  }
  function push(raw: unknown): void {
    if (options.signal?.aborted) fail('aborted');
    if (failure) return;
    try {
      if (++events > maxEvents) { fail('oversized'); return; }
      if (!jsonOnly(raw) || !record(raw) || !nonempty(raw.type)) { fail('invalid-event'); return; }
      const json = JSON.stringify(raw);
      bytes += Buffer.byteLength(json, 'utf8');
      if (bytes > maxBytes) { fail('oversized'); return; }
      // Detach immediately: caller mutation must never turn a validated checkpoint into another one.
      const event = JSON.parse(json) as NativeItem;
      const type = event.type;
      if (type === 'error' || type === 'response.failed' || event.error != null) { fail('stream-failed'); return; }
      if (type === 'response.incomplete' || type === 'response.done' || type === 'response.cancelled') {
        fail('incomplete'); return;
      }
      if (type === 'compaction_trigger' ||
          ((type === 'response.output_item.added' || type === 'response.output_item.done') &&
            record(event.item) && event.item.type === 'compaction_trigger')) {
        fail('invalid-artifact'); return;
      }
      if (completed) { fail('invalid-completion'); return; }
      if (type === 'response.output_item.done') {
        const item = event.item;
        if (!record(item)) { fail('invalid-event'); return; }
        if (item.type === 'compaction_trigger') { fail('invalid-artifact'); return; }
        if (item.type !== 'compaction') return;
        if (!artifact(item)) return;
        const index = event.output_index;
        if (index !== undefined && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) {
          fail('invalid-event'); return;
        }
        if (streamed) {
          // Only a retransmission at the SAME explicit slot is a duplicate done event.
          if (streamed.id !== item.id || index === undefined || index !== streamedIndex) fail('multiple-artifacts');
          else if (!isDeepStrictEqual(streamed, item)) fail('conflicting-artifact');
          return;
        }
        streamed = item;
        streamedIndex = index as number | undefined;
      } else if (type === 'response.completed') {
        const response = event.response;
        if (!record(response) || response.status !== 'completed' || !nonempty(response.id) ||
            response.error != null || response.incomplete_details != null) {
          fail('invalid-completion'); return;
        }
        let item = streamed;
        if (response.output !== undefined) {
          if (!Array.isArray(response.output) || !response.output.every(record)) { fail('invalid-completion'); return; }
          if (response.output.some(output => output.type === 'compaction_trigger')) { fail('invalid-artifact'); return; }
          const candidates = response.output.filter(output => output.type === 'compaction');
          if (candidates.length > 1) { fail('multiple-artifacts'); return; }
          if (candidates.length !== 1 || !artifact(candidates[0])) { fail('invalid-artifact'); return; }
          const finalItem = candidates[0];
          if (streamed && !isDeepStrictEqual(streamed, finalItem)) { fail('conflicting-artifact'); return; }
          if (streamedIndex !== undefined && response.output[streamedIndex] !== finalItem) { fail('conflicting-artifact'); return; }
          item = finalItem;
        }
        if (!item) { fail('invalid-artifact'); return; }
        const usage = response.usage;
        if (usage != null && (!record(usage) || !validUsage(usage) || !durable(usage))) { fail('invalid-usage'); return; }
        completed = { responseId: response.id, item, ...(usage == null ? {} : { usage: usage as NativeItem }) };
      }
    } catch { fail('invalid-event'); }
  }
  function finish(): NativeCompactionEventResult {
    if (options.signal?.aborted) throw new NativeCompactionEventError('aborted');
    if (!completed) fail('missing-completion');
    if (failure) throw new NativeCompactionEventError(failure);
    return JSON.parse(JSON.stringify(completed)) as NativeCompactionEventResult;
  }
  /** Mark transport/result failures without ever accepting their raw error message or cause. */
  function reject(code: 'aborted' | 'stream-failed' = 'stream-failed'): void { fail(code); }
  return { push, finish, reject };
}

/** Offline/buffered validation convenience. Runtime callers should push as each raw event arrives. */
export function validateNativeCompactionEvents(
  events: Iterable<unknown>, options: NativeCompactionEventLimits = {},
): NativeCompactionEventResult {
  const collector = createNativeCompactionEventCollector(options);
  try {
    let count = 0;
    for (const event of events) {
      collector.push(event);
      // Stop even a nonterminating injected iterable at the collection bound.
      if (++count > Math.min(options.maxEvents ?? DEFAULT_EVENTS, DEFAULT_EVENTS)) break;
    }
  } catch { collector.reject(); }
  return collector.finish();
}
