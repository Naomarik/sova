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
for (const file of ['state.test.ts', 'focus.test.ts', 'workers.test.ts', 'presence.test.ts', 'schema.test.ts', 'feed.test.ts', 'render.test.ts', 'ui.test.ts', 'cli.test.ts']) {
  await jiti.import(fileURLToPath(new URL(file, import.meta.url)));
}
const tick = () => new Promise(resolve => setTimeout(resolve, 180));
function harness() {
  const hooks = new Map(), events = new Map(), commands = new Map(), shortcuts = new Map();
  const sent = [], statuses = new Map(), widgets = new Map(); let init;
  let connected = true;
  const bus = {
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name)?.delete(fn); },
    emit(name, value) { for (const fn of events.get(name) ?? []) fn(value); },
  };
  const pi = { events: bus, on(name, fn) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
    registerCommand(name, value) { commands.set(name, value); }, registerShortcut(name, value) { shortcuts.set(name, value); },
    getSessionName() { return 'self'; } };
  // Fake channel speaks presence.ts's SessionMeta roster.
  const peer = { id: 'self', pid: process.pid, cwd: '/tmp/test', model: 'test', startedAt: 1, lastActivity: 1 };
  const channel = { namespace: 'pi-sessions/v1', snapshot: () => ({ connected, supported: true }), publish: value => sent.push(value),
    listSessions: async () => [peer], close() {} };
  extension(pi, { configPath: '/nonexistent/sessions.json', createChannel: options => { init = options; return channel; } });
  const ctx = { cwd: '/tmp/test', mode: 'rpc', isIdle: () => true, model: { id: 'test-model' },
    sessionManager: { getBranch: () => [], getSessionId: () => 'uuid-1', getSessionFile: () => '/tmp/s.jsonl' },
    ui: { setStatus: (key, value) => statuses.set(key, value), setWidget: (key, value) => widgets.set(key, value), notify() {} } };
  const emit = async (name, value = {}) => { for (const fn of hooks.get(name) ?? []) await fn(value, ctx); };
  return { pi, ctx, emit, sent, events, statuses, widgets, commands, shortcuts, info: () => init.info(), options: () => init,
    channelEvent: event => init.onEvent(event),
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
    // The whole record the channel writes (session meta + envelope) stays within the default budget.
    const record = { v: 1, schemaVersion: 2, session: { ...h.info(), id: 'p1-00000000', endpointEpoch: '0'.repeat(36) },
      presence: h.latest(), heartbeat: Date.now() };
    assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 16_384);
    assert.equal(h.options().budgetBytes, 16_384);
    assert.equal(h.latest().workerCounts.total, 60, 'counts stay truthful after truncation');
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
    assert.equal(h.statuses.get('sessions'), '⧉ 1', 'footer counts the local roster');
    assert.ok(!h.events.has('intercom:extension-register') && !h.events.has('intercom:extension-registry-ready'),
      'no intercom registry events are subscribed anymore');
    await h.commands.get('sessions').handler('', h.ctx);
  } finally { await h.emit('session_shutdown'); }
  const count = h.sent.length; await tick(); assert.equal(h.sent.length, count);
  assert.equal(h.statuses.get('sessions'), undefined);
});

test('v2 pipeline: activity, basename-only tool detail, turns and buckets', async () => {
  const h = harness();
  try {
    await h.emit('session_start'); await tick();
    assert.equal(h.latest().activity.state, 'idle');
    const meta = h.info();
    assert.equal(meta.sessionId, 'uuid-1'); assert.equal(meta.sessionFile, '/tmp/s.jsonl'); assert.equal(meta.mode, 'rpc');
    assert.equal(meta.model, 'test-model', 'model comes from the session ctx');
    await h.emit('model_select', { model: { id: 'opus[1m]' } });
    assert.equal(h.info().model, 'opus[1m]', 'model_select updates published metadata');
    assert.equal(typeof meta.host, 'string');
    await h.emit('agent_start');
    await h.emit('tool_execution_start', { toolCallId: 'r', toolName: 'read', args: { path: '/home/me/secret/src/auth.ts' } });
    await h.emit('tool_execution_start', { toolCallId: 'b', toolName: 'bash', args: { command: 'echo SECRET' } });
    await tick();
    let p = h.latest();
    assert.equal(p.activity.state, 'working');
    assert.deepEqual(p.activity.tools, ['read', 'bash']);
    assert.equal(p.activity.toolDetail, 'read · auth.ts');
    assert.ok(!JSON.stringify(p).includes('SECRET') && !JSON.stringify(p).includes('/home/me'), 'never commands or full paths');
    assert.equal(p.status, 'Running: read, bash', 'legacy v1 status unchanged');
    await h.emit('tool_execution_end', { toolCallId: 'b' }); await tick();
    assert.deepEqual(h.latest().activity.tools, ['read']);
    assert.equal(h.latest().activity.toolDetail, 'read · auth.ts');
    await h.emit('tool_execution_end', { toolCallId: 'r' }); await tick();
    assert.equal(h.latest().activity.toolDetail, undefined, 'detail clears when no tools run');
    await h.emit('agent_settled'); await tick();
    p = h.latest();
    assert.equal(p.activity.state, 'idle'); assert.equal(p.activity.turns, 1);
    assert.equal(p.activity.buckets.length, 16); assert.equal(p.activity.bucketMs, 15000);
    // Two completions land in the current bucket (or the previous one if a 15s boundary was just crossed).
    assert.ok(p.activity.buckets.at(-1) >= 1 || p.activity.buckets.at(-2) >= 1);
    assert.equal(p.activity.buckets.reduce((a, b) => a + b, 0), 2);
    await h.emit('ui_prompt_start', { kind: 'confirm' }); await tick();
    assert.equal(h.latest().activity.state, 'needs-input'); assert.equal(h.latest().status, 'Needs input');
    assert.ok(h.latest().activity.lastPromptAt > 0);
    await h.emit('ui_prompt_end'); await h.emit('agent_start');
    await h.emit('message_end', { message: { role: 'assistant', stopReason: 'error', errorMessage: 'E'.repeat(500), content: [] } });
    await h.emit('agent_settled'); await tick();
    p = h.latest();
    assert.equal(p.activity.state, 'error'); assert.equal(p.status, 'Error');
    assert.equal(p.activity.error.length, 200); assert.equal(p.activity.turns, 2);
    assert.ok(p.activity.lastAssistantAt > 0 && p.previewAt > 0);
  } finally { await h.emit('session_shutdown'); }
});

test('status glyphs, attention widget and recents-driven back', async () => {
  const h = harness();
  h.ctx.mode = 'tui';
  const notes = []; h.ctx.ui.notify = (msg, level) => notes.push([msg, level]);
  try {
    await h.emit('session_start'); await tick();
    const other = { id: 'other', name: 'api-tests', pid: 424242, cwd: '/tmp/o', model: 'm', startedAt: 1, lastActivity: 1 };
    h.channelEvent({ type: 'session_joined', session: other });
    const base = { type: 'presence', version: 1, status: 'Needs input', since: 1, completed: 0, preview: 'p',
      workers: [{ id: 'w', name: 'x', status: 'running' }] };
    h.channelEvent({ type: 'message', fromSessionId: 'other', payload: { ...base, activity: { state: 'needs-input', since: 1 } }, heartbeat: Date.now() });
    assert.equal(h.statuses.get('sessions'), '⧉ 2 · ⚑1 ◆1');
    assert.deepEqual(h.widgets.get('sessions-attention'), ['⚑ api-tests needs input']);
    h.channelEvent({ type: 'message', fromSessionId: 'other', payload: { ...base, status: 'Idle', workers: [] }, heartbeat: Date.now() });
    assert.equal(h.statuses.get('sessions'), '⧉ 2');
    assert.equal(h.widgets.get('sessions-attention'), undefined, 'widget cleared via setWidget(key, undefined)');
    assert.ok(h.widgets.has('sessions-attention'));
    await h.commands.get('sessions-back').handler('', h.ctx);
    assert.match(notes.at(-1)[0], /No previous session yet/);
    h.channelEvent({ type: 'message', fromSessionId: 'other', payload: { type: 'visited', to: 'self', from: 'other' } });
    await h.commands.get('sessions-back').handler('', h.ctx);
    assert.match(notes.at(-1)[0], /^Sessions: No safe focus target/, 'back cycles recents through the unchanged focus gate');
  } finally { await h.emit('session_shutdown'); }
});
