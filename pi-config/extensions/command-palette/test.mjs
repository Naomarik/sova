import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs, { realpathSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Set before importing Pi or the extension: even the dispatch tests must never
// load or save the user's real favorites when production starts using a store.
const sandbox = mkdtempSync(join(tmpdir(), 'pi-palette-tests-'));
const previousEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = sandbox;
process.env.PI_CODING_AGENT_DIR = join(sandbox, '.pi', 'agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

// Resolve against the installed Pi, just like Pi's extension loader. No npm install.
let root = dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()));
while (!existsSync(join(root, 'package.json'))) {
  const parent = dirname(root);
  if (root === parent) throw new Error('Cannot locate installed Pi');
  root = parent;
}
const require = createRequire(join(root, 'package.json'));
const { createJiti } = require('jiti');
const tuiPath = require.resolve('@earendil-works/pi-tui');
const jiti = createJiti(import.meta.url, { interopDefault: false, alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-tui': tuiPath,
  '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
} });
const { Palette, searchItems } = await jiti.import(fileURLToPath(new URL('./menu.ts', import.meta.url)));
const { default: extension, modelItems } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
const contracts = await jiti.import(fileURLToPath(new URL('./contracts.ts', import.meta.url)));
const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } = await import(tuiPath);
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
const theme = { fg: (_, s) => s, bg: (_, s) => s, bold: s => s };
const leaf = { id: 'rename', label: 'Rename session', run() {} };
const items = [{ id: 'sessions', label: 'Sessions', children: [leaf] },
  { id: 'models', label: 'Models', children: [{ id: 'model', label: 'Switch model', run() {} }] }];
function menu() {
  let result = null;
  const p = new Palette(items, theme, keys, () => {}, () => 30, value => { result = value; });
  return { p, result: () => result };
}
test('fuzzy search includes descendant commands and ancestry', () => {
  assert.equal(searchItems(items, 'rnmsess')[0].item.id, 'rename');
  assert.equal(searchItems(items, 'switch model')[0].path, 'Models');
  assert.deepEqual(searchItems(items, 'zzzzzz'), []);
  assert.equal(searchItems(items, '').length, 2);
});
test('literal model-name matches rank ahead of scattered provider/name letters', () => {
  const rows = ['opencode/muse-spark-1.2', 'opencode/claude-sonnet-5',
    'anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-6',
    'opencode/claude-opus-4-6', 'anthropic/claude-opus-4-5'].map(id => ({
      id, label: id, description: `${id.split('/')[0]} · ${id.split('/')[1]}`,
      favorite: { isFavorite: () => false, toggle() {} }, run() {},
    }));
  const category = { id: 'models', label: 'Models & thinking', modelGroup: true, children: rows };
  for (const nodes of [rows, [category]]) {
    for (const query of ['opus', 'oPuS', 'anthropic opus', 'opencode/opus']) {
      const expected = rows.filter(row => query.toLowerCase().split(/[\s/]+/).every(token => row.label.includes(token)));
      const results = searchItems(nodes, query);
      assert.deepEqual(new Set(results.slice(0, expected.length).map(match => match.item.id)),
        new Set(expected.map(row => row.id)), `literal matches first: ${query}`);
      assert.ok(results.length >= expected.length);
    }
  }
  // Use the real overlay input path at both root and model-category depth.
  for (const nested of [false, true]) {
    let chosen;
    const p = new Palette([category], theme, keys, () => {}, () => 30, item => { chosen = item; });
    if (nested) p.handleInput('\r');
    p.handleInput('\x01'); p.handleInput('opus');
    const text = stripVTControlCharacters(p.render(100).join('\n'));
    assert.match(text.split('\n').find(line => line.includes('→')), /claude-opus/);
    p.handleInput('\r');
    assert.ok(chosen.id.includes('claude-opus'));
  }
  assert.ok(searchItems([category], 'ops46').some(match => match.item.id.includes('claude-opus-4-6')),
    'fuzzy abbreviations still work when no literal match exists');
});
test('submenu selection, back navigation and close', () => {
  const { p, result } = menu();
  p.handleInput('\r');
  assert.match(p.render(80).join('\n'), /Commands › Sessions/);
  p.handleInput('\x1b');
  assert.equal(result(), null);
  p.handleInput('\x1b');
  assert.equal(result(), undefined);
});
test('root search executes a leaf without navigating category', () => {
  const { p, result } = menu();
  p.handleInput('rename'); p.handleInput('\r');
  assert.equal(result().id, 'rename');
});
test('no matches cannot execute; clearing query works', () => {
  const { p, result } = menu();
  p.handleInput('zzzzzz'); p.handleInput('\r');
  assert.equal(result(), null);
  p.handleInput('\x15'); p.handleInput('\r'); p.handleInput('\r');
  assert.equal(result().id, 'rename');
});
test('back restores parent filter; Ctrl+P closes at any depth', () => {
  const { p, result } = menu();
  p.handleInput('Sessions'); p.handleInput('\r'); p.handleInput('\x1b');
  assert.match(stripVTControlCharacters(p.render(80).join('\n')), /❯ Sessions/);
  p.handleInput('\x10'); assert.equal(result(), undefined);
});
test('render stays within terminal width, including unicode and resizing', () => {
  const { p } = menu();
  p.focused = true;
  p.handleInput('中文👩‍💻');
  for (const width of [1, 5, 6, 12, 30, 80, 160]) {
    for (const line of p.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});
function harness() {
  const events = new Map(); const commands = new Map(); const shortcuts = new Map();
  const sent = []; const notices = []; let draft = 'unfinished draft'; let picker;
  const listeners = new Map();
  const bus = {
    on(name, handler) {
      const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set);
      return () => set.delete(handler);
    },
    emit(name, data) { for (const handler of [...(listeners.get(name) ?? [])]) handler(data); },
  };
  const fakeEditor = { getText: () => draft, setText: text => { draft = text; },
    onSubmit: async text => { picker = text; draft = ''; } };
  const pi = { events: bus, on: (name, cb) => events.set(name, cb),
    registerCommand: (name, config) => commands.set(name, config),
    registerShortcut: (name, config) => shortcuts.set(name, config),
    getCommands: () => [{ name: 'agents', source: 'extension', description: 'Manage agents' }],
    sendUserMessage: (...args) => sent.push(args),
  };
  let target = 'All settings';
  const ctx = { mode: 'tui', isIdle: () => true, scopedModels: [],
    thinkingLevel: 'medium', modelRegistry: { getAvailable: () => [] }, ui: {
    getEditorComponent: () => () => fakeEditor,
    setEditorComponent: factory => factory({}, {}, keys),
    getEditorText: () => draft, getAllThemes: () => [],
    notify: (...args) => notices.push(args),
    custom: async factory => {
      let selected;
      const p = factory({ requestRender() {}, terminal: { rows: 32 } }, theme, keys, item => { selected = item; });
      p.handleInput(target); p.handleInput('\r');
      // Extensions have a confirmation submenu.
      if (!selected) p.handleInput('\r');
      return selected;
    },
  } };
  extension(pi); events.get('session_start')({}, ctx);
  return { ctx, events, bus, commands, shortcuts, sent, notices, fakeEditor,
    draft: () => draft, picker: () => picker, choose: text => { target = text; } };
}
test('built-in dispatch opens real UI without sending to model and restores draft', async () => {
  const h = harness();
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(h.picker(), '/settings');
  assert.equal(h.draft(), 'unfinished draft');
  assert.equal(h.sent.length, 0); assert.deepEqual(h.notices, []);
});
test('extension commands use explicit dispatch and preserve draft', async () => {
  const h = harness(); h.choose('/agents');
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.deepEqual(h.sent, [['/agents', { expandPromptTemplates: true, deliverAs: 'followUp' }]]);
  assert.equal(h.draft(), 'unfinished draft');
});
test('session-changing actions are blocked while busy', async () => {
  const h = harness(); h.choose('New session'); h.ctx.isIdle = () => false;
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(h.picker(), undefined); assert.equal(h.notices[0][1], 'warning');
});
test('picker-supplied text is not overwritten', async () => {
  const h = harness();
  h.fakeEditor.onSubmit = async () => { h.fakeEditor.setText('restored fork prompt'); };
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(h.draft(), 'restored fork prompt');
});
test('non-TUI invocation does not show UI or send messages', async () => {
  const h = harness(); h.ctx.mode = 'rpc';
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(h.picker(), undefined); assert.deepEqual(h.sent, []);
});

function modelHarness() {
  const calls = [];
  const reasoning = { id: 'reasoner', name: 'Reasoner', provider: 'test', reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } };
  const plain = { id: 'plain', name: 'Plain model', provider: 'test', reasoning: false, input: ['text'] };
  const ctx = { model: reasoning, thinkingLevel: 'high', scopedModels: [],
    modelRegistry: { getAvailable: () => [reasoning, plain] },
    ui: { notify: (...args) => calls.push(['notice', ...args]) } };
  const pi = { setModel: async model => { calls.push(['model', model.id]); return true; },
    setThinkingLevel: level => calls.push(['thinking', level]) };
  return { pi, ctx, calls, reasoning, plain };
}
test('model rows use exact supported levels, wrap, and apply only on Enter', async () => {
  const h = modelHarness();
  const rows = modelItems(h.pi, h.ctx);
  assert.match(rows[0].value(), /high/);
  rows[0].adjust(1); assert.match(rows[0].value(), /max/);
  rows[0].adjust(1); assert.match(rows[0].value(), /low/);
  rows[0].adjust(-1); assert.match(rows[0].value(), /max/);
  assert.deepEqual(h.calls, []);
  await rows[0].run();
  assert.deepEqual(h.calls, [['model', 'reasoner'], ['thinking', 'max']]);
});
test('model descriptions mark image input and stay quiet for text-only or unknown input', () => {
  const h = modelHarness();
  const seer = { id: 'seer', name: 'Seer', provider: 'test', reasoning: false, input: ['text', 'image'] };
  h.ctx.modelRegistry.getAvailable = () => [seer, h.plain, h.reasoning];
  const rows = modelItems(h.pi, h.ctx);
  assert.equal(rows[0].description, 'test · Seer · vision');
  assert.equal(rows[1].description, 'test · Plain model');
  assert.equal(rows[2].description, 'test · Reasoner');
});
test('non-reasoning models stay off and pending levels are independent per row', () => {
  const h = modelHarness(); const rows = modelItems(h.pi, h.ctx);
  rows[0].adjust(1); rows[1].adjust(1); rows[1].adjust(-1);
  assert.equal(rows[1].value(), '[off]'); assert.match(rows[0].value(), /max/);
  assert.deepEqual(h.calls, []);
});
test('scoped models and model-specific pinned thinking levels are honored', () => {
  const h = modelHarness(); h.ctx.model = undefined;
  h.ctx.scopedModels = [{ model: h.reasoning, thinkingLevel: 'low' }];
  const rows = modelItems(h.pi, h.ctx);
  assert.equal(rows.length, 1); assert.match(rows[0].value(), /low/);
});
test('unsupported initial levels are clamped using model capabilities', () => {
  const h = modelHarness(); h.ctx.thinkingLevel = 'medium';
  assert.match(modelItems(h.pi, h.ctx)[0].value(), /high/);
});
test('authentication failure never changes thinking', async () => {
  const h = modelHarness(); h.pi.setModel = async () => false;
  const row = modelItems(h.pi, h.ctx)[0]; row.adjust(1); await row.run();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'notice');
  assert.equal(h.calls[0][2], 'error');
});
test('empty catalog and models with no supported levels fail safely', async () => {
  const h = modelHarness(); h.ctx.modelRegistry.getAvailable = () => [];
  assert.deepEqual(modelItems(h.pi, h.ctx), []);
  h.reasoning.thinkingLevelMap = Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, null]));
  h.ctx.modelRegistry.getAvailable = () => [h.reasoning];
  const row = modelItems(h.pi, h.ctx)[0]; row.adjust(1); await row.run();
  assert.equal(row.value(), '[unavailable]'); assert.equal(h.calls[0][0], 'notice');
});
test('arrow adjustment survives filtering and navigation, cancellation applies nothing', () => {
  const h = modelHarness(); const rows = modelItems(h.pi, h.ctx); let result = null;
  const p = new Palette([{ id: 'models', label: 'Models & thinking', children: rows }],
    theme, keys, () => {}, () => 30, value => { result = value; });
  p.handleInput('\r'); p.handleInput('\x1b[C');
  assert.match(stripVTControlCharacters(p.render(80).join('\n')), /‹ max ›/);
  p.handleInput('\x1b[B'); p.handleInput('\x1b[C');
  p.handleInput('reasoner');
  assert.match(stripVTControlCharacters(p.render(80).join('\n')), /‹ max ›/);
  p.handleInput('\x1b[D'); assert.match(rows[0].value(), /high/);
  p.handleInput('\x10'); assert.equal(result, undefined); assert.deepEqual(h.calls, []);
  assert.match(modelItems(h.pi, h.ctx)[0].value(), /high/);
});
test('filtered model Enter returns the model with its chosen level', async () => {
  const h = modelHarness(); let selected;
  const p = new Palette(modelItems(h.pi, h.ctx), theme, keys, () => {}, () => 30, item => { selected = item; });
  p.handleInput('reasoner'); p.handleInput('\x1b[D'); p.handleInput('\r');
  await selected.run(); assert.deepEqual(h.calls, [['model', 'reasoner'], ['thinking', 'low']]);
});

// Import lazily so an absent/broken planned module fails its tests, rather than
// preventing the existing regression tests from running at all.
async function favoritesFixture(t) {
  const { ModelFavorites } = await jiti.import(fileURLToPath(new URL('./favorites.ts', import.meta.url)));
  assert.equal(typeof ModelFavorites, 'function', 'favorites.ts exports ModelFavorites');
  const dir = mkdtempSync(join(sandbox, 'favorites-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  return { ModelFavorites, dir, path, store: new ModelFavorites(path) };
}
const pair = ({ provider, id }) => ({ provider, id });
function assertDisk(path, models) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(document).sort(), ['models', 'version']);
  assert.equal(document.version, 1);
  // Order is not part of the store contract; duplicates and extra fields are.
  assert.deepEqual(document.models.map(model => JSON.stringify(model, Object.keys(model).sort())).sort(),
    models.map(model => JSON.stringify(pair(model), ['id', 'provider'])).sort());
}
function paletteFixture(nodes, height = () => 30) {
  const completed = [];
  const p = new Palette(nodes, theme, keys, () => {}, height, item => completed.push(item));
  return { p, completed };
}
function modelsCategory(rows) {
  return { id: 'models', label: 'Models & thinking', modelGroup: true, children: rows };
}
const screen = p => stripVTControlCharacters(p.render(180).join('\n'));
const modelLines = p => screen(p).split('\n').filter(line => /‹ (?:low|high|max) ›|\[off\]/.test(line));
function assertModelHints(p) {
  const text = screen(p);
  assert.match(text, /ctrl\+a/i);
  assert.match(text, /ctrl\+f/i);
  assert.match(text, /favorites?/i);
}
const input = { all: '\x01', favorite: '\x06', clear: '\x15', close: '\x10',
  enter: '\r', back: '\x1b', down: '\x1b[B', right: '\x1b[C' };

// Store contracts.
test('favorites: missing file is empty; exact provider/id pairs persist and reopen', async t => {
  const { store, path, ModelFavorites } = await favoritesFixture(t);
  const a = { provider: 'first', id: 'shared' };
  const b = { provider: 'second', id: 'shared' };
  const c = { provider: 'first', id: 'different' };
  assert.equal(store.has(a), false);
  assert.equal(existsSync(path), false, 'loading an absent file does not create one');
  assert.equal(store.set(a, true), undefined);
  assert.equal(store.has({ ...a }), true);
  assert.equal(store.has(b), false);
  assert.equal(store.has(c), false);
  assertDisk(path, [a]);
  const reopened = new ModelFavorites(path);
  assert.equal(reopened.has(a), true);
  assert.equal(reopened.has(b), false);
  reopened.set(b, true); reopened.set(c, true); reopened.set(a, false);
  assertDisk(path, [b, c]);
  const final = new ModelFavorites(path);
  assert.equal(final.has(a), false); assert.equal(final.has(b), true); assert.equal(final.has(c), true);
  final.set(b, true); final.set(a, false);
  assertDisk(path, [b, c]);
});
test('favorites: pair keys cannot collide when provider or id contains a slash', async t => {
  const { store, path } = await favoritesFixture(t);
  const a = { provider: 'one/two', id: 'three' };
  const b = { provider: 'one', id: 'two/three' };
  store.set(a, true);
  assert.equal(store.has(b), false);
  store.set(b, true); store.set(a, false);
  assert.equal(store.has(a), false); assert.equal(store.has(b), true);
  assertDisk(path, [b]);
});
test('favorites: stale writers merge latest additions and removals, not their cached snapshot', async t => {
  const { store: first, path, ModelFavorites } = await favoritesFixture(t);
  const second = new ModelFavorites(path);
  const a = { provider: 'a', id: 'shared' }, b = { provider: 'b', id: 'shared' };
  const c = { provider: 'a', id: 'other' };
  first.set(a, true); second.set(b, true);
  assertDisk(path, [a, b]);
  assert.equal(second.has(a), true, 'successful writer adopts the merged snapshot');
  const third = new ModelFavorites(path);
  first.set(a, false); third.set(c, true);
  assertDisk(path, [b, c]);
  second.set(b, false);
  assertDisk(path, [c]);
  assert.equal(second.has(a), false); assert.equal(second.has(c), true);
  // c was absent in first's cache, but must still be removed from latest disk.
  first.set(c, false);
  assertDisk(path, []);
});
test('favorites: writes replace the file atomically and remove their sidecar lock', async t => {
  const { store, path, dir } = await favoritesFixture(t);
  const a = { provider: 'test', id: 'first' }, b = { provider: 'test', id: 'second' };
  store.set(a, true);
  const before = readFileSync(path, 'utf8');
  const fd = openSync(path, 'r');
  try {
    store.set(b, true);
    assert.equal(readFileSync(fd, 'utf8'), before, 'an already-open reader retains the complete old file');
  } finally { closeSync(fd); }
  assertDisk(path, [a, b]);
  assert.deepEqual(readdirSync(dir), ['models.json'], 'no lock or temporary file left after save');
});
test('favorites: malformed JSON and strict schema errors throw without changing disk', async t => {
  const { path, ModelFavorites } = await favoritesFixture(t);
  const invalid = [
    ['broken JSON', '{'], ['null', 'null'], ['array', '[]'], ['missing fields', '{}'],
    ['missing models', '{"version":1}'], ['missing version', '{"models":[]}'],
    ['wrong version', '{"version":2,"models":[]}'], ['string version', '{"version":"1","models":[]}'],
    ['non-array models', '{"version":1,"models":{}}'],
    ['null model', '{"version":1,"models":[null]}'],
    ['missing provider', '{"version":1,"models":[{"id":"x"}]}'],
    ['missing id', '{"version":1,"models":[{"provider":"p"}]}'],
    ['non-string provider', '{"version":1,"models":[{"provider":1,"id":"x"}]}'],
    ['non-string id', '{"version":1,"models":[{"provider":"p","id":false}]}'],
    ['unknown top-level field', '{"version":1,"models":[],"extra":true}'],
    ['unknown model field', '{"version":1,"models":[{"provider":"p","id":"x","extra":true}]}'],
  ];
  for (const [name, contents] of invalid) await t.test(name, () => {
    writeFileSync(path, contents);
    assert.throws(() => new ModelFavorites(path));
    assert.equal(readFileSync(path, 'utf8'), contents);
    assert.equal(existsSync(`${path}.lock`), false);
  });
});
test('favorites: malformed latest disk blocks a stale writer without changing its memory', async t => {
  const { store, path, dir } = await favoritesFixture(t);
  const a = { provider: 'test', id: 'a' }, b = { provider: 'test', id: 'b' };
  store.set(a, true);
  for (const contents of ['{broken', '{"version":2,"models":[]}']) {
    writeFileSync(path, contents);
    assert.throws(() => store.set(b, true));
    assert.equal(store.has(a), true); assert.equal(store.has(b), false);
    assert.equal(readFileSync(path, 'utf8'), contents);
    assert.deepEqual(readdirSync(dir), ['models.json']);
  }
});
test('favorites: a directory at the file path is an I/O error, not an empty store', async t => {
  const { path, ModelFavorites } = await favoritesFixture(t);
  mkdirSync(path);
  assert.throws(() => new ModelFavorites(path));
});
test('favorites: lock contention is helpful, preserves memory/disk and does not steal the lock', async t => {
  const { store, path } = await favoritesFixture(t);
  const a = { provider: 'test', id: 'a' }, b = { provider: 'test', id: 'b' };
  store.set(a, true);
  const before = readFileSync(path, 'utf8');
  mkdirSync(`${path}.lock`);
  writeFileSync(join(`${path}.lock`, 'owner'), 'another writer');
  for (const [model, value] of [[b, true], [a, false]]) {
    assert.throws(() => store.set(model, value), /lock|busy|another.*writ/i);
    assert.equal(store.has(a), true); assert.equal(store.has(b), false);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(readFileSync(join(`${path}.lock`, 'owner'), 'utf8'), 'another writer');
  }
  rmSync(`${path}.lock`, { recursive: true });
  store.set(b, true);
  assertDisk(path, [a, b]);
});
test('favorites: failed atomic replacement does not report success or update memory', async t => {
  const { store, path, dir } = await favoritesFixture(t);
  const a = { provider: 'test', id: 'a' }, b = { provider: 'test', id: 'b' };
  store.set(a, true);
  const before = readFileSync(path, 'utf8');
  const rename = fs.renameSync;
  let attempts = 0;
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === path) {
      attempts++;
      assert.equal(fs.statSync(`${path}.lock`).isDirectory(), true, 'save holds the mkdir lock');
      throw Object.assign(new Error('simulated disk-full replacement failure'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => store.set(b, true), /simulated disk-full/);
    assert.throws(() => store.set(a, false), /simulated disk-full/);
    assert.equal(attempts, 2, 'both writes reached the injected replacement failure');
    assert.equal(store.has(a), true); assert.equal(store.has(b), false);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(readdirSync(dir), ['models.json'], 'failure cleans up its own lock and temp file');
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  store.set(b, true);
  assertDisk(path, [a, b]);
});

// Model rows and actual palette keyboard interaction (no private field access).
test('favorites: modelItems metadata is live and optional; provider/id pairs toggle independently', async t => {
  const { store, path } = await favoritesFixture(t);
  const h = modelHarness();
  const other = { ...h.reasoning, provider: 'other' };
  h.ctx.modelRegistry.getAvailable = () => [h.reasoning, other, h.plain];
  const rows = modelItems(h.pi, h.ctx, store);
  for (const row of rows) {
    assert.equal(typeof row.favorite?.isFavorite, 'function');
    assert.equal(typeof row.favorite?.toggle, 'function');
    assert.equal(row.favorite.isFavorite(), false);
  }
  store.set(h.reasoning, true);
  assert.equal(rows[0].favorite.isFavorite(), true, 'metadata reads the store, not an initial boolean');
  assert.equal(rows[1].favorite.isFavorite(), false);
  rows[1].favorite.toggle(); rows[0].favorite.toggle();
  assertDisk(path, [other]);
  assert.equal(rows[0].favorite.isFavorite(), false); assert.equal(rows[1].favorite.isFavorite(), true);
  assert.deepEqual(h.calls, []);
  const legacy = modelItems(h.pi, h.ctx);
  assert.ok(legacy.every(row => row.favorite === undefined));
  assert.equal(modelLines(paletteFixture(legacy).p).length, 3, 'legacy rows remain unfiltered');
});
test('favorites: long model IDs retain distinct provider prefixes at narrow widths', async t => {
  const { store } = await favoritesFixture(t);
  const h = modelHarness();
  const id = 'shared-model-with-a-very-long-name-'.repeat(4);
  const a = { ...h.reasoning, provider: 'alpha', id };
  const b = { ...h.reasoning, provider: 'bravo', id };
  h.ctx.modelRegistry.getAvailable = () => [a, b];
  const { p } = paletteFixture([modelsCategory(modelItems(h.pi, h.ctx, store))]);
  p.handleInput(input.enter); p.handleInput(input.all);
  for (const width of [80, 100]) {
    const text = stripVTControlCharacters(p.render(width).join('\n'));
    assert.match(text, /alpha\/shared-model/);
    assert.match(text, /bravo\/shared-model/);
    for (const line of p.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});
test('favorites: first-run Models is empty with discoverable Ctrl+A/F hints', async t => {
  const { store, path } = await favoritesFixture(t);
  const h = modelHarness();
  const { p, completed } = paletteFixture([modelsCategory(modelItems(h.pi, h.ctx, store))]);
  assert.match(screen(p), /ctrl\+a/i);
  p.handleInput(input.enter);
  assertModelHints(p);
  assert.equal(modelLines(p).length, 0);
  for (const key of [input.favorite, input.down, input.right, input.enter]) p.handleInput(key);
  assert.deepEqual(completed, []); assert.deepEqual(h.calls, []);
  assert.equal(existsSync(path), false);
  p.handleInput(input.all);
  assertModelHints(p);
  assert.equal(modelLines(p).length, 2);
  p.handleInput(input.all);
  assert.equal(modelLines(p).length, 0);
});
test('favorites: an empty catalog still has model-context hints and a working view toggle', () => {
  const { p, completed } = paletteFixture([modelsCategory([])]);
  p.handleInput(input.enter);
  assertModelHints(p);
  const favoritesView = screen(p);
  p.handleInput(input.all);
  assertModelHints(p);
  assert.notEqual(screen(p), favoritesView, 'empty view still indicates the changed mode');
  p.handleInput(input.all);
  assert.equal(screen(p), favoritesView);
  p.handleInput(input.favorite); p.handleInput(input.enter);
  assert.deepEqual(completed, []);
});
test('favorites: Ctrl+A at root discovers nested models; root and descendant search cannot leak nonfavorites', async t => {
  const { store } = await favoritesFixture(t);
  const h = modelHarness(); store.set(h.reasoning, true);
  const rows = modelItems(h.pi, h.ctx, store);
  const nodes = [{ id: 'catalog', label: 'Catalog', children: [modelsCategory(rows)] },
    { id: 'ordinary', label: 'Ordinary command', run() {} }];
  const { p, completed } = paletteFixture(nodes);
  assert.match(screen(p), /ctrl\+a/i);
  p.handleInput('plain');
  assert.equal(modelLines(p).length, 0);
  p.handleInput(input.enter); assert.deepEqual(completed, []);
  p.handleInput(input.all);
  assert.equal(modelLines(p).length, 1, 'root toggle finds the nested modelGroup');
  p.handleInput(input.all);
  assert.equal(modelLines(p).length, 0);
  p.handleInput(input.clear); p.handleInput('reasoner');
  assert.equal(modelLines(p).length, 1);
  p.handleInput(input.clear); p.handleInput(input.enter); // Unfiltered root: Catalog is first.
  assert.match(screen(p), /Commands › Catalog/);
  p.handleInput('plain');
  assert.equal(modelLines(p).length, 0, 'an intermediate category search is filtered too');
  p.handleInput(input.back); p.handleInput(input.clear); p.handleInput('Ordinary'); p.handleInput(input.enter);
  assert.equal(completed[0]?.id, 'ordinary', 'rows without favorite metadata remain executable');
});
test('favorites: Ctrl+F from root search saves immediately and cancellation does not undo it', async t => {
  const { store, path, ModelFavorites } = await favoritesFixture(t);
  const h = modelHarness(); const rows = modelItems(h.pi, h.ctx, store);
  const { p, completed } = paletteFixture([modelsCategory(rows)]);
  p.handleInput(input.all); p.handleInput('reasoner'); p.handleInput(input.right);
  p.handleInput(input.favorite);
  assert.equal(store.has(h.reasoning), true); assert.equal(store.has(h.plain), false);
  assertDisk(path, [h.reasoning]);
  assert.deepEqual(completed, []); assert.deepEqual(h.calls, []);
  assert.match(screen(p), /❯ reasoner/); assert.match(rows[0].value(), /max/);
  p.handleInput(input.close);
  assert.deepEqual(completed, [undefined]); assert.deepEqual(h.calls, []);
  assert.equal(new ModelFavorites(path).has(h.reasoning), true);
});
test('favorites: removing the last favorite leaves a safe empty view and can be reversed in Show all', async t => {
  const { store, path } = await favoritesFixture(t);
  const h = modelHarness(); store.set(h.reasoning, true);
  const { p, completed } = paletteFixture([modelsCategory(modelItems(h.pi, h.ctx, store))]);
  p.handleInput(input.enter); p.handleInput(input.favorite);
  assertDisk(path, []); assert.equal(modelLines(p).length, 0); assertModelHints(p);
  for (const key of [input.favorite, input.down, '\x1b[A', '\x1b[6~', input.right, input.enter]) {
    assert.doesNotThrow(() => { p.handleInput(key); p.render(80); });
  }
  assert.deepEqual(completed, []); assert.deepEqual(h.calls, []);
  p.handleInput(input.all); p.handleInput(input.favorite);
  assert.equal(store.has(h.reasoning), true);
  p.handleInput(input.all);
  assert.equal(modelLines(p).length, 1);
});
test('favorites: view toggles preserve highlighted identity rather than the old row index', async t => {
  const { store } = await favoritesFixture(t);
  const h = modelHarness(); store.set(h.plain, true);
  const rows = modelItems(h.pi, h.ctx, store);
  const { p, completed } = paletteFixture([modelsCategory(rows)]);
  p.handleInput(input.enter); // plain is index zero in Favorites, index one in Show all.
  p.handleInput(input.all); p.handleInput(input.all); p.handleInput(input.all);
  p.handleInput(input.enter);
  assert.equal(completed[0], rows[1]);
});
test('favorites: favorite toggles in Show all preserve selection, pending levels and search', async t => {
  const { store, path } = await favoritesFixture(t);
  const h = modelHarness();
  const other = { ...h.reasoning, provider: 'other' };
  h.ctx.modelRegistry.getAvailable = () => [h.reasoning, other, h.plain];
  const rows = modelItems(h.pi, h.ctx, store);
  // Fuzzy ranking may put the unchecked label ahead of the current-model label.
  // This test checks identity preservation, not a particular search ranking.
  const selectedRow = searchItems(rows, 'reasoner')[1].item;
  const selectedModel = [h.reasoning, other, h.plain][rows.indexOf(selectedRow)];
  const { p, completed } = paletteFixture([modelsCategory(rows)]);
  p.handleInput(input.enter); p.handleInput(input.all); p.handleInput('reasoner');
  p.handleInput(input.right); p.handleInput(input.down); p.handleInput(input.right);
  assert.match(rows[0].value(), /max/); assert.match(rows[1].value(), /max/);
  p.handleInput(input.favorite);
  assertDisk(path, [selectedModel]);
  p.handleInput(input.all); // The selected favorite survives filtering and remains highlighted.
  assert.equal(modelLines(p).length, 1);
  p.handleInput(input.all); p.handleInput(input.favorite); p.handleInput(input.favorite);
  assertDisk(path, [selectedModel]);
  assert.match(screen(p), /❯ reasoner/);
  assert.match(rows[0].value(), /max/); assert.match(rows[1].value(), /max/);
  p.handleInput(input.enter);
  assert.equal(completed[0], selectedRow); assert.deepEqual(h.calls, []);
});
test('favorites: parent search and pending thinking survive back navigation after toggles', async t => {
  const { store } = await favoritesFixture(t);
  const h = modelHarness(); const rows = modelItems(h.pi, h.ctx, store);
  const { p, completed } = paletteFixture([modelsCategory(rows), leaf]);
  p.handleInput('Models'); p.handleInput(input.enter); p.handleInput(input.all);
  p.handleInput('reasoner'); p.handleInput(input.right); p.handleInput(input.favorite);
  p.handleInput(input.all); p.handleInput(input.back);
  assert.match(screen(p), /❯ Models/);
  p.handleInput(input.enter); p.handleInput('reasoner');
  assert.match(rows[0].value(), /max/);
  assert.match(screen(p), /‹ max ›/);
  p.handleInput(input.enter);
  assert.equal(completed[0], rows[0]); assert.deepEqual(h.calls, []);
});
test('favorites: a new palette defaults to Favorites and resets pending thinking, not persisted favorites', async t => {
  const { store, path, ModelFavorites } = await favoritesFixture(t);
  const h = modelHarness(); store.set(h.reasoning, true);
  const firstRows = modelItems(h.pi, h.ctx, store);
  const first = paletteFixture([modelsCategory(firstRows)]);
  first.p.handleInput(input.enter); first.p.handleInput(input.all); first.p.handleInput(input.right);
  assert.equal(modelLines(first.p).length, 2); assert.match(firstRows[0].value(), /max/);
  first.p.handleInput(input.close);
  const nextRows = modelItems(h.pi, h.ctx, new ModelFavorites(path));
  const next = paletteFixture([modelsCategory(nextRows)]);
  next.p.handleInput(input.enter);
  assert.equal(modelLines(next.p).length, 1);
  assert.match(modelLines(next.p)[0], /reasoner/); assert.match(nextRows[0].value(), /high/);
  assert.deepEqual(h.calls, []);
});
test('favorites: locked save stays inline, leaves the selected favorite intact and permits retry', async t => {
  const { store, path } = await favoritesFixture(t);
  const h = modelHarness(); store.set(h.reasoning, true);
  const rows = modelItems(h.pi, h.ctx, store);
  const { p, completed } = paletteFixture([modelsCategory(rows)]);
  p.handleInput(input.enter); p.handleInput('reasoner'); p.handleInput(input.right);
  mkdirSync(`${path}.lock`);
  assert.doesNotThrow(() => p.handleInput(input.favorite));
  assert.match(screen(p), /lock|busy|another.*writ/i);
  assert.deepEqual(completed, []); assert.deepEqual(h.calls, []);
  assert.equal(rows[0].favorite.isFavorite(), true); assertDisk(path, [h.reasoning]);
  assert.match(screen(p), /❯ reasoner/); assert.match(rows[0].value(), /max/);
  rmSync(`${path}.lock`, { recursive: true });
  p.handleInput(input.favorite);
  assertDisk(path, []); assert.equal(modelLines(p).length, 0);
  p.handleInput(input.close); assert.deepEqual(completed, [undefined]);
});
test('favorites: save exceptions render inline without closing, losing search or changing the row', () => {
  const h = modelHarness(); const row = modelItems(h.pi, h.ctx)[0];
  let attempts = 0;
  row.favorite = { isFavorite: () => true, toggle: () => { attempts++; throw new Error('disk-full-test-sentinel'); } };
  const { p, completed } = paletteFixture([modelsCategory([row])]);
  p.handleInput(input.enter); p.handleInput('reasoner'); p.handleInput(input.right);
  assert.doesNotThrow(() => p.handleInput(input.favorite));
  assert.equal(attempts, 1); assert.match(screen(p), /disk-full-test-sentinel/);
  assert.match(screen(p), /❯ reasoner/); assert.match(row.value(), /max/);
  assert.deepEqual(completed, []); assert.deepEqual(h.calls, []);
  p.handleInput(input.favorite); assert.equal(attempts, 2, 'palette remains interactive');
  p.handleInput(input.enter); assert.equal(completed[0], row);
});
test('favorites: empty, full, filtered and error views stay bounded through resizing', async t => {
  const h = modelHarness();
  const rows = Array.from({ length: 24 }, (_, index) => {
    const row = modelItems(h.pi, h.ctx)[0];
    return { ...row, id: `row-${index}`, label: `reasoner-${index}-中文👩‍💻`,
      favorite: { isFavorite: () => false, toggle: () => { throw new Error('save-failed-中文👩‍💻 '.repeat(30)); } } };
  });
  let height = 30;
  const { p } = paletteFixture([modelsCategory(rows)], () => height);
  p.focused = true; p.handleInput(input.enter);
  const bounded = () => {
    for (height of [1, 5, 6, 7, 8, 9, 12, 20, 30]) {
      for (const width of [1, 5, 6, 12, 30, 80, 180]) {
        const lines = p.render(width);
        assert.ok(lines.length <= height, `${width}x${height}: rendered ${lines.length} lines`);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${height}: ${line}`);
      }
    }
  };
  await t.test('empty favorites', bounded);
  p.handleInput(input.all);
  await t.test('Show all with scrolling', bounded);
  p.handleInput(input.favorite);
  await t.test('inline save error', bounded);
  p.handleInput('no-such-model');
  await t.test('unmatched query', bounded);
});

test('favorites: production reloads disk on every palette open without resetting the extension', async () => {
  const h = harness(); const models = modelHarness();
  Object.assign(h.ctx, { model: models.reasoning, thinkingLevel: 'high', modelRegistry: models.ctx.modelRegistry });
  const renders = []; let opening = 0;
  h.ctx.ui.custom = async factory => {
    let selected;
    const p = factory({ requestRender() {}, terminal: { rows: 32 } }, theme, keys, item => { selected = item; });
    p.handleInput(input.enter); // Production must mark Models as modelGroup.
    renders.push(screen(p));
    if (opening++ === 0) {
      p.handleInput(input.all); p.handleInput('reasoner'); p.handleInput(input.favorite);
    }
    p.handleInput(input.close);
    return selected;
  };
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(opening, 1); assert.deepEqual(h.notices, []);
  assert.match(renders[0], /ctrl\+a/i); assert.match(renders[0], /ctrl\+f/i);
  assert.doesNotMatch(renders[0], /‹ high ›/);
  // Discover only inside the isolated agent directory; no production filename
  // is prescribed by the API, and no real user favorites are consulted.
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const files = readdirSync(agentDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return value.version === 1 && Array.isArray(value.models);
    });
  assert.equal(files.length, 1, 'production persisted favorites in the isolated agent directory');
  assertDisk(files[0], [models.reasoning]);
  writeFileSync(files[0], JSON.stringify({ version: 1, models: [pair(models.plain)] }));
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(opening, 2); assert.deepEqual(h.notices, []);
  assert.match(renders[1], /\[off\].*plain/);
  assert.doesNotMatch(renders[1], /‹ high ›.*reasoner/);
  assert.deepEqual(h.sent, []); assert.equal(h.draft(), 'unfinished draft');
});

function defaultModelFixture(t) {
  const path = join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  t.after(() => {
    if (previous === undefined) rmSync(path, { force: true });
    else writeFileSync(path, previous);
  });
  const original = { defaultProvider: 'zai', defaultModel: 'glm-5.2',
    defaultThinkingLevel: 'medium', modelThinkingLevels: { 'anthropic/opus': 'max' },
    theme: 'dark', packages: ['existing-extension'], customSetting: { keep: true } };
  writeFileSync(path, JSON.stringify(original));
  const h = harness();
  h.ctx.cwd = mkdtempSync(join(sandbox, 'last-model-project-'));
  return { ...h, path, original, select: (source, provider = 'anthropic', id = 'opus') =>
    h.events.get('model_select')({ source, model: { provider, id } }, h.ctx) };
}
test('last model: selecting or cycling saves only the global provider/model pair', async t => {
  const h = defaultModelFixture(t);
  mkdirSync(join(h.ctx.cwd, '.pi'));
  const projectSettings = join(h.ctx.cwd, '.pi', 'settings.json');
  writeFileSync(projectSettings, '{untrusted-project-config');
  await h.select('set');
  assert.deepEqual(JSON.parse(readFileSync(h.path, 'utf8')), {
    ...h.original, defaultProvider: 'anthropic', defaultModel: 'opus',
  });
  assert.deepEqual(h.notices, []);
  await h.select('cycle', 'openai-codex', 'gpt-test');
  assert.deepEqual(JSON.parse(readFileSync(h.path, 'utf8')), {
    ...h.original, defaultProvider: 'openai-codex', defaultModel: 'gpt-test',
  });
  assert.equal(readFileSync(projectSettings, 'utf8'), '{untrusted-project-config');
  assert.equal(h.draft(), 'unfinished draft'); assert.deepEqual(h.sent, []);
});
test('last model: restores, startup/reload and non-TUI agents cannot overwrite the default', async t => {
  const h = defaultModelFixture(t); const before = readFileSync(h.path, 'utf8');
  await h.select('restore');
  for (const reason of ['startup', 'reload', 'new', 'resume', 'fork']) {
    await h.events.get('session_start')({ reason }, h.ctx);
  }
  for (const mode of ['rpc', 'json', 'print']) {
    h.ctx.mode = mode;
    await h.select('set'); await h.select('cycle');
  }
  assert.equal(readFileSync(h.path, 'utf8'), before); assert.deepEqual(h.notices, []);
});
test('last model: latest pane selection wins while unrelated external settings survive', async t => {
  const h = defaultModelFixture(t); const other = harness(); other.ctx.cwd = h.ctx.cwd;
  await h.select('set');
  writeFileSync(h.path, JSON.stringify({ ...JSON.parse(readFileSync(h.path, 'utf8')),
    theme: 'light', anotherSetting: 42 }));
  await other.events.get('model_select')({ source: 'cycle', model: { provider: 'other', id: 'shared' } }, other.ctx);
  await h.select('set', 'third', 'shared');
  assert.deepEqual(JSON.parse(readFileSync(h.path, 'utf8')), {
    ...h.original, defaultProvider: 'third', defaultModel: 'shared', theme: 'light', anotherSetting: 42,
  });
  assert.deepEqual(h.notices, []); assert.deepEqual(other.notices, []);
});
test('last model: malformed settings are not overwritten and report failure', async t => {
  const h = defaultModelFixture(t);
  for (const invalid of ['{broken', 'null', '[]', '"not an object"']) {
    writeFileSync(h.path, invalid);
    const before = h.notices.length;
    await h.select('set');
    assert.equal(readFileSync(h.path, 'utf8'), invalid);
    assert.equal(h.notices.length, before + 1);
    assert.match(h.notices.at(-1)[0], /could not save the startup default/);
    assert.equal(h.notices.at(-1)[1], 'error');
  }
});
test('last model: queued write failures are surfaced and the next selection can retry', async t => {
  const h = defaultModelFixture(t); const before = readFileSync(h.path, 'utf8');
  const write = fs.writeFileSync;
  const fault = t.mock.method(fs, 'writeFileSync', (path, ...args) => {
    if (String(path) === h.path) throw new Error('simulated settings write failure');
    return write(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    await h.select('set');
    assert.equal(readFileSync(h.path, 'utf8'), before);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0][0], /simulated settings write failure/);
  } finally { fault.mock.restore(); syncBuiltinESMExports(); }
  await h.select('set');
  assert.equal(JSON.parse(readFileSync(h.path, 'utf8')).defaultModel, 'opus');
  assert.equal(h.notices.length, 1);
});

// Toggle rows: Enter flips in place, like Ctrl+F favorites, and never closes.
function toggleRow(id, label, { on = false, fail } = {}) {
  let state = on; let calls = 0;
  return { id, label, description: `${label} minor mode`, calls: () => calls,
    toggle: { isOn: () => state, toggle: () => { calls++; if (fail) throw new Error(fail); state = !state; } } };
}
function modeCategory(rows) {
  return { id: 'mode', label: 'Mode', children: [
    { id: 'mode:normal', label: '✓ normal', description: 'Pi as usual', run() {} },
    { id: 'mode:claude-heavy', label: '  claude-heavy', run() {} }, ...rows] };
}
const rowLine = (p, text) => screen(p).split('\n').find(line => line.includes(text));
test('toggle rows: Enter flips in place, keeps selection and query, never closes', () => {
  const align = toggleRow('mode:minor:align', 'align'); const other = toggleRow('mode:minor:other', 'alignment-other');
  const { p, completed } = paletteFixture([modeCategory([align, other]), leaf]);
  p.handleInput(input.enter); p.handleInput('align');
  assert.match(rowLine(p, '→'), /○ align\b/);
  assert.match(screen(p), /Enter toggle · Esc back · Ctrl\+P close/);
  p.handleInput(input.enter);
  assert.equal(align.toggle.isOn(), true); assert.equal(align.calls(), 1);
  assert.match(rowLine(p, '→'), /◉ align\b/, 'selection stays on the toggled row');
  assert.match(screen(p), /❯ align/, 'query survives');
  assert.match(screen(p), /Commands › Mode/);
  p.handleInput(input.enter);
  assert.equal(align.toggle.isOn(), false); assert.match(rowLine(p, '→'), /○ align\b/);
  assert.deepEqual(completed, [], 'done is never called by a toggle');
  assert.equal(other.calls(), 0);
});
test('toggle rows: a throwing toggle renders inline and the palette stays interactive', () => {
  const broken = toggleRow('mode:minor:align', 'align', { fail: 'toggle-test-sentinel' });
  const { p, completed } = paletteFixture([modeCategory([broken])]);
  p.handleInput(input.enter); p.handleInput('align');
  assert.doesNotThrow(() => p.handleInput(input.enter));
  assert.match(screen(p), /Could not toggle align: toggle-test-sentinel/);
  assert.equal(broken.toggle.isOn(), false); assert.deepEqual(completed, []);
  p.handleInput(input.enter); assert.equal(broken.calls(), 2, 'still interactive');
  p.handleInput(input.clear); p.handleInput('normal'); p.handleInput(input.enter);
  assert.equal(completed[0]?.id, 'mode:normal');
});
test('initialPath deep-links into a category; Esc returns to root; misses stop the walk', () => {
  const nodes = [{ id: 'sessions', label: 'Sessions', children: [leaf] }, modeCategory([toggleRow('mode:minor:align', 'align')])];
  const completed = [];
  const p = new Palette(nodes, theme, keys, () => {}, () => 30, item => completed.push(item), ['MODE']);
  assert.match(screen(p), /Commands › Mode/);
  p.handleInput(input.back);
  assert.doesNotMatch(screen(p), /Commands › Mode/);
  assert.match(screen(p), /Sessions/); assert.deepEqual(completed, []);
  const missed = new Palette(nodes, theme, keys, () => {}, () => 30, () => {}, ['nope', 'mode']);
  assert.doesNotMatch(screen(missed), /›\s*Mode/, 'stops at the first miss');
  const leafPath = new Palette(nodes, theme, keys, () => {}, () => 30, () => {}, ['sessions', 'rename']);
  assert.match(screen(leafPath), /Commands › Sessions/); assert.doesNotMatch(screen(leafPath), /› Rename/);
});
test('root search reaches a nested toggle row and Enter toggles it in place', () => {
  const align = toggleRow('mode:minor:align', 'align');
  const { p, completed } = paletteFixture([{ id: 'sessions', label: 'Sessions', children: [leaf] }, modeCategory([align])]);
  p.handleInput('align');
  assert.match(rowLine(p, '→'), /○ align/); assert.match(rowLine(p, '→'), /Mode/);
  p.handleInput(input.enter);
  assert.equal(align.toggle.isOn(), true); assert.match(rowLine(p, '→'), /◉ align/);
  assert.match(screen(p), /❯ align/); assert.deepEqual(completed, []);
  assert.doesNotMatch(screen(p), /Commands › Mode/, 'stays at root');
});

// Provider contract: discovery on every open, isolated failures, deep links.
function captureOpen(h, steps = () => {}) {
  const renders = [];
  h.ctx.ui.custom = async factory => {
    let selected;
    const p = factory({ requestRender() {}, terminal: { rows: 32 } }, theme, keys, item => { selected = item; });
    renders.push(screen(p)); steps(p); renders.push(screen(p));
    p.handleInput(input.close);
    return selected;
  };
  return renders;
}
test('providers: discovered on every open, inserted after Models & thinking, never cached', async () => {
  const h = harness(); let calls = 0; const align = toggleRow('fake:align', 'align');
  const off = contracts.registerPaletteCategory(h.bus, { version: 1, id: 'fake', label: 'Fake category',
    items: ctx => { calls++; assert.equal(ctx, h.ctx); return [align]; } });
  // A duplicate id is ignored rather than listed twice.
  const offDuplicate = contracts.registerPaletteCategory(h.bus, { version: 1, id: 'fake', label: 'Duplicate',
    items: () => { throw new Error('duplicates are never called'); } });
  const renders = captureOpen(h, p => { p.handleInput(input.down); p.handleInput(input.enter); });
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(calls, 1);
  const root = renders[0];
  assert.ok(root.indexOf('Models & thinking') < root.indexOf('Fake category') &&
    root.indexOf('Fake category') < root.indexOf('Sessions'), root);
  assert.doesNotMatch(root, /Duplicate/);
  assert.match(renders[1], /Commands › Fake category/, 'second root row is the provider');
  assert.match(renders[1], /○ align/);
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(calls, 2, 'items() is called on every open');
  off(); offDuplicate();
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(calls, 2); assert.doesNotMatch(renders.at(-1), /Fake category/, 'unregistered providers disappear');
  assert.deepEqual(h.notices, []);
});
test('providers: a throwing items() notifies and only that category is dropped', async () => {
  const h = harness();
  contracts.registerPaletteCategory(h.bus, { version: 1, id: 'broken', label: 'Broken', items: () => { throw new Error('provider-sentinel'); } });
  contracts.registerPaletteCategory(h.bus, { version: 1, id: 'good', label: 'Good category', items: () => [toggleRow('good:x', 'x')] });
  const renders = captureOpen(h);
  await h.shortcuts.get('ctrl+p').handler(h.ctx);
  assert.equal(h.notices.length, 1); assert.match(h.notices[0][0], /provider-sentinel/); assert.equal(h.notices[0][1], 'error');
  assert.doesNotMatch(renders[0], /Broken/);
  for (const label of ['Models & thinking', 'Good category', 'Sessions', 'Settings']) assert.match(renders[0], new RegExp(label));
});
test('/palette <category> deep-links case-insensitively; bare /palette opens at root', async () => {
  const h = harness();
  contracts.registerPaletteCategory(h.bus, { version: 1, id: 'mode', label: 'Mode', items: () => [toggleRow('mode:minor:align', 'align')] });
  const renders = captureOpen(h);
  await h.commands.get('palette').handler(' Mode ', h.ctx);
  assert.match(renders[0], /Commands › Mode/); assert.match(renders[0], /○ align/);
  await h.commands.get('palette').handler('', h.ctx);
  assert.doesNotMatch(renders.at(-1), /Commands › Mode/);
});
test('OPEN_EVENT is claimed only in TUI and only while no palette is open', async () => {
  const h = harness();
  contracts.registerPaletteCategory(h.bus, { version: 1, id: 'mode', label: 'Mode', items: () => [toggleRow('mode:minor:align', 'align')] });
  const renders = []; let close;
  h.ctx.ui.custom = factory => new Promise(resolve => {
    const p = factory({ requestRender() {}, terminal: { rows: 32 } }, theme, keys, resolve);
    renders.push(screen(p)); close = () => p.handleInput(input.close);
  });
  const rpc = { ...h.ctx, mode: 'rpc' };
  assert.equal(contracts.requestPaletteOpen(h.bus, rpc, ['mode']), undefined, 'non-TUI is not claimed');
  assert.equal(renders.length, 0);
  h.bus.emit(contracts.OPEN_EVENT, { version: 2, ctx: h.ctx, claim: () => assert.fail('unknown version claimed') });
  const opened = contracts.requestPaletteOpen(h.bus, h.ctx, ['mode']);
  assert.ok(opened instanceof Promise, 'TUI request is claimed');
  assert.equal(renders.length, 1); assert.match(renders[0], /Commands › Mode/);
  assert.equal(contracts.requestPaletteOpen(h.bus, h.ctx, ['mode']), undefined, 'not claimed while already open');
  assert.equal(renders.length, 1);
  close(); await opened;
  const again = contracts.requestPaletteOpen(h.bus, h.ctx);
  assert.ok(again, 'claimable again after closing');
  assert.doesNotMatch(renders[1], /Commands › Mode/);
  close(); await again;
  assert.deepEqual(h.notices, []);
});

test('models turned off in Settings → Models are not offered by the palette', () => {
  const h = modelHarness();
  const dir = mkdtempSync(join(tmpdir(), 'palette-policy-'));
  const file = join(dir, 'model-policy.json');
  try {
    // The global dimension only: a model kept from workers is still yours to pick here.
    writeFileSync(file, JSON.stringify({ version: 1, disabledModels: ['test/plain'],
      subagentDisabledProviders: ['test'] }));
    const rows = modelItems(h.pi, h.ctx, undefined, file);
    assert.deepEqual(rows.map(row => row.id), ['model:test/reasoner']);
    writeFileSync(file, JSON.stringify({ version: 1, disabledProviders: ['test'], subagentDisabledProviders: [] }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    assert.deepEqual(modelItems(h.pi, h.ctx, undefined, file), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
