// Runs against the installed Pi packages without installing duplicate dependencies.
// Mirrors the sessions extension harness: jiti aliases pi packages, node:test suites.
import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (!existsSync(join(root, 'package.json'))) {
  const next = dirname(root);
  if (next === root) throw new Error('Pi install not found');
  root = next;
}
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const jiti = createJiti(import.meta.url, { interopDefault: false, alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-tui': require.resolve('@earendil-works/pi-tui'),
} });

// Extension must at least load and register its public surface.
const { default: extension } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

test('topic-outline extension loads and registers command, shortcut, and events', () => {
  const commands = new Map(), shortcuts = new Map(), hooks = new Map(), flags = new Map();
  const bus = {
    on(name, fn) { if (!bus.map.has(name)) bus.map.set(name, new Set()); bus.map.get(name).add(fn); return () => bus.map.get(name)?.delete(fn); },
    emit(name, value) { for (const fn of bus.map.get(name) ?? []) fn(value); },
    map: new Map(),
  };
  const pi = {
    events: bus,
    on(name, fn) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); },
    registerCommand(name, value) { commands.set(name, value); },
    registerShortcut(name, value) { shortcuts.set(name, value); },
    registerFlag(name, value) { flags.set(name, value); },
    getFlag() { return undefined; },
    appendEntry() {},
  };
  extension(pi);
  assert.ok(commands.has('outline'), 'registers /outline');
  assert.ok(shortcuts.has('alt+o'), 'registers Alt+O');
  assert.equal(flags.get('topic-outline-headless')?.type, 'boolean', 'registers the boolean headless flag');
  for (const event of ['session_start', 'session_shutdown', 'session_tree', 'agent_start', 'agent_settled',
    'tool_execution_start', 'tool_execution_end', 'ui_prompt_start', 'ui_prompt_end', 'message_end']) {
    assert.ok(hooks.has(event), `subscribes to ${event}`);
  }
  // Request listener exists; emitting with no runtime must not throw.
  pi.events.emit('topic-outline:request', {});
});

await jiti.import(fileURLToPath(new URL('./outline.test.ts', import.meta.url)));
await jiti.import(fileURLToPath(new URL('./policy-gate.test.ts', import.meta.url)));

const { transcriptTests } = await import('./transcript.test.mjs');
await transcriptTests({ root, jiti, test, assert });
