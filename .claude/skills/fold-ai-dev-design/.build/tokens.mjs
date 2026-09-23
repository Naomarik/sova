// Reads tokens.css so the Scale & spec tables are parsed, not restated: a table
// built from the file that defines the values cannot hold a stale one.
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const css = readFileSync(`${ROOT}tokens.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Declarations of every block whose selector is exactly `sel`.
const blocks = (sel) => {
  const out = {};
  const re = new RegExp(`(^|\\n)\\s*${sel.replace(/[[\]"=]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of css.matchAll(re))
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
};

// Top-level `:root` blocks only — the one inside `@media (prefers-color-scheme)`
// is indented and repeats the dark override, which is read separately below.
const light = {};
for (const m of css.matchAll(/\n:root\s*\{([^}]*)\}/g))
  for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) light[d[1]] = d[2].trim();
const dark = { ...light, ...blocks(':root[data-theme="dark"]') };

const resolve = (map, v, depth = 0) => {
  if (depth > 8) throw new Error(`var() cycle at ${v}`);
  return v.replace(/var\((--[\w-]+)\)/g, (_, n) => {
    if (!(n in map)) throw new Error(`tokens.css: ${n} is not defined`);
    return resolve(map, map[n], depth + 1);
  });
};

export const token = (name, theme = 'light') => {
  const map = theme === 'dark' ? dark : light;
  if (!(name in map)) throw new Error(`tokens.css: ${name} is not defined`);
  return resolve(map, map[name]);
};

export const tokenNames = (prefix) => Object.keys(light).filter((n) => n.startsWith(prefix));

// WCAG 2.x contrast ratio between two opaque hexes, unrounded — callers format it.
const lum = (hex) => {
  const c = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
