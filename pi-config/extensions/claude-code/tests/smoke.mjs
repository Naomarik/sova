import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, jiti } from '../../subagents/tests/runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const subagents = path.resolve(root, '../subagents/index.ts');
const claude = path.join(root, 'index.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await delay(30); }
  throw new Error(`${label} timed out`);
}
for (const extensions of [[subagents, claude], [claude, subagents]]) {
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-tools', '--no-extensions', ...extensions.flatMap(e => ['-e', e])], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false; let stderr = ''; const errors = []; let response;
  const closure = once(child, 'close').then(() => { closed = true; });
  child.stderr.on('data', data => { stderr += data; });
  createInterface({ input: child.stdout }).on('line', line => {
    try { const e = JSON.parse(line); if (e.type === 'extension_error') errors.push(e); if (e.type === 'response' && e.id === 'commands') response = e; } catch { errors.push(line); }
  });
  try {
    child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
    await until(() => response || closed, 'Pi startup');
    assert.equal(response?.success, true, stderr);
    assert.ok(response.data.commands.some(c => c.name === 'agents'));
    assert.ok(response.data.commands.some(c => c.name === 'subagents'));
    assert.deepEqual(errors, []);
    assert.equal(stderr.trim(), '');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([closure, delay(5000)]);
    if (!closed) { child.kill('SIGKILL'); await closure; }
  }
}
console.log('PASS: both extensions load in either order; /agents and /subagents register.');

if (process.argv.includes('--live')) {
  const { ClaudeRunner } = await jiti.import(path.join(root, 'runner.ts'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-claude-smoke-'));
  const runner = new ClaudeRunner({ id: 'smoke', groupId: 'smoke', name: 'smoke', cwd, model: 'sonnet', effort: 'low', tools: [], maxBudgetUsd: 1, task: 'Remember the token AMBER-618. Reply only READY.' }, { onChange() {}, onSettled() {}, onExit() {} });
  try {
    await until(() => runner.isSettled(), 'first Claude task', 90000);
    assert.equal(runner.taskOutcome, 'success', runner.error);
    assert.match(runner.finalOutput(), /READY/);
    const sid = runner.sessionId;
    assert.ok(sid);
    const accepted = await runner.steer('What token did I ask you to remember? Reply only the token.');
    assert.equal(accepted.ok, true, accepted.reason);
    await until(() => runner.isSettled(), 'second Claude task', 90000);
    assert.equal(runner.taskOutcome, 'success', runner.error);
    assert.match(runner.finalOutput(), /AMBER-618/);
    assert.equal(runner.sessionId, sid);
    assert.ok(!runner.finalOutput().includes('READY'), 'output must be task-scoped');
    await runner.kill('smoke complete');
    assert.equal(runner.status, 'killed');
    assert.equal(runner.processAlive, false);
    if (runner.pid && process.platform === 'linux') assert.equal(existsSync(`/proc/${runner.pid}`), false);
    console.log('PASS: real Claude continuity, idle steering, task output boundaries, and shutdown.');
  } finally { await runner.dispose(); }
}
