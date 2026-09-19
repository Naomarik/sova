// Run with the existing installed Pi runtime; no second dependency tree.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jiti } from '../../subagents/tests/runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const file of readdirSync(root).filter(f => f.endsWith('.test.ts')).sort()) {
  await jiti.import(root + file);
}
