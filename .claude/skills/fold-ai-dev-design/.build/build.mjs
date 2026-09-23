// Generates site/**.html and reference/**.md from one content model.
// Run: node .build/build.mjs   (from the skill root)

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { FOUNDATIONS, BRAND } from './content.mjs';
import { COMPONENTS } from './components.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
// The version line in SKILL.md is the only record of the version; the site reads it.
const VERSION = readFileSync(`${ROOT}SKILL.md`, 'utf8').match(/^\*\*Version\.\*\* (\S+)/m)[1];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SYMBOL = (size) =>
  `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" style="vertical-align:middle">` +
  `<path fill="currentColor" d="M4.6 6.2 14.6 9.9v16.4L4.6 22.6z"/>` +
  `<path fill="currentColor" fill-opacity=".55" d="M27.4 6.2 17.4 9.9v16.4l10-3.7z"/></svg>`;

// ---- icon galleries, read from the shipped files so docs can't outrun disk ----
const iconGallery = (dir, cls) => {
  const files = readdirSync(`${ROOT}assets/icons/${dir}`).filter((f) => f.endsWith('.svg')).sort();
  return `<div class="icon-grid">\n` + files.map((f) => {
    const svg = readFileSync(`${ROOT}assets/icons/${dir}/${f}`, 'utf8')
      .replace(/<\?xml[^>]*\?>/, '').replace(/width="\d+" height="\d+"/, 'width="24" height="24"').trim();
    return `  <figure class="icon-cell ${cls}">${svg}<figcaption>${f.replace('.svg', '')}</figcaption></figure>`;
  }).join('\n') + `\n</div>`;
};

const STATE_MATRIX = `
<div class="state-matrix">
  <span></span><span class="text-eyebrow">default</span><span class="text-eyebrow">hover</span>
  <span class="text-eyebrow">focus</span><span class="text-eyebrow">active</span><span class="text-eyebrow">disabled</span>
${[['primary', 'Approve'], ['', 'Review'], ['destructive', 'Discard'], ['ghost', 'Cancel']].map(([v, label]) => {
  const c = v ? ` button-${v}` : '';
  return `  <span class="text-eyebrow">${v || 'secondary'}</span>
  <button class="button${c}">${label}</button>
  <button class="button${c} is-hover">${label}</button>
  <button class="button${c} is-focus">${label}</button>
  <button class="button${c} is-active">${label}</button>
  <button class="button${c} is-disabled" disabled>${label}</button>`;
}).join('\n')}
</div>
<p class="text-muted">The <code>.is-hover</code> / <code>.is-focus</code> / <code>.is-active</code> /
<code>.is-disabled</code> classes exist so this matrix can render every state at once.
<b>They are documentation scaffolding — production uses the real pseudo-classes.</b></p>`;

const expand = (html) => html
  .replace(/\{\{SYMBOL64\}\}/g, SYMBOL(64)).replace(/\{\{SYMBOL32\}\}/g, SYMBOL(32))
  .replace(/\{\{SYMBOL18\}\}/g, SYMBOL(18)).replace(/\{\{SYMBOL16\}\}/g, SYMBOL(16))
  .replace(/\{\{SYMBOL\}\}/g, SYMBOL(28))
  .replace(/\{\{ICONS_FUNCTIONAL\}\}/g, () => iconGallery('functional', ''))
  .replace(/\{\{STATE_MATRIX\}\}/g, () => STATE_MATRIX);

// ---------------------------------------------------------------- site chrome
const NAV = (depth, current) => {
  // Nav targets live inside site/, so they climb one level less than the
  // stylesheets do (which sit at the skill root).
  const up = '../'.repeat(depth - 1);
  const group = (label, items, dir) => `
      <p class="docsnav-label">${label}</p>
      <ul class="docsnav-list">
${items.map((i) => `        <li><a class="docsnav-link${current === i.slug ? ' docsnav-link-active' : ''}" href="${up}${dir}/${i.slug}.html">${i.title}</a></li>`).join('\n')}
      </ul>`;
  return `<nav class="docsnav" aria-label="Reference">
      <a class="docsnav-brand" href="${up}index.html">${SYMBOL(20)}<b>Fold AI Dev</b></a>
      ${group('Foundations', FOUNDATIONS, 'foundations')}
      ${group('Brand', BRAND, 'brand')}
      ${group('Components', COMPONENTS, 'components')}
    </nav>`;
};

const page = ({ depth, current, title, purpose, body, eyebrow }) => {
  const up = '../'.repeat(depth);
  return `<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Fold AI Dev</title>
<link rel="stylesheet" href="${up}tokens.css">
<link rel="stylesheet" href="${up}fold-ai-dev.css">
<link rel="stylesheet" href="${up}site/docs.css">
</head>
<body class="docs">
  <div class="docs-shell">
    ${NAV(depth, current)}
    <main class="docs-main">
      <button class="docs-theme button button-sm" data-theme-toggle>Theme</button>
      <p class="text-eyebrow">${esc(eyebrow)}</p>
      <h1>${esc(title)}</h1>
      <p class="docs-purpose">${esc(purpose)}</p>
${body}
    </main>
  </div>
  <script>
    // Site chrome only — the design system itself ships no JavaScript.
    document.querySelector('[data-theme-toggle]').addEventListener('click', () => {
      const r = document.documentElement;
      const now = r.getAttribute('data-theme')
        || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      r.setAttribute('data-theme', now === 'dark' ? 'light' : 'dark');
    });
  </script>
</body>
</html>
`;
};

const sectionsHtml = (entry) => entry.sections.map((s) => `      <section class="docs-section" id="${s.id}">
        <h2 class="docs-h2">${esc(s.name)}</h2>
        <div class="docs-demo">${expand(s.html)}</div>
      </section>`).join('\n');

const tablesHtml = (entry) => {
  // **Escape first, then make the code spans.** A cell is prose, and the prose
  // in this model names HTML elements — "Use on `<a>` or `<button>`", "Wraps a
  // `<details>`". Substituted raw, those became elements: the List page shipped
  // an empty `<a>` that turned the word "or" into a link, and every table that
  // named a tag lost the tag. Escaping is what makes a backtick mean *code*
  // rather than *markup*.
  const inline = (c) => esc(c).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const rows = (arr) => arr.map((r) => `<tr>${r.map((c, i) =>
    `<td${i === 0 ? ' class="text-mono"' : ''}>${inline(c)}</td>`).join('')}</tr>`).join('\n          ');
  const spec = entry.spec ? `      <section class="docs-section" id="spec">
        <h2 class="docs-h2">Scale &amp; spec</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr>${entry.spec.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
          ${rows(entry.spec.rows)}
          </tbody>
        </table></div>
${entry.spec.prose.map((p) => `        <p class="measure">${inline(p)}</p>`).join('\n')}
      </section>
` : '';
  return `${spec}      <section class="docs-section" id="styles">
        <h2 class="docs-h2">Styles</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Class</th><th>Role</th><th>Notes</th></tr></thead>
          <tbody>
          ${rows(entry.classes)}
          </tbody>
        </table></div>
      </section>
      <section class="docs-section" id="tokens">
        <h2 class="docs-h2">Tokens used</h2>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Token</th><th>Role here</th></tr></thead>
          <tbody>
          ${rows(entry.tokens)}
          </tbody>
        </table></div>
      </section>
      <section class="docs-section" id="usage">
        <h2 class="docs-h2">Usage</h2>
        <div class="do-dont">
          <div class="do">
            <p class="text-eyebrow text-success">Do</p>
            <ul>${entry.dos.map(([r, w]) => `<li><b>${esc(r)}</b> — ${esc(w)}.</li>`).join('')}</ul>
          </div>
          <div class="dont">
            <p class="text-eyebrow text-error">Don't</p>
            <ul>${entry.donts.map(([r, w]) => `<li><b>${esc(r)}</b> — ${esc(w)}.</li>`).join('')}</ul>
          </div>
        </div>
      </section>`;
};

// ------------------------------------------------------------------ emit pages
const written = [];
const emit = (dir, entry, eyebrow) => {
  mkdirSync(`${ROOT}site/${dir}`, { recursive: true });
  const html = page({
    depth: 2, current: entry.slug, title: entry.title, purpose: entry.purpose, eyebrow,
    body: sectionsHtml(entry) + '\n' + tablesHtml(entry),
  });
  const path = `site/${dir}/${entry.slug}.html`;
  writeFileSync(`${ROOT}${path}`, html);
  written.push({ dir, entry, path });
};

FOUNDATIONS.forEach((e) => emit('foundations', e, 'Foundation'));
BRAND.forEach((e) => emit('brand', e, 'Brand'));
COMPONENTS.forEach((e) => emit('components', e, 'Component'));

// ------------------------------------------------------------- reference docs
const mdTable = (head, rows) =>
  `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n` +
  rows.map((r) => `| ${r.join(' | ')} |`).join('\n');

// The `Rendered:` anchor is picked from the ids this entry's page actually
// emits (its own sections, then the table sections), never a string kept
// beside the model. Foundations and brand topics cite their spec table; a
// component cites its variants section, else its first demo — the part a
// builder reads first.
const anchorOf = (dir, entry) => {
  const ids = [...entry.sections.map((s) => s.id), ...(entry.spec ? ['spec'] : []), 'styles', 'tokens', 'usage'];
  const want = dir === 'components' ? ['variants', entry.sections[0]?.id] : ['spec', entry.sections[0]?.id];
  const id = want.find((w) => w && ids.includes(w));
  if (!id) throw new Error(`${dir}/${entry.slug}: no anchorable section`);
  return id;
};

for (const { dir, entry, path } of written) {
  const md = `# ${entry.title}

## Purpose

${entry.purpose}

Rendered: \`${path}#${anchorOf(dir, entry)}\`

## Styles

${mdTable(['Class', 'Role', 'Notes'], entry.classes.map(([c, r, n]) => [`\`${c}\``, r, n]))}

## Tokens used

${entry.tokens.map(([t, r]) => `- \`${t}\` — ${r}`).join('\n')}
${entry.spec ? `
## Scale & spec

${mdTable(entry.spec.head, entry.spec.rows)}

${entry.spec.prose.join('\n\n')}
` : ''}${entry.snippets ? `
## Variants & states

${entry.snippets.map(([name, code]) => `### ${name}

\`\`\`html
${code}
\`\`\`
`).join('\n')}
${entry.classes.some(([c]) => c.includes('.is-')) ? `Every state is rendered together in the site page's state matrix. The \`.is-hover\`,
\`.is-focus\`, \`.is-active\` and \`.is-disabled\` helpers are **documentation scaffolding
only** — production code uses the real pseudo-classes.
` : ''}` : ''}${entry.subsections ? entry.subsections.map(([h, body]) => `
### ${h}

${body}
`).join('') : ''}
## DO / DON'T

${entry.dos.map(([r, w]) => `- **DO** ${r} — ${w}.`).join('\n')}
${entry.donts.map(([r, w]) => `- **DON'T** ${r} — ${w}.`).join('\n')}
`;
  mkdirSync(`${ROOT}reference/${dir}`, { recursive: true });
  writeFileSync(`${ROOT}reference/${dir}/${entry.slug}.md`, md);
}

// ----------------------------------------------------------------- site index
const card = (dir, e) => `      <a class="card card-interactive index-card" href="${dir}/${e.slug}.html">
        <div class="card-body">
          <p class="text-heading-s index-card-title">${esc(e.title)}</p>
          <p class="text-muted index-card-body">${esc(e.purpose.split('.')[0])}.</p>
        </div>
      </a>`;

const index = page({
  depth: 1, current: null, title: 'Fold AI Dev', eyebrow: `Design system · v${VERSION} · en-US`,
  purpose: 'The whole system, rendered — 7 foundations, 2 brand topics, and 25 components, in both themes. Use the theme toggle: nothing on these pages knows which theme it is in.',
  body: `      <section class="docs-section" id="foundations">
        <h2 class="docs-h2">Foundations</h2>
        <div class="index-grid">
${FOUNDATIONS.map((e) => card('foundations', e)).join('\n')}
        </div>
      </section>
      <section class="docs-section" id="brand">
        <h2 class="docs-h2">Brand</h2>
        <div class="index-grid">
${BRAND.map((e) => card('brand', e)).join('\n')}
        </div>
      </section>
      <section class="docs-section" id="components">
        <h2 class="docs-h2">Components</h2>
        <div class="index-grid">
${COMPONENTS.map((e) => card('components', e)).join('\n')}
        </div>
      </section>`,
});
writeFileSync(`${ROOT}site/index.html`, index.replace('href="../site/docs.css"', 'href="docs.css"'));

console.log(`site: ${written.length + 1} pages · reference: ${written.length} docs`);
