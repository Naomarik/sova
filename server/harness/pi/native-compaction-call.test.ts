import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  callNativeCompaction, NativeCompactionCallError,
  type NativeCompactionCallInput, type NativeCompactionCallRegistry, type NativeCompactionCallOptions,
} from './native-compaction-call';

const model = {
  id: 'offline-model', provider: 'openai-codex', api: 'openai-codex-responses',
} as NativeCompactionCallInput['model'];
const context: NativeCompactionCallInput['context'] = { messages: [] };
const artifact = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'ciphertext-secret', future: { v: 9 } };
const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const usage = { input_tokens: 19, output_tokens: 7, total_tokens: 26, input_tokens_details: { cached_tokens: 3 } };
const completion = (includeUsage = true) => ({ type: 'response.completed', response: {
  id: 'resp_fixture', status: 'completed', output: [artifact], ...(includeUsage ? { usage } : {}),
} });
const payload = () => ({
  model: 'offline-model', instructions: 'Effective instructions', store: true, stream: true,
  input: [user('old user'), { type: 'function_call_output', call_id: 'call_fixture', output: 'tool output' }],
  tools: [{ type: 'function', name: 'effective_tool', description: 'effective declaration' }],
  reasoning: { effort: 'high' }, text: { verbosity: 'low' }, prompt_cache_key: 'cache_fixture',
  future: { retained: true },
});
function fixture(config: {
  rawPayload?: unknown; events?: unknown[]; stopReason?: string;
  skipPayload?: boolean; throwAfter?: boolean; swallowCallbacks?: boolean;
} = {}) {
  let observedOptions: NativeCompactionCallOptions | undefined;
  let generated: unknown;
  let drained = false;
  let calls = 0;
  const registry: NativeCompactionCallRegistry = {
    streamSimple(actualModel, actualContext, options) {
      calls++;
      assert.equal(actualModel, model);
      assert.equal(actualContext, context);
      observedOptions = options;
      return {
        async *[Symbol.asyncIterator]() {
          if (!config.skipPayload) {
            try { generated = await options?.onPayload?.(config.rawPayload ?? payload(), model); }
            catch (error) { if (!config.swallowCallbacks) throw error; }
          }
          for (const event of config.events ?? [
            { type: 'response.output_item.done', output_index: 0, item: artifact }, completion(),
          ]) {
            try { await options?.onProviderStreamEvent?.(event, model); }
            catch (error) { if (!config.swallowCallbacks) throw error; }
            yield { type: 'text_delta', delta: '' };
          }
          if (config.throwAfter) throw new Error('provider-secret ciphertext-secret');
          drained = true;
        },
        async result() {
          assert.equal(drained, true, 'normalized result must be checked only after drain');
          // A normalized result can carry invented zeros; the call must not return them as native usage.
          return { stopReason: config.stopReason ?? 'stop', usage: { input: 0, output: 0 }, errorMessage: 'provider-secret' };
        },
      };
    },
  };
  return {
    registry, get generated() { return generated; }, get options() { return observedOptions; },
    get drained() { return drained; }, get calls() { return calls; },
  };
}
async function rejectCall(input: NativeCompactionCallInput, code: string) {
  await assert.rejects(callNativeCompaction(input), error => {
    assert.ok(error instanceof NativeCompactionCallError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Native compaction call rejected: ${code}`);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes('ciphertext-secret'));
    assert.ok(!String(error.stack).includes('provider-secret'));
    return true;
  });
}
const identity = {
  provider: 'openai-codex', api: 'openai-codex-responses', modelId: 'offline-model',
  endpointOrigin: 'https://chatgpt.com', accountFingerprint: 'a'.repeat(64),
} as const;
const priorState = () => ({
  ...identity, v: 1, protocol: 'codex-responses-v2',
  boundary: { kind: 'pi-old-prefix', firstKeptEntryId: 'boundary_fixture' },
  responseId: 'resp_old', replacementHistory: [user('retained prior user'), { ...artifact, id: 'cmp_old' }],
});

describe('injectable native compaction call', () => {
  it('uses the configured registry once, preserves generated shape, and appends exactly one trailing trigger', async () => {
    const f = fixture();
    const options: NativeCompactionCallOptions = { transport: 'websocket', sessionId: 'session_fixture', maxRetries: 8, timeoutMs: 250_000 };
    const result = await callNativeCompaction({ registry: f.registry, model, context, options });
    assert.equal(f.calls, 1);
    assert.equal(f.drained, true);
    assert.equal(f.options?.transport, 'sse');
    assert.equal(f.options?.maxRetries, 0);
    assert.equal(f.options?.timeoutMs, 120_000);
    assert.equal(f.options?.sessionId, options.sessionId);
    assert.deepEqual(options, { transport: 'websocket', sessionId: 'session_fixture', maxRetries: 8, timeoutMs: 250_000 });
    assert.deepEqual(f.generated, { ...payload(), store: false, input: [...payload().input, { type: 'compaction_trigger' }] });
    assert.deepEqual(result, { item: artifact, responseId: 'resp_fixture', usage, replacementHistory: [user('old user'), artifact] });
    assert.equal(payload().store, true);
    assert.equal(f.options?.signal?.aborted, true, 'request-local signal is released after the call');
  });

  it('returns usage only when the raw backend supplied it, never normalized zeros', async () => {
    const f = fixture({ events: [completion(false)] });
    const result = await callNativeCompaction({ registry: f.registry, model, context });
    assert.equal(Object.hasOwn(result, 'usage'), false);
    assert.deepEqual(result.replacementHistory, [user('old user'), artifact]);
  });

  it('composes captured callbacks before the final control patch without mutating caller payload', async () => {
    const raw = payload();
    let observedEvents = 0;
    const f = fixture({ rawPayload: raw });
    await callNativeCompaction({ registry: f.registry, model, context, options: {
      onPayload: body => ({ ...(body as Record<string, unknown>), store: true, future: { custom: true } }),
      onProviderStreamEvent: () => { observedEvents++; },
    } });
    assert.equal(observedEvents, 2);
    assert.deepEqual(f.generated, { ...raw, future: { custom: true }, store: false, input: [...raw.input, { type: 'compaction_trigger' }] });
    assert.deepEqual(raw, payload());
  });

  it('expands only compatible prior prefixes with explicit genuine-summary provenance', async () => {
    const summary = user('Portable checkpoint');
    const tail = user('new prefix user');
    const raw = { ...payload(), input: [summary, tail] };
    const state = priorState();
    const f = fixture({ rawPayload: raw });
    const result = await callNativeCompaction({ registry: f.registry, model, context,
      priorPrefix: { state, identity, expectedSummaryItem: summary, summaryPresent: true },
    });
    assert.deepEqual(f.generated, { ...raw, store: false, input: [...state.replacementHistory, tail, { type: 'compaction_trigger' }] });
    assert.deepEqual(result.replacementHistory, [user('retained prior user'), tail, artifact]);
    assert.deepEqual(state, priorState());
  });

  it('keeps portable input on absent provenance, a surviving quote, missing/ambiguous slot or incompatibility', async () => {
    const summary = user('Portable checkpoint');
    for (const scenario of [
      { input: [summary], witness: undefined, compatible: true },
      // The real checkpoint was removed; only an identical tail user quote remains.
      { input: [summary], witness: false, compatible: true },
      { input: [summary, summary], witness: true, compatible: true },
      { input: [user('no checkpoint slot')], witness: true, compatible: true },
      { input: [summary], witness: true, compatible: false },
    ]) {
      const raw = { ...payload(), input: scenario.input };
      const f = fixture({ rawPayload: raw });
      await callNativeCompaction({ registry: f.registry, model, context, priorPrefix: {
        state: priorState(), identity: { ...identity, modelId: scenario.compatible ? identity.modelId : 'other-model' },
        expectedSummaryItem: summary, summaryPresent: scenario.witness,
      } });
      assert.deepEqual(f.generated, { ...raw, store: false, input: [...raw.input, { type: 'compaction_trigger' }] });
    }
  });

  it('rejects raw incomplete/done/error, EOF, duplicate output, and normalized failure after draining', async () => {
    for (const [events, code] of [
      [[], 'missing-completion'],
      [[{ type: 'response.incomplete' }], 'incomplete'],
      [[{ type: 'response.done' }], 'incomplete'],
      [[{ type: 'error', message: 'provider-secret ciphertext-secret' }], 'stream-failed'],
      [[{ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [artifact, artifact] } }], 'multiple-artifacts'],
    ] as const) {
      const f = fixture({ events: [...events] });
      await rejectCall({ registry: f.registry, model, context }, code);
      assert.equal(f.drained, true);
    }
    for (const stopReason of ['error', 'length', 'toolUse', 'aborted']) {
      const f = fixture({ stopReason });
      await rejectCall({ registry: f.registry, model, context }, stopReason === 'aborted' ? 'aborted' : 'normalized-failed');
      assert.equal(f.drained, true);
    }
    const f = fixture({ throwAfter: true });
    await rejectCall({ registry: f.registry, model, context }, 'stream-failed');
  });

  it('distinguishes cancellation before registry use and during an injected pending stream', async () => {
    const preabort = new AbortController();
    preabort.abort('provider-secret');
    const f = fixture();
    await rejectCall({ registry: f.registry, model, context, signal: preabort.signal }, 'aborted');
    assert.equal(f.calls, 0);
    const abort = new AbortController();
    const pending: NativeCompactionCallRegistry = {
      streamSimple(_model, _context, options) {
        return {
          async *[Symbol.asyncIterator]() {
            await options?.onPayload?.(payload(), model);
            abort.abort('provider-secret');
            yield {};
          },
          async result() { return { stopReason: 'stop' }; },
        };
      },
    };
    await rejectCall({ registry: pending, model, context, options: { signal: abort.signal } }, 'aborted');
  });

  it('enforces its overall timeout even if an injected stream ignores signal', async () => {
    const pending: NativeCompactionCallRegistry = {
      streamSimple() {
        return {
          async *[Symbol.asyncIterator]() { await new Promise(() => {}); yield {}; },
          async result() { return { stopReason: 'stop' }; },
        };
      },
    };
    // No wall-clock duration assertion; expiry is the behavior, not scheduler speed.
    await rejectCall({ registry: pending, model, context, timeoutMs: 1 }, 'timeout');
  });

  it('rejects mixed context_management/previous_response_id paths and forces streaming', async () => {
    for (const controls of [
      { context_management: [] }, { context_management: null },
      { context_management: [{ type: 'compaction', compact_threshold: 100 }] },
      { previous_response_id: 'resp_prior' }, { previous_response_id: null },
    ]) {
      const f = fixture({ rawPayload: { ...payload(), ...controls }, swallowCallbacks: true });
      await rejectCall({ registry: f.registry, model, context }, 'invalid-payload');
    }
    const raw = { ...payload(), stream: false, context_management: undefined, previous_response_id: undefined };
    const f = fixture({ rawPayload: raw });
    await callNativeCompaction({ registry: f.registry, model, context });
    assert.deepEqual(f.generated, { ...payload(), store: false, stream: true,
      input: [...raw.input, { type: 'compaction_trigger' }],
    });
    assert.equal(raw.stream, false);
    const transformed = fixture();
    await rejectCall({ registry: transformed.registry, model, context, options: {
      onPayload: body => ({ ...(body as Record<string, unknown>), previous_response_id: 'resp_prior' }),
    } }, 'invalid-payload');
  });

  it('bounds the full final UTF-8 payload including the appended trigger', async () => {
    const raw = payload();
    const finalBytes = Buffer.byteLength(JSON.stringify({ ...raw, store: false, input: [...raw.input, { type: 'compaction_trigger' }] }), 'utf8');
    const f = fixture({ rawPayload: raw });
    await callNativeCompaction({ registry: f.registry, model, context, maxPayloadBytes: finalBytes });
    const small = fixture({ rawPayload: raw });
    await rejectCall({ registry: small.registry, model, context, maxPayloadBytes: finalBytes - 1 }, 'oversized');
    for (const timeoutMs of [0, -1, Infinity, NaN, 0.5]) {
      await rejectCall({ registry: fixture().registry, model, context, timeoutMs }, 'invalid-payload');
    }
  });

  it('validates unknown generated input and latches callback failures even when the provider swallows them', async () => {
    const bad = [
      {}, { input: 'not an array' }, { input: ['string item'] }, { input: [null] },
      { input: [{}] }, { input: [{ type: 'compaction_trigger' }] },
      { input: [user('text'), { type: 'message', future: { type: 'compaction_trigger' } }] },
      { input: [{ ...user('text'), authorization: 'provider-secret' }] },
      { input: [{ ...user('text'), future: Infinity }] },
    ];
    for (const rawPayload of bad) {
      const f = fixture({ rawPayload, swallowCallbacks: true });
      await rejectCall({ registry: f.registry, model, context }, 'invalid-payload');
    }
    const missing = fixture({ skipPayload: true });
    await rejectCall({ registry: missing.registry, model, context }, 'missing-payload');
    const f = fixture({ swallowCallbacks: true });
    await rejectCall({ registry: f.registry, model, context, options: {
      onPayload: () => { throw new Error('provider-secret ciphertext-secret'); },
    } }, 'stream-failed');
    // Codex's generated prompt_cache_key can be undefined before JSON serialization.
    const optional = fixture({ rawPayload: { ...payload(), prompt_cache_key: undefined } });
    await callNativeCompaction({ registry: optional.registry, model, context });
  });
});
