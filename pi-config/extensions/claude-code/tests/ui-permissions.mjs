// No terminal or model request: exercise installed Pi's real confirm/abort behavior.
import assert from 'node:assert/strict';
import path from 'node:path';
import { jiti, packageDir } from '../../subagents/tests/runtime.mjs';
const { InteractiveMode } = await jiti.import(path.join(packageDir, 'dist/modes/interactive/interactive-mode.js'));
const { initTheme } = await jiti.import(path.join(packageDir, 'dist/modes/interactive/theme/theme.js'));
const { PermissionQueue } = await jiti.import(new URL('../permissions.ts', import.meta.url).pathname);
initTheme('dark', false);
const children = [];
const editor = {};
const mode = {
  editor,
  editorContainer: { clear() { children.length = 0; }, addChild(component) { children.push(component); } },
  ui: { setFocus() {}, requestRender() {} },
  disposeActiveSelector() {}, toggleToolOutputExpansion() {},
  showExtensionSelector: InteractiveMode.prototype.showExtensionSelector,
  hideExtensionSelector: InteractiveMode.prototype.hideExtensionSelector,
  showExtensionConfirm: InteractiveMode.prototype.showExtensionConfirm,
};
const firstSignal = new AbortController();
const queue = new PermissionQueue(1000);
let oldSelector;
const first = queue.run(firstSignal.signal, async signal => {
  const result = mode.showExtensionConfirm('First', 'test', { signal });
  oldSelector = mode.extensionSelector;
  return { behavior: (await result) ? 'allow' : 'deny', message: 'closed' };
});
const second = queue.run(new AbortController().signal, async signal => {
  assert.equal(mode.extensionSelector, undefined, 'old dialog must be gone before opening another');
  assert.equal(children.includes(oldSelector), false);
  const result = mode.showExtensionConfirm('Second', 'test', { signal });
  mode.extensionSelector.handleInput('\n');
  return { behavior: (await result) ? 'allow' : 'deny', message: 'closed' };
});
await new Promise(resolve => setImmediate(resolve));
assert.ok(oldSelector);
firstSignal.abort();
assert.equal((await first).behavior, 'deny');
assert.equal((await second).behavior, 'allow');
assert.equal(mode.extensionSelector, undefined);
assert.deepEqual(children, [editor]);
queue.dispose();
console.log('PASS: installed Pi confirm abort disposes its dialog before the next worker prompt.');
