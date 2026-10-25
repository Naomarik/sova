import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  createNativeCompactionEventCollector, NativeCompactionEventError,
  type NativeCompactionEventFailure,
} from './native-compaction-events';
import {
  compatibleNative, parseNativeCompaction, replayNativePrefix, retainNativeUsers,
  type NativeIdentity, type NativeItem,
} from './native-compaction-state';

type StreamArgs = Parameters<ModelRegistry['streamSimple']>;
export type NativeCompactionCallOptions = NonNullable<StreamArgs[2]>;
/** Structural injection seam: the actual configured ModelRegistry satisfies it. */
export interface NativeCompactionCallRegistry {
  streamSimple(model: StreamArgs[0], context: StreamArgs[1], options?: StreamArgs[2]):
    AsyncIterable<unknown> & { result(): Promise<{ stopReason: string }> };
}
export interface NativeCompactionCallInput {
  registry: NativeCompactionCallRegistry;
  model: StreamArgs[0];
  context: StreamArgs[1];
  options?: NativeCompactionCallOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPayloadBytes?: number;
  priorPrefix?: {
    state: unknown;
    identity: NativeIdentity;
    expectedSummaryItem: unknown;
    /** Caller witnesses the genuine compactionSummary in FINAL transformed context, not payload text.
     * Absent/false means portable fallback, even if a tail user quotes the exact serialized summary. */
    summaryPresent?: boolean;
  };
}
export interface NativeCompactionCallResult {
  replacementHistory: NativeItem[];
  item: NativeItem;
  responseId: string;
  usage?: NativeItem;
}
export type NativeCompactionCallFailure = NativeCompactionEventFailure |
  'timeout' | 'invalid-payload' | 'missing-payload' | 'normalized-failed';
export class NativeCompactionCallError extends Error {
  constructor(readonly code: NativeCompactionCallFailure) {
    super(`Native compaction call rejected: ${code}`);
    this.name = 'NativeCompactionCallError';
  }
}
const MAX_TIMEOUT_MS = 120_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_NORMALIZED_EVENTS = 20_000;
function bound(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) throw new NativeCompactionCallError('invalid-payload');
  return Math.min(value, maximum);
}
function record(value: unknown): value is NativeItem {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Do not coerce unknown values with toJSON, getters, or a second Responses converter. */
function json(value: unknown, depth = 0, seen = new Set<object>(), budget = { nodes: 100_000 }): boolean {
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
    return property.enumerable && 'value' in property &&
      ((property.value === undefined && !Array.isArray(value)) || json(property.value, depth + 1, seen, budget));
  });
  seen.delete(value);
  return valid;
}
function inputSafe(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if (record(value) && value.type === 'compaction_trigger') return false;
  return Object.entries(value).every(([key, child]) =>
    !/^(authorization|proxy-authorization|access_token|refresh_token|api_key|credentials)$/i.test(key) && inputSafe(child));
}
function checkedPayload(value: unknown, maxBytes: number): NativeItem & { input: NativeItem[] } {
  if (!json(value) || !record(value) || value.context_management !== undefined ||
      value.previous_response_id !== undefined || !Array.isArray(value.input) ||
      !value.input.every(item => record(item) &&
        ((typeof item.type === 'string' && item.type.trim().length > 0) ||
          (item.type === undefined && item.role === 'user' && Array.isArray(item.content))) && inputSafe(item))) {
    throw new NativeCompactionCallError('invalid-payload');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new NativeCompactionCallError('oversized');
  return JSON.parse(serialized) as NativeItem & { input: NativeItem[] };
}

/**
 * Nested configured-provider operation only. Caller owns eligibility, effective prefix/tool snapshot,
 * compatibility identity, portable summary, accounting and atomic checkpoint persistence.
 */
export async function callNativeCompaction(input: NativeCompactionCallInput): Promise<NativeCompactionCallResult> {
  const timeoutMs = bound(input.timeoutMs ?? input.options?.timeoutMs, MAX_TIMEOUT_MS);
  const maxBytes = bound(input.maxPayloadBytes, MAX_PAYLOAD_BYTES);
  const controller = new AbortController();
  let failure: NativeCompactionCallFailure | undefined;
  let retained: NativeItem[] | undefined;
  let payloadSeen = false;
  const collector = createNativeCompactionEventCollector({ signal: controller.signal });
  const sources = [...new Set([input.signal, input.options?.signal].filter((signal): signal is AbortSignal => !!signal))];
  let stop!: (error: NativeCompactionCallError) => void;
  const stopped = new Promise<never>((_resolve, reject) => { stop = reject; });
  const cancel = (code: 'aborted' | 'timeout') => {
    failure ??= code;
    controller.abort();
    stop(new NativeCompactionCallError(failure));
  };
  const abort = () => cancel('aborted');
  // Check before making the registry call or creating a potentially unhandled rejected promise.
  if (sources.some(signal => signal.aborted)) throw new NativeCompactionCallError('aborted');
  for (const signal of sources) signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => cancel('timeout'), timeoutMs);
  function active() {
    if (failure) throw new NativeCompactionCallError(failure);
  }
  function sanitized(error: unknown): NativeCompactionCallError {
    if (failure) return new NativeCompactionCallError(failure);
    if (error instanceof NativeCompactionCallError || error instanceof NativeCompactionEventError) {
      return new NativeCompactionCallError(error.code);
    }
    return new NativeCompactionCallError('stream-failed');
  }
  const options: NativeCompactionCallOptions = {
    ...input.options,
    signal: controller.signal,
    timeoutMs,
    transport: 'sse',
    // One logical artifact attempt, no transparent retry merging of terminal event sets.
    maxRetries: 0,
    async onPayload(raw, model) {
      try {
        active();
        if (payloadSeen) throw new NativeCompactionCallError('invalid-payload');
        payloadSeen = true;
        const transformed = await input.options?.onPayload?.(raw, model);
        active();
        let payload = checkedPayload(transformed === undefined ? raw : transformed, maxBytes);
        const prior = input.priorPrefix;
        const state = prior ? parseNativeCompaction(prior.state) : null;
        if (prior && state && compatibleNative(state, prior.identity)) {
          payload = checkedPayload(replayNativePrefix(payload, prior.expectedSummaryItem, state,
            { summaryPresent: prior.summaryPresent === true }), maxBytes);
        }
        // Preserve generated instructions/tools/reasoning/cache fields, changing only control fields.
        const patched = checkedPayload(payload, maxBytes);
        const generatedInput = patched.input;
        const result = { ...patched, store: false, stream: true, input: [...generatedInput, { type: 'compaction_trigger' }] };
        // The trigger itself also counts toward the request limit.
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) throw new NativeCompactionCallError('oversized');
        retained = retainNativeUsers(generatedInput);
        return result;
      } catch (error) {
        const safe = sanitized(error);
        failure ??= safe.code;
        throw safe;
      }
    },
    async onProviderStreamEvent(event, model) {
      try {
        active();
        collector.push(event);
        await input.options?.onProviderStreamEvent?.(event, model);
        active();
      } catch (error) {
        const safe = sanitized(error);
        failure ??= safe.code;
        throw safe;
      }
    },
  };
  async function run(): Promise<NativeCompactionCallResult> {
    try {
      active();
      const stream = input.registry.streamSimple(input.model, input.context, options);
      let normalizedEvents = 0;
      for await (const _event of stream) {
        active();
        if (++normalizedEvents > MAX_NORMALIZED_EVENTS) throw new NativeCompactionCallError('oversized');
      }
      const normalized = await stream.result();
      active();
      if (normalized.stopReason === 'aborted') throw new NativeCompactionCallError('aborted');
      const result = collector.finish();
      if (normalized.stopReason !== 'stop') throw new NativeCompactionCallError('normalized-failed');
      if (!payloadSeen || retained === undefined) throw new NativeCompactionCallError('missing-payload');
      return { replacementHistory: [...retained, result.item], ...result };
    } catch (error) { throw sanitized(error); }
  }
  try { return await Promise.race([run(), stopped]); }
  finally {
    clearTimeout(timer);
    for (const signal of sources) signal.removeEventListener('abort', abort);
    // Release provider work even when an injected stream ignores cancellation/never settles.
    controller.abort();
  }
}
