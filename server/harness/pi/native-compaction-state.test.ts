import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compatibleNative, latestNativeCompaction, NATIVE_RETAINED_MAX_BYTES, NATIVE_STATE_MAX_BYTES,
  parseNativeCompaction, replayNativePrefix, retainNativeUsers, type NativeCompactionState,
} from './native-compaction-state';

const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
function fixture(): NativeCompactionState {
  return {
    v: 1, protocol: 'codex-responses-v2', provider: 'openai-codex', api: 'openai-codex-responses',
    modelId: 'model/with:structured:id', endpointOrigin: 'https://chatgpt.com', accountFingerprint: 'a'.repeat(64),
    boundary: { kind: 'pi-old-prefix', firstKeptEntryId: 'kept' }, responseId: 'response',
    replacementHistory: [user('earlier user'), { type: 'compaction', id: 'opaque-id', encrypted_content: 'opaque', future: { preserved: true } }],
  };
}
test('native details are versioned, bounded JSON with a single complete final artifact', () => {
  const valid = fixture();
  assert.deepEqual(parseNativeCompaction(valid), valid);
  const invalid = [
    { ...valid, v: 2 }, { ...valid, protocol: 'unknown' }, { ...valid, provider: 'openai' },
    { ...valid, endpointOrigin: 'https://example.invalid' }, { ...valid, accountFingerprint: 'raw-account' },
    { ...valid, boundary: { kind: 'whole-window', firstKeptEntryId: 'kept' } },
    { ...valid, replacementHistory: [] },
    { ...valid, replacementHistory: [{ type: 'compaction', id: 'id', encrypted_content: '' }] },
    { ...valid, replacementHistory: [valid.replacementHistory[1], valid.replacementHistory[1]] },
    { ...valid, replacementHistory: [user('x'), { ...valid.replacementHistory[1], future: { type: 'compaction_trigger' } }] },
    { ...valid, replacementHistory: [user('x'.repeat(NATIVE_RETAINED_MAX_BYTES)), valid.replacementHistory[1]] },
    { ...valid, replacementHistory: [{ ...valid.replacementHistory[1], encrypted_content: 'x'.repeat(NATIVE_STATE_MAX_BYTES) }] },
    { ...valid, future: NaN }, { ...valid, future: undefined },
    { ...valid, replacementHistory: [{ ...valid.replacementHistory[1], authorization: 'not-durable' }] },
    { ...valid, replacementHistory: [{ ...valid.replacementHistory[1], future: { access_token: 'not-durable' } }] },
  ];
  for (const value of invalid) assert.equal(parseNativeCompaction(value), null);
  const cyclic = fixture() as NativeCompactionState & { cycle?: unknown };
  cyclic.cycle = cyclic;
  assert.equal(parseNativeCompaction(cyclic), null);
  let called = false;
  const accessor = { ...valid, get responseId() { called = true; return 'response'; } };
  assert.equal(parseNativeCompaction(accessor), null);
  assert.equal(called, false, 'validation must not execute accessors');
  const parsed = parseNativeCompaction(valid)!;
  parsed.replacementHistory[1]!.encrypted_content = 'changed';
  assert.equal(valid.replacementHistory[1]!.encrypted_content, 'opaque');
});
test('latest effective active checkpoint is authoritative, even if textual or malformed', () => {
  const checkpoint = { type: 'compaction', details: { sovaNativeCompaction: fixture() } };
  assert.deepEqual(latestNativeCompaction([checkpoint, { type: 'message' }]), fixture());
  assert.equal(latestNativeCompaction([checkpoint, { type: 'compaction', details: {} }]), null);
  assert.equal(latestNativeCompaction([checkpoint, { type: 'compaction', details: { sovaNativeCompaction: { v: 99 } } }]), null);
  assert.equal(latestNativeCompaction([{ type: 'message' }]), null); // rewind/fork before checkpoint
  assert.deepEqual(latestNativeCompaction([checkpoint]), fixture()); // rewind/fork after checkpoint
});
test('compatibility is exact per structured field, never a split model key', () => {
  const state = fixture();
  assert.equal(compatibleNative(state, state), true);
  for (const key of ['provider', 'api', 'modelId', 'endpointOrigin', 'accountFingerprint'] as const) {
    const identity = { ...state, [key]: 'different' } as unknown as typeof state;
    assert.equal(compatibleNative(state, identity), false);
  }
});
test('retention preserves chronological eligible user items and counts image/Unicode bytes', () => {
  const input = [user('old'), { type: 'function_call_output', output: 'tool' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'a'.repeat(NATIVE_RETAINED_MAX_BYTES) }] },
    ...Array.from({ length: 10 }, (_, i) => user(`recent-${i} 🦉`))];
  assert.deepEqual(retainNativeUsers(input), input.slice(-8));
  assert.deepEqual(retainNativeUsers([user('🦉'.repeat(NATIVE_RETAINED_MAX_BYTES / 3))]), []);
});
test('replay changes exactly one whole summary slot and leaves all canonical tail items untouched', () => {
  const summary = user('Readable native checkpoint heading\nreal portable summary');
  const tail = [user('current input'), { type: 'function_call_output', call_id: 'call', output: 'result' },
    user('hidden handoff note'), { role: 'assistant', content: [{ type: 'output_text', text: 'foreign-provider reply' }] }];
  const payload = { store: false, input: [summary, ...tail], tools: [{ type: 'function', name: 'tool' }] };
  const before = structuredClone(payload);
  const patched = replayNativePrefix(payload, summary, fixture(), { summaryPresent: true }) as typeof payload;
  assert.deepEqual(patched.input, [...fixture().replacementHistory, ...tail]);
  assert.equal(patched.tools, payload.tools);
  assert.deepEqual(payload, before);
  assert.equal(patched.input.at(-1), tail.at(-1));
  const collision = { ...payload, input: [summary, ...tail, structuredClone(summary)] };
  assert.equal(replayNativePrefix(collision, summary, fixture(), { summaryPresent: true }), collision);
  const absent = { ...payload, input: [user('prefix ' + summary.content[0]!.text), ...tail] };
  assert.equal(replayNativePrefix(absent, summary, fixture(), { summaryPresent: true }), absent);
  const changedShape = { ...payload, input: [{ ...summary, unexpected: true }, ...tail] };
  assert.equal(replayNativePrefix(changedShape, summary, fixture(), { summaryPresent: true }), changedShape);
  // A context transform removes the checkpoint, but a user quote happens to serialize identically.
  // Even one exact payload match cannot authorize replacing that current user input.
  const transformed = { ...payload, input: [summary] };
  assert.equal(replayNativePrefix(transformed, summary, fixture(), { summaryPresent: false }), transformed);
  assert.equal(replayNativePrefix(transformed, summary, fixture()), transformed);
});
