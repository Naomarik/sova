// Run with the existing installed Pi runtime; no second dependency tree.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jiti } from '../../subagents/tests/runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
// The extension root plus the one-level subdirectories that hold tests.
for (const dir of [root, root + 'provider/']) {
  for (const file of readdirSync(dir).filter(f => f.endsWith('.test.ts')).sort()) {
    await jiti.import(dir + file);
  }
}
