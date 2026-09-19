// Phase 06 mechanical audits: links, anchors, counts, consistency.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let fail = 0, checks = 0;
const ok  = (m) => { checks++; console.log(`  ok    ${m}`); };
const bad = (m) => { checks++; fail++; console.log(`  FAIL  ${m}`); };

const walk = (d, out = []) => {
  for (const f of readdirSync(d)) {
    if (f.startsWith('.')) continue;
    const p = `${d}/${f}`;
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
const files = walk(ROOT);

// ---------------------------------------------------------------- 1. links
console.log('\n== href / src / url() resolution');
let linkBad = 0, linkTotal = 0;
for (const f of files.filter((f) => /\.(html|css)$/.test(f))) {
  const src = readFileSync(f, 'utf8');
  const refs = [
    ...[...src.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/url\(["']?([^)"']+)["']?\)/g)].map((m) => m[1]),
  ].filter((r) => !/^(https?:|data:|mailto:|#)/.test(r));
  for (const r of refs) {
    linkTotal++;
    const target = resolve(dirname(f), r.split('#')[0]);
    if (!existsSync(target)) { linkBad++; bad(`${relative(ROOT, f)} → ${r}`); }
  }
}
if (!linkBad) ok(`${linkTotal} local references, all resolve`);

// -------------------------------------------- 2. every doc names a real page
console.log('\n== each reference doc points at a shipped page');
let pageBad = 0, pageTotal = 0;
for (const md of files.filter((f) => f.includes('/reference/') && f.endsWith('.md'))) {
  pageTotal++;
  const rel = readFileSync(md, 'utf8').match(/^Rendered: `([^`]+)`$/m)?.[1];
  if (!rel) { bad(`${relative(ROOT, md)} — no Rendered line`); pageBad++; continue; }
  if (!existsSync(`${ROOT}/${rel}`)) { bad(`${relative(ROOT, md)} → missing ${rel}`); pageBad++; }
}
if (!pageBad) ok(`${pageTotal} reference docs, each pointing at a page that exists`);

// -------------------------------------------------------------- 3. counts
console.log('\n== counts in prose vs files on disk');
const count = (d, ext) => readdirSync(`${ROOT}/${d}`).filter((f) => f.endsWith(ext)).length;
const real = {
  functional: count('assets/icons/functional', '.svg'),
  logos: count('assets/logos', '.svg'),
  fonts: count('fonts', '.woff2'),
  components: count('reference/components', '.md'),
  foundations: count('reference/foundations', '.md'),
  brand: count('reference/brand', '.md'),
  sitePages: files.filter((f) => f.includes('/site/') && f.endsWith('.html')).length,
};
const claims = [
  ['37 functional icons', real.functional, 37],
  ['4 logo files', real.logos, 4], ['2 font files', real.fonts, 2],
  ['25 components', real.components, 25], ['7 foundations', real.foundations, 7],
  ['2 brand topics', real.brand, 2], ['35 site pages', real.sitePages, 35],
];
for (const [label, actual, claimed] of claims)
  actual === claimed ? ok(`${label} — ${actual} on disk`) : bad(`${label} — ${actual} on disk`);

// SKILL.md is the only prose doc in the skill, so it is the only one that can
// make a count claim that disagrees with disk.
const skill = readFileSync(`${ROOT}/SKILL.md`, 'utf8');
for (const [re, n, what] of [[/37 (?:line icons|functional)/, 37, 'functional icons'],
                             [/25 components/, 25, 'components'],
                             [/7 foundations/, 7, 'foundations']])
  re.test(skill) ? ok(`SKILL.md claims ${n} ${what} — matches disk`)
                 : bad(`SKILL.md missing ${what} count`);

// ---------------------------------------------------- 4. value consistency
console.log('\n== one value, stated the same everywhere');
const tokens = readFileSync(`${ROOT}/tokens.css`, 'utf8');
// The palette is stated three times: tokens.css defines it, SKILL.md documents
// it, and .build/content.mjs draws the swatches. All three must agree — a
// generator that disagrees with tokens.css silently regresses the docs on the
// next rebuild, which is exactly how this drifted before.
const content = readFileSync(`${ROOT}/.build/content.mjs`, 'utf8');
const shared = [['#4A43D8', 'accent light'], ['#8E88FF', 'accent dark'], ['#656572', 'muted light'],
                ['#86868F', 'border-strong light'], ['#17171C', 'ink light'], ['#1E1E26', 'paper dark'],
                ['#F2F2F7', 'paper light'], ['#2C2C38', 'surface dark']];
for (const [hex, what] of shared) {
  const inT = tokens.includes(hex), inS = skill.includes(hex), inC = content.includes(hex);
  (inT && inS && inC) ? ok(`${what} ${hex} — tokens.css, SKILL.md, content.mjs agree`)
                      : bad(`${what} ${hex} — tokens:${inT} skill:${inS} content:${inC}`);
}
// The docs word the ratio differently ("60 / 25 / 10 / 5" vs "60% paper / 25% ink / …");
// what must agree is the four numbers, in order.
for (const [label, re] of [['usage ratio 60/25/10/5', /\b60\b[^0-9]{1,16}\b25\b[^0-9]{1,16}\b10\b[^0-9]{1,16}\b5\b/],
                           ['44px touch minimum', /44/], ['4px spacing base', /4px base|--space-1:\s*4px/]]) {
  const all = [tokens, skill].every((d) => re.test(d));
  all ? ok(`${label} — consistent across tokens.css and SKILL.md`) : bad(`${label} — inconsistent`);
}

// Stale hexes must be gone EVERYWHERE, .build/ included. The generator is the
// one place a superseded value can hide without showing up in the shipped
// output — until someone rebuilds and silently reverts the palette.
console.log('\n== superseded values fully removed');
for (const [old, why] of [['#71717E', '1.0 muted, failed AA on sunken'],
                          ['#A9A9B6', '1.0 border-strong, below 3:1'],
                          ['#565664', '1.0 dark border-strong, below 3:1'],
                          ['#6D6D7A', '1.1 muted light'],
                          ['#8A8A96', '1.1 border-strong light'],
                          ['#FBFBFC', '1.1 paper light, no step off surface'],
                          ['#0E0E13', '1.1 paper dark, near-black'],
                          ['#17171E', '1.1 surface dark'],
                          ['#EEEDFB', '1.1 accent tint light']]) {
  const hits = files.filter((f) => /\.(css|md|html|mjs)$/.test(f))
                    .filter((f) => readFileSync(f, 'utf8').includes(old));
  hits.length === 0 ? ok(`${old} (${why}) — gone`)
                    : bad(`${old} still in ${hits.map((h) => relative(ROOT, h)).join(', ')}`);
}

// ------------------------------------------------------------- 5. stances
console.log('\n== required stances present in SKILL.md');
for (const [name, re] of [['dark mode', /^## Dark mode$/m], ['motion', /^## Focus & motion$/m],
                          ['responsive', /^## Responsive$/m], ['accessibility', /^## Accessibility$/m],
                          ['placeholder disclosure', /Placeholder disclosure/]])
  re.test(skill) ? ok(`${name} — stated`) : bad(`${name} — missing`);

// SKILL.md is the design system and nothing else. Product definition belongs in
// the spec; a synopsis here is a second source of truth that goes stale unread.
console.log('\n== no product definition in the design system');
for (const [what, re] of [['tagline', /Portable AI dev|Your workshop, folded/],
                          ['product synopsis', /workflow-centric|solo developer|indie builder/],
                          ['audience claim', /built for one person|what needs me right now/i]])
  re.test(skill) ? bad(`${what} — belongs in spec/, not here`) : ok(`no ${what}`);

// -------------------------------------------------------------- 6. hygiene
console.log('\n== hygiene');
const rawHex = readFileSync(`${ROOT}/fold-ai-dev.css`, 'utf8').match(/#[0-9A-Fa-f]{3,8}\b/g);
rawHex ? bad(`raw hex in fold-ai-dev.css: ${rawHex.join(' ')}`) : ok('no raw hex outside tokens.css');

const lorem = files.filter((f) => /\.(html|md|css)$/.test(f))
  .filter((f) => /lorem ipsum|TODO|FIXME|XXX|placeholder text/i.test(readFileSync(f, 'utf8')));
lorem.length ? bad(`lorem/TODO in: ${lorem.map((f) => relative(ROOT, f)).join(', ')}`)
             : ok('no lorem ipsum, no TODO markers');

const cdn = files.filter((f) => /\.(html|css)$/.test(f))
  .filter((f) => /https?:\/\/(?!www\.w3\.org)/.test(readFileSync(f, 'utf8')));
cdn.length ? bad(`external URL in: ${cdn.map((f) => relative(ROOT, f)).join(', ')}`)
           : ok('no CDN or external requests — works offline');

console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${checks - fail}/${checks} checks\n`);
process.exit(fail ? 1 : 0);
