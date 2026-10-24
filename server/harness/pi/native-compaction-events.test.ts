import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createNativeCompactionEventCollector, NativeCompactionEventError,
  validateNativeCompactionEvents, type NativeCompactionEventFailure,
} from './native-compaction-events';

const item = () => ({ type: 'compaction', id: 'cmp_test', encrypted_content: 'opaque-secret-雪', future: { version: 7 } });
const done = (value: unknown = item(), output_index = 0) => ({ type: 'response.output_item.done', output_index, item: value });
const complete = (output: unknown = [item()], extra: Record<string, unknown> = {}) => {
  const response: Record<string, unknown> = { id: 'resp_test', status: 'completed', output, ...extra };
  for (const key of Object.keys(response)) if (response[key] === undefined) delete response[key];
  return { type: 'response.completed', response };
};
function rejects(events: unknown[], code?: NativeCompactionEventFailure) {
  assert.throws(() => validateNativeCompactionEvents(events), error => {
    assert.ok(error instanceof NativeCompactionEventError);
    if (code) assert.equal(error.code, code);
    assert.equal(error.message, `Native compaction rejected: ${error.code}`);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes('opaque-secret'));
    assert.ok(!String(error.stack).includes('provider-secret'));
    return true;
  });
}

describe('raw native compaction events', () => {
  it('accepts one final artifact, preserving every forward field and detaching input/output', () => {
    const source = item();
    const collector = createNativeCompactionEventCollector();
    collector.push(complete([source]));
    source.encrypted_content = 'mutated';
    const result = collector.finish();
    assert.deepEqual(result, { responseId: 'resp_test', item: item() });
    Object.assign(result.item, { future: null });
    assert.deepEqual(collector.finish().item, item());
  });

  it('reconciles output_item.done and completed.output without double counting', () => {
    assert.deepEqual(validateNativeCompactionEvents([done(), complete()]).item, item());
    // Object property order is not an artifact conflict.
    const reversed = { future: { version: 7 }, encrypted_content: 'opaque-secret-雪', id: 'cmp_test', type: 'compaction' };
    assert.deepEqual(validateNativeCompactionEvents([done(), complete([reversed])]).item, item());
    assert.deepEqual(validateNativeCompactionEvents([done(), done(), complete()]).item, item());
  });

  it('accepts done-only artifact representation only with an actual successful raw completion', () => {
    const event = { type: 'response.completed', response: { id: 'resp_test', status: 'completed' } };
    assert.deepEqual(validateNativeCompactionEvents([done(), event]).item, item());
    rejects([done()], 'missing-completion');
    const eof = createNativeCompactionEventCollector();
    eof.push(done());
    assert.throws(() => eof.finish(), { code: 'missing-completion' });
    eof.push(event);
    assert.throws(() => eof.finish(), { code: 'missing-completion' });
    rejects([event], 'invalid-artifact');
    rejects([done(), complete([])], 'invalid-artifact');
  });

  it('rejects two artifacts even identical entries or conflicting item identities', () => {
    rejects([complete([item(), item()])], 'multiple-artifacts');
    rejects([done(), done(item(), 1), complete()], 'multiple-artifacts');
    rejects([done(), done({ ...item(), id: 'cmp_other' })], 'multiple-artifacts');
    rejects([done(), { type: 'response.output_item.done', item: item() }], 'multiple-artifacts');
    rejects([done(), complete([{ ...item(), id: 'cmp_other' }])], 'conflicting-artifact');
    rejects([done(), complete([{ ...item(), encrypted_content: 'different' }])], 'conflicting-artifact');
    rejects([done(), complete([{ ...item(), future: { version: 8 } }])], 'conflicting-artifact');
    rejects([done(), done({ ...item(), future: null })], 'conflicting-artifact');
  });

  it('rejects duplicate artifacts in terminal output regardless of id, position, or content equality', () => {
    const unrelated = { type: 'message', id: 'msg_test', content: [] };
    for (const second of [item(), { ...item(), id: 'cmp_other' }, { ...item(), encrypted_content: 'different' }]) {
      rejects([complete([item(), unrelated, second])], 'multiple-artifacts');
      rejects([done(), complete([item(), unrelated, second])], 'multiple-artifacts');
    }
  });

  it('checks final output index alignment but leaves unrelated output alone', () => {
    const message = { type: 'message', id: 'msg_test', content: [] };
    assert.deepEqual(validateNativeCompactionEvents([done(item(), 1), complete([message, item()])]).item, item());
    rejects([done(item(), 1), complete()], 'conflicting-artifact');
    rejects([done(item(), -1)], 'invalid-event');
    rejects([{ type: 'response.output_item.done', item: null }], 'invalid-event');
  });

  it('does not mistake added, delta, normalized stop, done or incomplete for completed', () => {
    rejects([{ type: 'response.output_item.added', item: item() }], 'missing-completion');
    rejects([{ type: 'done', stopReason: 'stop', item: item() }], 'missing-completion');
    for (const type of ['response.done', 'response.incomplete', 'response.cancelled']) {
      rejects([done(), { type, response: { status: 'completed', id: 'resp_test', output: [item()] } }], 'incomplete');
    }
    for (const status of [undefined, 'incomplete', 'failed', 'in_progress', 'cancelled']) {
      rejects([done(), complete([item()], { status })], 'invalid-completion');
    }
    for (const id of [undefined, '', '   ', 12]) rejects([complete([item()], { id })], 'invalid-completion');
  });

  it('latches failure before or after completion and never exposes raw provider errors', () => {
    const error = { type: 'error', message: 'provider-secret opaque-secret-雪' };
    rejects([error, complete()], 'stream-failed');
    rejects([complete(), error], 'stream-failed');
    rejects([{ type: 'response.failed', response: { error: { message: 'provider-secret' } } }], 'stream-failed');
    rejects([complete([item()], { error: { message: 'provider-secret' } })], 'invalid-completion');
    rejects([complete([item()], { incomplete_details: { reason: 'provider-secret' } })], 'invalid-completion');
    rejects([complete(), complete()], 'invalid-completion');
    rejects([complete(), done()], 'invalid-completion');
    const collector = createNativeCompactionEventCollector();
    collector.push(complete());
    collector.reject();
    assert.throws(() => collector.finish(), { code: 'stream-failed' });
    const broken = { *[Symbol.iterator]() { yield complete(); throw new Error('provider-secret'); } };
    assert.throws(() => validateNativeCompactionEvents(broken), { code: 'stream-failed' });
  });

  it('rejects terminal error/incomplete details even alongside completed status and a valid artifact', () => {
    for (const extra of [
      { error: { code: 'server_error', message: 'provider-secret' } },
      { incomplete_details: { reason: 'max_output_tokens' } },
      { incomplete_details: { reason: 'content_filter', text: 'provider-secret' } },
    ]) {
      rejects([complete([item()], extra)], 'invalid-completion');
      rejects([done(), complete([item()], extra)], 'invalid-completion');
    }
    rejects([done(), { type: 'response.incomplete', response: {
      id: 'resp_test', status: 'incomplete', output: [item()], incomplete_details: { reason: 'max_output_tokens' },
    } }], 'incomplete');
    rejects([done(), { type: 'response.failed', response: {
      id: 'resp_test', status: 'failed', output: [item()], error: { message: 'provider-secret' },
    } }], 'stream-failed');
    assert.deepEqual(validateNativeCompactionEvents([
      done(), complete([item()], { error: null, incomplete_details: null }),
    ]).item, item());
  });

  it('requires complete id and nonempty ciphertext; rejects controls and credentials in forward fields', () => {
    for (const bad of [
      { ...item(), id: '' }, { ...item(), id: ' ' }, { ...item(), encrypted_content: '' },
      { ...item(), encrypted_content: '  ' }, { ...item(), encrypted_content: 42 },
      { ...item(), status: 'in_progress' }, { ...item(), status: 'incomplete' },
      { ...item(), future: { type: 'compaction_trigger' } },
      { ...item(), future: { Authorization: 'provider-secret' } },
    ]) rejects([complete([bad])], 'invalid-artifact');
    assert.deepEqual(validateNativeCompactionEvents([complete([{ ...item(), status: 'completed' }])]).item.status, 'completed');
    rejects([complete([{ type: 'compaction_trigger' }, item()])], 'invalid-artifact');
    rejects([done({ type: 'compaction_trigger' })], 'invalid-artifact');
    rejects([{ type: 'response.output_item.added', output_index: 0, item: { type: 'compaction_trigger' } },
      complete([item()])], 'invalid-artifact');
    rejects([{ type: 'compaction_trigger' }, complete([item()])], 'invalid-artifact');
    rejects([complete([{ type: 'context_compaction', id: 'cmp_test', encrypted_content: 'secret' }])], 'invalid-artifact');
    rejects([complete(null)], 'invalid-completion');
  });

  it('rejects abort before collection, after completion, or after a transport failure', () => {
    const abort = new AbortController();
    const collector = createNativeCompactionEventCollector({ signal: abort.signal });
    collector.push(complete());
    abort.abort('provider-secret');
    assert.throws(() => collector.finish(), { code: 'aborted' });
    collector.reject();
    assert.throws(() => collector.finish(), { code: 'aborted' });
    assert.throws(() => validateNativeCompactionEvents([complete()], { signal: abort.signal }), { code: 'aborted' });
  });

  it('bounds events, artifact size and total UTF-8 bytes, including ignored deltas', () => {
    const event = complete();
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    assert.deepEqual(validateNativeCompactionEvents([event], { maxBytes: bytes }).item, item());
    assert.throws(() => validateNativeCompactionEvents([event], { maxBytes: bytes - 1 }), { code: 'oversized' });
    const artifactBytes = Buffer.byteLength(JSON.stringify(item()), 'utf8');
    assert.deepEqual(validateNativeCompactionEvents([event], { maxArtifactBytes: artifactBytes }).item, item());
    assert.throws(() => validateNativeCompactionEvents([event], { maxArtifactBytes: artifactBytes - 1 }), { code: 'oversized' });
    assert.throws(() => validateNativeCompactionEvents([done(), event], { maxEvents: 1 }), { code: 'oversized' });
    let pulled = 0;
    const endless = { *[Symbol.iterator]() { while (true) { pulled++; yield { type: 'response.created' }; } } };
    assert.throws(() => validateNativeCompactionEvents(endless, { maxEvents: 2 }), { code: 'oversized' });
    assert.equal(pulled, 3);
    assert.throws(() => validateNativeCompactionEvents([
      { type: 'response.output_text.delta', delta: '雪'.repeat(100) }, event,
    ], { maxBytes: bytes }), { code: 'oversized' });
    for (const maxBytes of [0, -1, NaN, Infinity, 0.5]) {
      assert.throws(() => createNativeCompactionEventCollector({ maxBytes }), { code: 'invalid-event' });
    }
  });

  it('rejects malformed non-JSON, cyclic, accessor and nonfinite forward fields without invoking getters', () => {
    const cycle: Record<string, unknown> = { type: 'compaction', id: 'cmp_test', encrypted_content: 'opaque' };
    cycle.future = cycle;
    for (const future of [NaN, Infinity, undefined, 1n, () => 0, new Date(), cycle]) {
      rejects([complete([{ ...item(), future }])], 'invalid-event');
    }
    let invoked = false;
    const accessor = { get type() { invoked = true; throw new Error('provider-secret'); } };
    rejects([accessor], 'invalid-event');
    assert.equal(invoked, false);
    let deep: unknown = null;
    for (let i = 0; i < 70; i++) deep = { child: deep };
    rejects([complete([{ ...item(), future: deep }])], 'invalid-event');
  });

  it('preserves finite native usage without counting cache or reasoning tokens twice', () => {
    const usage = {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 10 },
    };
    assert.deepEqual(validateNativeCompactionEvents([done(), complete([item()], { usage })]).usage, usage);
    assert.equal(validateNativeCompactionEvents([complete()]).usage, undefined);
    for (const bad of [
      {}, { ...usage, input_tokens: -1 }, { ...usage, output_tokens: '20' },
      { ...usage, total_tokens: -1 }, { ...usage, input_tokens_details: { cached_tokens: 101 } },
      { ...usage, output_tokens_details: { reasoning_tokens: 21 } },
      { ...usage, input_tokens_details: { cached_tokens: -1 } },
      { ...usage, future: { authorization: 'provider-secret' } },
    ]) rejects([complete([item()], { usage: bad })], 'invalid-usage');
    rejects([complete([item()], { usage: { ...usage, output_tokens: Infinity } })], 'invalid-event');
  });
});
