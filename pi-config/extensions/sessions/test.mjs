// Runs against the installed Pi packages without installing duplicate dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (!existsSync(join(root, 'package.json'))) {
  const next = dirname(root); if (next === root) throw new Error('Pi install not found'); root = next;
}
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { interopDefault: false, alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
} });
const { default: extension } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
for (const file of ['state.test.ts', 'focus.test.ts', 'workers.test.ts', 'ui.test.ts', 'presence.test.ts']) {
  await jiti.import(fileURLToPath(new URL(file, import.meta.url)));
}
const tick = () => new Promise(resolve => setTimeout(resolve, 180));
function harness() {
  const hooks = new Map(), events = new Map(), commands = new Map(), shortcuts = new Map();
  const sent = [], statuses = new Map(); let init;
  let connected = true;
  const bus = {
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name)?.delete(fn); },
    emit(name, value) { for (const fn of events.get(name) ?? []) fn(value); },
  };
  const pi = { events: bus, on(name, fn) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
    registerCommand(name, value) { commands.set(name, value); }, registerShortcut(name, value) { shortcuts.set(name, value); },
    getSessionName() { return 'self'; }, getModel() { return { id: 'test-model' }; } };
  const peer = { id: 'self', pid: process.pid, cwd: '/tmp/test', model: 'test', startedAt: 1, lastActivity: 1 };
  const channel = { namespace: 'pi-sessions/v1', snapshot: () => ({ connected, supported: true }), publish: value => sent.push(value),
    listSessions: async () => [peer], close() {} };
  extension(pi, { createChannel: options => { init = options; return channel; } });
  const ctx = { cwd: '/tmp/test', mode: 'rpc', isIdle: () => true,
    sessionManager: { getBranch: () => [] }, ui: { setStatus: (key, value) => statuses.set(key, value), notify() {} } };
  const emit = async (name, value = {}) => { for (const fn of hooks.get(name) ?? []) await fn(value, ctx); };
  return { pi, ctx, emit, sent, events, statuses, commands, shortcuts, channelEvent: event => init.onEvent(event),
    disconnect() { connected = false; init.onEvent({ type: 'connection', connected: false, supported: true }); },
    latest: () => sent.filter(s => s.type === 'presence').at(-1) };
}
test('extension registers keyboard commands and derives settled status independently of workers', async () => {
  const h = harness();
  try {
    await h.emit('session_start'); await tick();
    assert.ok(h.commands.has('sessions')); assert.ok(h.shortcuts.has('alt+s'));
    assert.equal(h.latest().status, 'Idle');
    await h.emit('agent_start'); await tick(); assert.equal(h.latest().status, 'Running');
    await h.emit('tool_execution_start', { toolCallId: 'a', toolName: 'bash' });
    await h.emit('tool_execution_start', { toolCallId: 'b', toolName: 'read' });
    await tick(); assert.match(h.latest().status, /bash, read/);
    await h.emit('tool_execution_end', { toolCallId: 'a' }); await tick(); assert.equal(h.latest().status, 'Running: read');
    await h.emit('ui_prompt_start'); await tick(); assert.equal(h.latest().status, 'Needs input');
    await h.emit('ui_prompt_end');
    await h.emit('agent_end'); await tick(); assert.match(h.latest().status, /^Running/);
    h.pi.events.emit('subagents:workers-snapshot', { version: 1, workers: [{ id: 'w', name: 'reviewer', status: 'running' }] });
    await h.emit('agent_settled'); await tick();
    assert.equal(h.latest().status, 'Idle'); assert.equal(h.latest().workers[0].status, 'running');
    assert.ok(h.latest().completed > 0);
    const parentCompletion = h.latest().completed;
    h.pi.events.emit('subagents:workers-snapshot', { version: 1, workers: [{ id: 'w', name: 'reviewer', status: 'waiting' }] });
    await tick();
    assert.equal(h.latest().status, 'Idle'); assert.ok(h.latest().completed > parentCompletion);
    h.ctx.mode = 'tui';
    h.disconnect(); assert.equal(h.statuses.get('sessions'), 'Sessions: disconnected');
  } finally { await h.emit('session_shutdown'); }
  const count = h.sent.length; await tick(); assert.equal(h.sent.length, count);
  assert.equal(h.statuses.get('sessions'), undefined);
});
test('outline snapshot enriches presence and drops cleanly', async () => {
  const h = harness();
  try {
    await h.emit('session_start'); await tick();
    h.pi.events.emit('topic-outline:snapshot', { now: 'Editing', state: 'fresh', generatedAt: Date.now(), topics: ['A'] });
    await tick();
    assert.equal(h.latest().outline?.now, 'Editing');
    assert.equal(h.latest().outline?.lastHeading, undefined);
    h.pi.events.emit('topic-outline:snapshot', { now: 'Editing', lastHeading: 'Auth fix' });
    await h.emit('agent_settled'); await tick();
    assert.equal(h.latest().outline?.lastHeading, 'Auth fix');
    h.pi.events.emit('topic-outline:snapshot', { now: 42 });
    await tick();
    await h.emit('agent_settled'); await tick();
    assert.equal(h.latest().outline, undefined);
  } finally { await h.emit('session_shutdown'); }
  const count = h.sent.length; await tick(); assert.equal(h.sent.length, count);
});

test('presence shares bounded assistant text, never thinking or full tool results', async () => {
  const h = harness();
  try {
    await h.emit('session_start');
    await h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [
      { type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: '文'.repeat(4000) },
    ] } });
    h.pi.events.emit('subagents:workers-snapshot', { version: 1, workers: Array.from({ length: 60 }, (_, i) => ({
      id: String(i), name: '文'.repeat(200), status: 'running', preview: '文'.repeat(400),
    })) });
    await tick();
    assert.ok(Buffer.byteLength(JSON.stringify(h.latest())) <= 12_000);
    assert.ok(h.latest().preview.length <= 2000);
    assert.ok(!JSON.stringify(h.latest()).includes('PRIVATE'));
  } finally { await h.emit('session_shutdown'); }
});

test('local presence: connects and publishes immediately, no registry handshake', async () => {
  const h = harness();
  h.ctx.mode = 'tui';
  try {
    await h.emit('session_start'); await tick();
    assert.equal(h.latest().status, 'Idle', 'published presence without any intercom registry');
    assert.match(h.statuses.get('sessions'), /^Sessions: 1/, 'footer counts the local roster');
    assert.ok(!h.events.has('intercom:extension-register') && !h.events.has('intercom:extension-registry-ready'),
      'no intercom registry events are subscribed anymore');
    await h.commands.get('sessions').handler('', h.ctx);
  } finally { await h.emit('session_shutdown'); }
  const count = h.sent.length; await tick(); assert.equal(h.sent.length, count);
  assert.equal(h.statuses.get('sessions'), undefined);
});
