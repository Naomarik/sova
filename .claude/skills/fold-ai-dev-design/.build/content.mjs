// Single content model for the Fold AI Dev reference.
// site/**.html and reference/**.md are both generated from this, so a doc can
// never disagree with the page it documents.

export const FOUNDATIONS = [
  {
    slug: 'colors', title: 'Color',
    purpose: `One saturated color, spent carefully. Fold Indigo marks the primary action and the live run; everything else is ink, paper, and four status hues. The rule that matters: full-strength indigo is 5% of any composition — spend it on decoration and "this needs you" stops meaning anything.`,
    sections: [
      { id: 'palette', name: 'Palette', html: `
<div class="swatches">
  ${[['Fold Indigo','--color-accent','#4A43D8','#8E88FF','Primary action, live run, links'],
     ['Indigo tint','--color-accent-tint','#E8E6FA','#2B2650','Selected rows, active nav'],
     ['Ink','--color-ink','#17171C','#F2F2F6','Body text, headings'],
     ['Ink-2','--color-ink-2','#4A4A57','#B8B8C6','Secondary prose'],
     ['Muted','--color-ink-muted','#656572','#9A9AA8','Metadata, captions'],
     ['Paper','--color-bg','#F2F2F7','#1E1E26','Page background'],
     ['Surface','--color-surface','#FFFFFF','#2C2C38','Cards, sheets'],
     ['Sunken','--color-sunken','#E9E9F0','#26262F','Headers, gutters'],
     ['Border','--color-border','#E3E3E9','#3B3B49','Dividers'],
     ['Border strong','--color-border-strong','#86868F','#7E7E93','Control borders — 3:1']]
    .map(([n,t,l,d,r])=>`<div class="swatch">
    <div class="swatch-c" style="background:var(${t})"></div>
    <div class="swatch-m"><b>${n}</b><code>${t}</code><span>${l} · ${d}</span><em>${r}</em></div>
  </div>`).join('\n  ')}
</div>` },
      { id: 'ratio', name: 'Usage ratio', html: `
<div class="ratio">
  <div style="flex:60;background:var(--color-bg);color:var(--color-ink-muted)">60 · paper</div>
  <div style="flex:25;background:var(--color-ink);color:var(--color-bg)">25 · ink</div>
  <div style="flex:10;background:var(--color-accent-tint);color:var(--color-accent)">10 · tint</div>
  <div style="flex:5;background:var(--color-accent);color:var(--color-on-accent)">5</div>
</div>
<p class="text-muted">The last 5% is the primary action and the live-run indicator. Nothing else.</p>` },
      { id: 'status', name: 'Status', html: `
<div class="cluster">
  <span class="chip chip-success"><i class="chip-dot"></i>Passed</span>
  <span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span>
  <span class="chip chip-error"><i class="chip-dot"></i>Failed</span>
  <span class="chip chip-info"><i class="chip-dot"></i>Queued</span>
  <span class="chip chip-accent"><i class="chip-dot"></i>Running</span>
</div>
<div class="stack" style="margin-top:var(--space-4)">
  <div class="banner banner-warn"><span class="banner-icon">!</span><div><p class="banner-title">2 runs are waiting on you.</p><p class="banner-body">Nothing merges until you decide.</p></div></div>
  <div class="banner banner-error"><span class="banner-icon">×</span><div><p class="banner-title">This run failed at step 4 and stopped.</p><p class="banner-body">Nothing was merged.</p></div></div>
</div>` },
    ],
    classes: [['.chip-success|warn|error|info|accent','Status color on a chip','Sets `color`; the dot inherits it'],
              ['.banner-success|warn|error|info','Soft status background','Uses `--status-*-bg`'],
              ['.text-accent|success|warn|error','Status color on text','Never the only signal']],
    tokens: [['--color-accent','The one saturated color. Primary action, live run, and text selection.'],
             ['--color-accent-tint','Selected rows and active nav. 10% of a composition.'],
             ['--color-ink / -2 / -muted','Three text weights. Muted is a discrete token, not an alpha.'],
             ['--color-bg / -surface / -sunken','Page, raised, recessed.'],
             ['--color-border / -border-strong','Dividers vs control boundaries. Only the latter meets 3:1.'],
             ['--status-*','Four hues, per theme. Always paired with a word.']],
    dos: [['Spend indigo on the one decision the user came to make','the accent is the product\'s only way to say "here"'],
          ['Pair every status hue with a word and a dot','1 in 12 men can\'t separate red from green, and nobody can in sunlight'],
          ['Use `--color-border-strong` for anything a user can click','it is the only border value that meets the 3:1 UI threshold']],
    donts: [['Tint a shadow with the accent','use `--shadow-1..3`, which are neutral black by policy'],
            ['Express muted text as `rgba(ink, .65)`','use `--color-ink-muted`, which is measured against every documented surface'],
            ['Invert the light palette to make dark','the accent lifts and elevation changes mechanism — see the dark column above']],
  },
  {
    slug: 'typography', title: 'Typography',
    purpose: `Inter for what a person reads, JetBrains Mono for what a machine produced. The mono does the technical work so the sans can stay calm — which is why run IDs, paths and diffs are always mono and prose never is.`,
    sections: [
      { id: 'scale', name: 'Scale', html: `
<div class="scale">
  ${[['display-xl','40 / 1.05','Runs'],
     ['display-l','29 / 1.12','Waiting on you'],
     ['heading-m','20 / 1.25','4 runs working'],
     ['heading-s','16 / 1.35','Review changes'],
     ['body','14.5 / 1.55','Changed 7 files in src/api. Nothing merged yet.'],
     ['caption','12.5 / 1.45','Updated 2h ago'],
     ['mono','12.5 / 1.5','run_8f21c4 · +142 −38 · 14:06'],
     ['micro','11 / 1.3','WAITING ON YOU']]
   .map(([n,m,s])=>`<div class="scale-row"><code>${n}</code><span class="text-muted scale-m">${m}</span>
    <span class="${n==='mono'||n==='micro'?(n==='micro'?'text-eyebrow':'text-mono'):'text-'+n}">${s}</span></div>`).join('\n  ')}
</div>` },
      { id: 'mono', name: 'When to use mono', html: `
<div class="card"><div class="card-body">
  <p>A run ID is <code class="text-mono">run_8f21c4</code>, a path is <code class="text-mono">src/api/runs.ts</code>, a stat is <code class="text-mono">+142 −38</code>, a log time is <code class="text-mono">14:06</code>.</p>
  <p class="text-muted">Prose is never mono. If you can't copy it and paste it somewhere useful, it isn't a machine fact.</p>
</div></div>` },
    ],
    classes: [['.text-display-xl','40px display','One per page'],
              ['.text-display-l','29px display','Section openers'],
              ['.text-heading-m','20px','Card group, modal title'],
              ['.text-heading-s','16px','Card title'],
              ['.text-body','14.5px','Default'],
              ['.text-caption','12.5px','Metadata'],
              ['.text-mono','12.5px mono','Machine facts only'],
              ['.text-eyebrow','11px mono, uppercase','Labels — never a sentence'],
              ['.text-num','Tabular numerals','Any column of numbers']],
    tokens: [['--font-body / --font-display','Inter, with a system fallback stack.'],
             ['--font-mono','JetBrains Mono. Reserved for machine facts.'],
             ['--fs-* / --lh-*','Eight steps, each with its line height.'],
             ['--fw-regular|medium|semibold|display','400 / 530 / 600 / 640. Nothing else is on-system.'],
             ['--measure','72ch cap on any reading column. Applied by `.prose` and `.measure`, never by a bare element.']],
    dos: [['Use mono for anything the user might copy','it signals "this is exact" before they read it'],
          ['Cap prose with `.prose` or `.measure`','past ~72ch the eye loses the line return'],
          ['Use `.text-num` in any numeric column','proportional digits make a column of numbers jitter']],
    donts: [['Expect a bare `<p>` to be capped','it is not, since 1.6.0 — a `<p>` is a status strip as often as it is prose'],
            ['Set body text in mono because it looks technical','it costs ~20% reading speed and says nothing'],
            ['Add a weight outside the four permitted','a fifth weight is a decision nobody documented'],
            ['Use `.text-eyebrow` for a sentence','it is uppercase and letterspaced; sentences become unreadable']],
  },
  {
    slug: 'spacing', title: 'Spacing',
    purpose: `A 4px base and nine steps. This is a compact ops tool: surfaces live in space-2 through space-5, and space-7 upward appears only where there is one idea on the screen. You're scanning a queue, not reading an article.`,
    sections: [
      { id: 'scale', name: 'Scale', html: `
<div class="stack-2">
  ${[1,2,3,4,5,6,7,8,9].map((n,i)=>{const v=[4,8,12,16,24,32,48,64,96][i];
    return `<div class="spread" style="justify-content:flex-start;gap:var(--space-4)">
    <code style="width:110px">--space-${n}</code><span class="text-muted" style="width:44px">${v}px</span>
    <div style="height:14px;width:${v}px;background:var(--color-accent);border-radius:3px"></div></div>`}).join('\n  ')}
</div>` },
      { id: 'density', name: 'Density in practice', html: `
<div class="card list">
  <div class="list-group-label">Waiting on you</div>
  <div class="list-row"><div class="list-main"><p class="list-title">Add rate limiting to /api/runs</p>
    <p class="list-meta">44px row · 12px padding</p></div><span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span></div>
  <div class="list-row"><div class="list-main"><p class="list-title">Migrate session store to D1</p>
    <p class="list-meta">The target grew; the row didn't</p></div><span class="chip chip-error"><i class="chip-dot"></i>Failed</span></div>
</div>` },
    ],
    classes: [['.stack','Vertical rhythm at `--space-4`','Default column gap'],
              ['.stack-2 / .stack-5','Tighter / looser column','8px / 24px'],
              ['.cluster','Horizontal wrap at `--space-2`','Buttons, chips'],
              ['.spread','Space-between row','Title + action'],
              ['.page','Centred page box','`--page-max` + `--space-4` gutter']],
    tokens: [['--space-1…9','4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96.'],
             ['--row-height','44px. The list row and the tap target are the same number.'],
             ['--page-max','1280px page ceiling.']],
    dos: [['Keep product surfaces in space-2 to space-5','density is what lets a folded screen show more than four items'],
          ['Grow padding, not type, to reach 44px','bigger targets, same information'],
          ['Use the stack/cluster helpers instead of ad-hoc margins','margins collapse and fight each other; gaps don\'t']],
    donts: [['Use space-7+ on a dense surface','it belongs where there is one idea per screen, such as an empty state'],
            ['Inflate row heights on touch devices','the target is already 44px; taller rows just show less'],
            ['Invent a value between steps','a 10px gap is a decision nobody can repeat']],
  },
  {
    slug: 'radius', title: 'Radius',
    purpose: `Seven steps, assigned by element rather than by taste. The load-bearing rule: status is round, actions are not — shape alone tells you what's clickable, before color does.`,
    sections: [
      { id: 'ramp', name: 'Ramp', html: `
<div class="cluster">
  ${[['none','0'],['xs','4px'],['sm','6px'],['md','8px'],['lg','12px'],['xl','16px'],['full','999px']]
    .map(([n,v])=>`<div style="text-align:center">
    <div style="width:76px;height:60px;background:var(--color-accent-tint);border:1.5px solid var(--color-accent);border-radius:${v}"></div>
    <code style="display:block;margin-top:6px">${n}</code></div>`).join('\n  ')}
</div>` },
      { id: 'assignment', name: 'Assignment', html: `
<div class="cluster" style="align-items:flex-start">
  <button class="button button-primary">Button · md</button>
  <span class="chip chip-accent"><i class="chip-dot"></i>Chip · full</span>
  <span class="text-mono" style="padding:var(--space-2) var(--space-3);background:var(--color-sunken);border-radius:var(--r-sm)">Code · sm</span>
</div>
<div class="card" style="margin-top:var(--space-4)"><div class="card-body">Card · lg</div></div>` },
    ],
    classes: [['—','Radius is applied by component, not by utility','No `.radius-*` helpers exist, on purpose']],
    tokens: [['--r-xs','Focus ring, checkbox.'],['--r-sm','Code block, diff hunk.'],
             ['--r-md','Button, input, select.'],['--r-lg','Card, panel.'],
             ['--r-xl','Sheet, modal, drawer.'],['--r-full','Chip, badge, avatar.']],
    dos: [['Keep chips fully round and buttons at 8px','the shape difference is what separates state from action at a glance'],
          ['Give a card one step more radius than its contents','nesting then reads as nesting'],
          ['Use `--r-sm` around monospace blocks','round corners fight a monospace grid']],
    donts: [['Round a button to a pill','it becomes indistinguishable from a status chip, and pills eat width at folded sizes'],
            ['Use `--r-lg` on a 16px checkbox','at that size it is a circle, which means "radio"'],
            ['Add an eighth radius step','seven already covers every element in the inventory']],
  },
  {
    slug: 'shadow', title: 'Elevation',
    purpose: `Three steps and a flat default, in neutral black only. The rule people get wrong: in dark, elevation is carried by surface lightness, not a heavier shadow — a black shadow on a near-black background is invisible.`,
    sections: [
      { id: 'ramp', name: 'Ramp', html: `
<div class="cluster">
  ${[['flat','none','Inline content'],['--shadow-1','var(--shadow-1)','Resting card'],
     ['--shadow-2','var(--shadow-2)','Popover, sheet, toast'],['--shadow-3','var(--shadow-3)','Modal']]
    .map(([n,s,r])=>`<div style="width:170px;height:96px;border-radius:var(--r-lg);background:var(--color-surface);
    border:1px solid var(--color-border);box-shadow:${s};display:grid;place-items:center;text-align:center">
    <div><code>${n}</code><br><small>${r}</small></div></div>`).join('\n  ')}
</div>` },
    ],
    classes: [['.card','Resting elevation','`--shadow-1`'],
              ['.card-raised','Raised card','`--shadow-2`'],
              ['.toast / .popover','Floating surface','`--shadow-2`'],
              ['.modal','Highest surface','`--shadow-3`']],
    tokens: [['--shadow-1','Resting card. Barely there by design.'],
             ['--shadow-2','Anything that floats above the page.'],
             ['--shadow-3','Modal only. If everything is elevated, nothing is.']],
    dos: [['Reserve `--shadow-3` for the modal','a single highest surface is what makes "highest" mean something'],
          ['In dark, raise the surface color to signal elevation','that is the only mechanism that reads on near-black'],
          ['Pair every shadow with a border','shadows vanish on some displays; borders do not']],
    donts: [['Tint a shadow with the accent','colored shadows are a documented never-rule'],
            ['Stack a heavier shadow in dark to compensate','it will not appear; use surface lightness'],
            ['Use elevation to indicate state','elevation is about layering, not about status']],
  },
  {
    slug: 'grid-composition', title: 'Grid & responsive',
    purpose: `The bands are the device, not a screen-size ladder. This product is designed first for a folded phone, so the threshold that matters is the one the phone itself crosses — the Galaxy Z Fold8 reports ~475 CSS px folded and ~933 unfolded, its main display being landscape-first, and 768 separates them. Container queries rather than media queries, because a pane can be at folded width inside a desktop window and should look like it.`,
    sections: [
      { id: 'breakpoints', name: 'Breakpoints', html: `
<div class="table-wrap"><table class="table">
  <thead><tr><th>Token</th><th>Width</th><th>Device</th><th>What changes</th></tr></thead>
  <tbody>
    <tr><td class="text-mono">folded</td><td class="text-mono">&lt; 768</td><td>the cover screen, ~475</td><td>Single column · bottom nav · tables become stacked cards · approval bar pinned inside the thumb arc · unified diff only</td></tr>
    <tr><td class="text-mono">unfolded</td><td class="text-mono">≥ 768</td><td>the main screen, ~933 landscape</td><td><strong>Sidebar left, main pane right</strong> · approval bar inline · side-by-side diff available</td></tr>
    <tr><td class="text-mono">desktop</td><td class="text-mono">≥ 1120</td><td>an external display</td><td>Three panes: rail + list + detail</td></tr>
  </tbody>
</table></div>
<p class="text-muted"><strong>Unfolded means sidebar left, main pane right.</strong> Unfolding the phone turns it
landscape, and landscape with a bottom nav wastes the width it just gained while pushing the primary action away from
both thumbs. A screen that answers unfolding by growing one column has stretched the folded layout, not designed the
unfolded one. <code>tablet</code> is retired as a band name: it was 768, which <code>unfolded</code> now names.</p>` },
      { id: 'touch', name: 'Touch', html: `
<div class="card"><div class="card-body">
  <div class="cluster"><button class="button button-primary">Approve</button>
    <button class="button">Review Changes</button>
    <span style="flex:1"></span>
    <button class="button button-destructive">Discard Run</button></div>
  <p class="text-muted measure" style="margin-top:var(--space-3)">44×44 minimum at every breakpoint, desktop included.
  Destructive keeps its distance from primary — never adjacent in a thumb arc.</p>
</div></div>` },
    ],
    classes: [['.page','Centred, max 1280','Gutter is `--space-4`'],
              ['.pane','Scroll region **and** query container','The box a component measures'],
              ['.measure','72ch reading cap, one element','Opt-in since 1.6.0'],
              ['.prose','72ch cap on the running text inside','Leaves strips and rows alone'],
              ['.table-stack','Table collapses below 768 of its `.table-wrap`','Needs `data-label` per cell']],
    tokens: [['--bp-unfolded / -desktop','768 / 1120. For JS and docs — custom properties do not work in `@media`. `--bp-tablet` is retired; it was 768, which `--bp-unfolded` now names.'],
             ['--page-max','1280px.'],['--measure','72ch.'],
             ['--tap-min','44px, every breakpoint.']],
    dos: [['Write `@container` queries in components','the component should ask its own box, not the window'],
          ['Give the box a `.pane` so the query has something to match','a container query with no container never matches and the page still renders'],
          ['Name any container you declare yourself, and query it by name','an unnamed `@container` binds to the nearest one, which since 1.6.0 may be a `.table-wrap` or a `.diff` rather than your screen root'],
          ['Duplicate every gesture with a visible control','swipe is an accelerator, never the door'],
          ['Pin the primary decision to the bottom at folded width','that is where a thumb reaches one-handed']],
    donts: [['Let a table scroll horizontally on a phone','stack it — horizontal scroll is a defeat, not a fallback'],
            ['Render a `.scrim` or `.modal` inside a `.pane`','containment makes the pane its containing block, so it covers the pane and not the screen'],
            ['Let a container take its width from its own contents','`container-type: inline-size` resolves the box without them, so a `.table-wrap` as a flex item measures 0px and a `.diff` in an `auto` track measures 2px'],
            ['Hide a control behind hover','a phone has no hover, so the control does not exist there'],
            ['Treat folded as a degraded desktop','it is a first-class width, and it is designed for first']],
  },
  {
    slug: 'motion', title: 'Focus & motion',
    purpose: `One curve, three durations, and a written rule about what never moves. Motion is a foundation here rather than a flourish — without one sanctioned duration, every consumer invents their own transitions and the product starts to feel assembled rather than built.`,
    sections: [
      { id: 'focus', name: 'Focus', html: `
<div class="cluster">
  <button class="button button-focus">Focus ring</button>
  <input class="input input-focus" style="max-width:200px" value="Focused input">
</div>
<p class="text-muted">2px solid accent, 2px offset, <code>:focus-visible</code> only. Never removed.</p>` },
      { id: 'durations', name: 'Durations', html: `
<div class="table-wrap"><table class="table">
  <thead><tr><th>Token</th><th>Value</th><th>Applies to</th></tr></thead>
  <tbody>
    <tr><td class="text-mono">--dur-fast</td><td class="text-mono">120ms</td><td>Hover, focus, press</td></tr>
    <tr><td class="text-mono">--dur-base</td><td class="text-mono">200ms</td><td>Popover, toast, sheet entering</td></tr>
    <tr><td class="text-mono">--dur-slow</td><td class="text-mono">320ms</td><td>Full-screen transitions only</td></tr>
    <tr><td class="text-mono">--ease-standard</td><td class="text-mono">cubic-bezier(.2,0,0,1)</td><td>Everything. No bounce, no spring.</td></tr>
  </tbody>
</table></div>` },
      { id: 'live', name: 'The two exceptions', html: `
<div class="card"><div class="card-body">
  <div class="timeline">
    <div class="timeline-step timeline-running"><div class="timeline-marker"></div>
      <div><p class="timeline-title">Running tests</p><p class="timeline-meta">38 of 214</p></div></div>
  </div>
  <div class="skeleton skeleton-line" style="margin-top:var(--space-3)"></div>
  <p class="text-muted measure">The live-run indicator and the skeleton sweep. Both report that work is happening;
  both stop under <code>prefers-reduced-motion</code>.</p>
</div></div>` },
    ],
    classes: [['.button-focus / .input-focus','Static focus — demo only','Production uses `:focus-visible`'],
              ['.timeline-running','Pulsing live marker','One of two sanctioned loops'],
              ['.skeleton','Sweeping placeholder','The other']],
    tokens: [['--focus-ring / --focus-width / --focus-offset / --focus-color','The ring, in pieces and composed.'],
             ['--dur-fast|base|slow','120 / 200 / 320ms.'],
             ['--ease-standard','The only curve in the system.']],
    dos: [['Animate state changes at `--dur-fast`','faster feels broken, slower feels sluggish'],
          ['Keep opacity fades under reduced motion','they carry meaning; transforms are what cause discomfort'],
          ['Use one curve everywhere','mixed easings read as mixed authorship']],
    donts: [['Add a spring or bounce','this product reports on other people\'s work; playfulness reads as unseriousness'],
            ['Loop anything decorative','two exceptions exist and they both mean "work is happening"'],
            ['Remove the focus outline','a keyboard user who cannot see focus cannot use the product']],
  },
];

export const BRAND = [
  {
    slug: 'logo', title: 'Logo',
    purpose: `Two panels hinged at a center crease — the device seen from above. One color plus one opacity, which is what lets it survive a favicon and a 16px sidebar. It ships as a swappable placeholder: replace four files and nothing else in the system changes.`,
    sections: [
      { id: 'colorways', name: 'Colorways', html: `
<div class="cluster">
  <div class="logo-box"><span style="color:var(--color-accent)">${'{{SYMBOL}}'}</span><b>Fold</b></div>
  <div class="logo-box"><span style="color:var(--color-ink)">${'{{SYMBOL}}'}</span><b>Fold</b></div>
  <div class="logo-box logo-box-accent"><span>${'{{SYMBOL}}'}</span><b>Fold</b></div>
</div>` },
      { id: 'sizes', name: 'Minimum sizes', html: `
<div class="cluster" style="align-items:flex-end">
  <div style="text-align:center;color:var(--color-accent)"><span style="display:block;width:16px">${'{{SYMBOL16}}'}</span><small>16px min</small></div>
  <div style="text-align:center;color:var(--color-accent)"><span style="display:block;width:32px">${'{{SYMBOL32}}'}</span><small>32px</small></div>
  <div style="text-align:center;color:var(--color-accent)"><span style="display:block;width:64px">${'{{SYMBOL64}}'}</span><small>64px</small></div>
</div>` },
      { id: 'misuse', name: 'Misuse', html: `
<div class="cluster">
  ${[['rotate(18deg)','Rotated'],['scaleX(1.6)','Stretched'],['none','Gradient']].map(([t,l],i)=>
    `<div class="misuse"><span style="transform:${t};display:inline-block;${i===2?'background:linear-gradient(90deg,#4A43D8,#E3A63A);-webkit-background-clip:text;background-clip:text;color:transparent':'color:var(--color-accent)'}">${'{{SYMBOL32}}'}</span><small class="text-error">✕ ${l}</small></div>`).join('\n  ')}
</div>` },
    ],
    classes: [['—','The mark is an SVG file, not a CSS class','Inline it or `<img>` it from `assets/logos/`']],
    tokens: [['--color-accent','Default colorway in product chrome.'],
             ['--color-ink','Monochrome documents and print.'],
             ['--color-on-accent','The inverse colorway, on an indigo field.']],
    dos: [['Use the `currentColor` source and let context color it','one file, every colorway'],
          ['Keep one panel-width of clear space','the mark stops reading when text crowds the crease'],
          ['Replace it when a real mark exists','it is explicitly a placeholder']],
    donts: [['Rotate, stretch, or gradient it','all three destroy the one idea the mark carries'],
            ['Re-set the wordmark in another face','it is Inter 640 at -0.03em, or it is not the wordmark'],
            ['Treat it as a registered trademark','it is generated, unregistered, and yours to discard']],
  },
  {
    slug: 'iconography', title: 'Iconography',
    purpose: `37 line icons on a 24px grid, shipped as local files. They inherit color from context via \`currentColor\`, which is what lets one file serve both themes and every surface it lands on.`,
    sections: [
      { id: 'functional', name: 'The set', html: `{{ICONS_FUNCTIONAL}}` },
      { id: 'spec', name: 'Spec', html: `
<div class="table-wrap"><table class="table">
  <thead><tr><th>Property</th><th>Value</th></tr></thead>
  <tbody>
    <tr><td>Grid</td><td class="text-mono">24</td></tr>
    <tr><td>Stroke</td><td class="text-mono">1.5px — the same in both themes</td></tr>
    <tr><td>Caps / joins</td><td>round</td></tr>
    <tr><td>Fill / stroke</td><td class="text-mono">fill="none" · stroke="currentColor"</td></tr>
  </tbody>
</table></div>` },
    ],
    classes: [['—','Icons are files, not classes','Inline the SVG so `currentColor` works']],
    tokens: [['--stroke-icon','1.5px — the icon stroke, in both themes.']],
    dos: [['Inline the SVG so it inherits color','an `<img>` cannot follow `currentColor` or the theme'],
          ['Copy the nearest icon when adding one','the set stays coherent only if the geometry matches'],
          ['Ship every icon you document','a documented file that is not on disk is a broken system']],
    donts: [['Thin the stroke in dark to compensate for glow','it makes icons vanish on a phone outdoors'],
            ['Point a consumer at an external icon library','a network dependency is not a shipped system'],
            ['Draw off the pixel grid','a half-pixel stroke renders soft at 24px and muddy at 16']],
  },
];
