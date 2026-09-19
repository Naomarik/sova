// Component content model — drives site/components/*.html and reference/components/*.md.

export const COMPONENTS = [
  {
    slug: 'button', title: 'Button',
    purpose: `The decision, made tappable. One primary per view — the thing the user came to do — and destructive actions are outlined rather than filled, because a filled red button is the most tappable thing on screen, which is exactly backwards.`,
    sections: [
      { id: 'variants', name: 'Variants', html: `
<div class="button-row">
  <button class="button button-primary">Approve</button>
  <button class="button">Review Changes</button>
  <button class="button button-destructive">Discard Run</button>
  <button class="button button-ghost">Cancel</button>
</div>` },
      { id: 'sizes', name: 'Sizes', html: `
<div class="button-row">
  <button class="button button-primary button-sm">Small · 36</button>
  <button class="button button-primary">Default · 44</button>
  <button class="button button-primary button-lg">Large · 52</button>
</div>
<p class="text-muted">Small is allowed only inside an already-tapped context — a popover, a desktop table cell —
never as the sole action on a touch surface.</p>` },
      { id: 'states', name: 'States', html: `{{STATE_MATRIX}}` },
    ],
    classes: [['.button','Base — 44px, 8px radius, 1.5px border','`--control-md` `--r-md` `--color-border-strong`'],
              ['.button-primary','Filled accent','`--color-accent` / `--color-on-accent`'],
              ['.button-destructive','Outlined error','Never filled'],
              ['.button-ghost','Borderless, muted','Cancel and tertiary'],
              ['.button-sm / .button-lg','36px / 52px','Label size shifts with it'],
              ['.button-icon','Square 44px','Requires `aria-label`'],
              ['.button-row','Demo helper — wrapping row','Demo only'],
              ['.button-hover / -focus / -active / -disabled','Static states','**Demo only** — production uses pseudo-classes']],
    tokens: [['--control-sm|md|lg','36 / 44 / 52px heights.'],
             ['--r-md','8px corner.'],
             ['--color-accent / --color-on-accent','Primary fill and its label.'],
             ['--color-border-strong','Secondary border — the 3:1 value.'],
             ['--status-error','Destructive border and label.'],
             ['--dur-fast / --ease-standard','120ms state transition.']],
    snippets: [
      ['Primary', `<button class="button button-primary">Approve</button>`],
      ['Secondary', `<button class="button">Review Changes</button>`],
      ['Destructive', `<button class="button button-destructive">Discard Run</button>`],
      ['Ghost', `<button class="button button-ghost">Cancel</button>`],
      ['Icon only', `<button class="button button-icon" aria-label="More actions">…</button>`],
    ],
    dos: [['Keep exactly one primary per view','two primaries mean the product has not decided what the user should do'],
          ['Name the object on a destructive action','"Discard" alone is a question, "Discard Run" is an answer'],
          ['Keep destructive out of the thumb arc beside primary','one mis-tap on a train should not throw work away']],
    donts: [['Fill a destructive button','it becomes the most inviting target on screen'],
            ['Use `.button-sm` as the only action on a touch surface','36px is below the 44px minimum'],
            ['Ship the `.button-hover` helpers in production','they are documentation scaffolding; use the real pseudo-classes']],
  },
  {
    slug: 'chip', title: 'Chip',
    purpose: `A status, said twice — once in color and once in words. Chips are fully round because status is round and actions are not; the shape alone tells you this is something you read, not something you press.`,
    sections: [
      { id: 'variants', name: 'Variants', html: `
<div class="cluster">
  <span class="chip chip-success"><i class="chip-dot"></i>Passed</span>
  <span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span>
  <span class="chip chip-error"><i class="chip-dot"></i>Failed</span>
  <span class="chip chip-info"><i class="chip-dot"></i>Queued</span>
  <span class="chip chip-accent"><i class="chip-dot"></i>Running</span>
</div>` },
      { id: 'solid', name: 'Solid & count', html: `
<div class="cluster">
  <span class="chip chip-solid chip-success"><i class="chip-dot"></i>Merged</span>
  <span class="chip chip-solid chip-error"><i class="chip-dot"></i>Failed</span>
  <span class="chip chip-count">7</span>
  <span class="chip chip-count">142</span>
</div>` },
    ],
    classes: [['.chip','Base — pill, mono micro, uppercase','`--r-full` `--fs-micro`'],
              ['.chip-dot','6px dot inheriting `currentColor`','Structural, not decorative'],
              ['.chip-success|warn|error|info|accent','Status color','Sets text and dot'],
              ['.chip-solid','Soft background fill','Pairs with a status class'],
              ['.chip-count','Tabular numerals, no uppercase','For counts only']],
    tokens: [['--r-full','The pill shape that separates status from action.'],
             ['--fs-micro','11px label.'],
             ['--status-*','Text color per status.'],
             ['--status-*-bg','Fill for `.chip-solid`.']],
    snippets: [
      ['Status chip', `<span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span>`],
      ['Solid', `<span class="chip chip-solid chip-success"><i class="chip-dot"></i>Merged</span>`],
      ['Count', `<span class="chip chip-count">7</span>`],
    ],
    dos: [['Always include the dot and the word','hue alone fails for colorblind users and in sunlight'],
          ['Keep chip labels to one or two words','it is a label, not a sentence'],
          ['Use `.chip-count` for numbers','tabular numerals stop a column from jittering']],
    donts: [['Put a click handler on a chip','if it does something it is a button — use `.button-sm`'],
            ['Invent a sixth status color','four statuses plus accent cover every run state'],
            ['Use a chip as a tag input','that is a combobox']],
  },
  {
    slug: 'input', title: 'Input',
    purpose: `A 44px field with a real label. The placeholder is never the label — it disappears the moment someone types, and a form you cannot re-read is a form you cannot check.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div style="max-width:380px" class="stack">
  <div class="field">
    <label class="field-label" for="run-name">Run name</label>
    <input class="input" id="run-name" placeholder="Add rate limiting">
    <span class="field-hint">Shown in the queue and in the run log.</span>
  </div>
  <div class="field">
    <label class="field-label" for="notes">Notes for the worker</label>
    <textarea class="input textarea" id="notes" placeholder="What should it know before it starts?"></textarea>
  </div>
  <div class="field">
    <label class="field-label" for="bad">Branch</label>
    <input class="input input-invalid" id="bad" value="prototype/gone" aria-invalid="true">
    <span class="field-error">That branch doesn't exist. Pick one that does.</span>
  </div>
</div>` },
      { id: 'states', name: 'States', html: `
<div class="cluster">
  <input class="input" style="max-width:170px" placeholder="Default">
  <input class="input input-hover" style="max-width:170px" value="Hover">
  <input class="input input-focus" style="max-width:170px" value="Focus">
  <input class="input input-disabled" style="max-width:170px" value="Disabled" disabled>
  <input class="input input-mono" style="max-width:190px" value="run_8f21c4">
</div>` },
    ],
    classes: [['.field','Label + control + message column','`--space-2` gap'],
              ['.field-row','Same field, laid out as a row','A switch beside its label'],
              ['.field-label','12.5px semibold label','Always present'],
              ['.field-hint','Muted help text','Below the control'],
              ['.field-error','Error message','Pairs with `aria-invalid`'],
              ['.input','Base — 44px, 8px radius','`--control-md`'],
              ['.textarea','Multi-line, vertical resize','Min 88px'],
              ['.input-mono','Mono content','IDs, paths'],
              ['.input-invalid','Error border','Use with `aria-invalid="true"`'],
              ['.input-hover / -focus / -disabled','Static states','**Demo only**']],
    tokens: [['--control-md','44px height.'],['--r-md','8px corner.'],
             ['--color-border-strong','Resting border, 3:1.'],
             ['--color-accent','Focused border and ring.'],
             ['--status-error','Invalid border and message.']],
    snippets: [
      ['Labelled field', `<div class="field">
  <label class="field-label" for="run-name">Run name</label>
  <input class="input" id="run-name" placeholder="Add rate limiting">
  <span class="field-hint">Shown in the queue and in the run log.</span>
</div>`],
      ['Invalid', `<input class="input input-invalid" aria-invalid="true" value="prototype/gone">
<span class="field-error">That branch doesn't exist. Pick one that does.</span>`],
      ['Field as a row', `<div class="field field-row">
  <label class="field-label" for="live">Follow the run</label>
  <span class="toggle-switch"><input type="checkbox" id="live" checked></span>
</div>`],
    ],
    dos: [['Always ship a visible `<label>` tied by `for`','a placeholder vanishes exactly when the user needs it'],
          ['Say what to do in an error, not just what broke','"Pick one that does" is actionable; "Invalid" is not'],
          ['Use `.input-mono` for IDs and paths','it signals the value is exact'],
          ['Add `.field-row` when a field is a row','`.field` is a column, and a class that sets only `display:flex` inherits it']],
    donts: [['Use the placeholder as the label','it fails on review, on autofill, and for screen readers'],
            ['Shrink an input below 44px','it is the most-tapped control in any form'],
            ['Color an invalid field without a message','color alone does not say what is wrong'],
            ['Restate `flex-direction` on your own class to undo `.field`','`.field-row` is the supported name; a second one drifts']],
  },
  {
    slug: 'select', title: 'Select & combobox',
    purpose: `A closed list and a searchable one. Options are 44px targets too — a menu is not somewhere to save vertical space, because the whole point of opening it is to hit one item.`,
    sections: [
      { id: 'select', name: 'Select', html: `
<div style="max-width:320px" class="stack">
  <div class="field"><label class="field-label" for="br">Branch</label>
    <div class="select-wrap"><select class="select" id="br">
      <option>main</option><option>prototype/claude-run-centered</option></select>
      <span class="select-caret">▾</span></div></div>
</div>` },
      { id: 'combobox', name: 'Combobox', html: `
<div style="max-width:320px">
  <input class="input" value="src/api" aria-expanded="true">
  <ul class="combobox-list">
    <li class="combobox-option" aria-selected="true">src/api/runs.ts</li>
    <li class="combobox-option">src/api/session.ts</li>
    <li class="combobox-option">src/api/limiter.ts</li>
  </ul>
</div>` },
    ],
    classes: [['.select','Base — 44px, native select','Appearance reset'],
              ['.select-wrap','Positioning context','Holds the caret'],
              ['.select-caret','Non-interactive chevron','`pointer-events:none`'],
              ['.combobox-list','Floating option list','`--shadow-2`'],
              ['.combobox-option','44px option row','Tinted when selected']],
    tokens: [['--control-md','44px for both the control and each option.'],
             ['--color-accent-tint','Selected option background.'],
             ['--shadow-2','List elevation.']],
    snippets: [
      ['Select', `<div class="select-wrap">
  <select class="select"><option>main</option></select>
  <span class="select-caret">▾</span>
</div>`],
      ['Combobox option', `<li class="combobox-option" aria-selected="true">src/api/runs.ts</li>`],
    ],
    dos: [['Keep options at 44px','a 28px option is a mis-tap waiting to happen'],
          ['Use a native `<select>` when the list is short and closed','it gets the platform picker on a phone for free'],
          ['Mark the active option with `aria-selected`','the tint is not announced; the attribute is']],
    donts: [['Use a combobox for two options','that is a radio pair or a switch'],
            ['Let the list exceed the viewport','cap it and scroll inside the list'],
            ['Rely on the caret to signal interactivity','the 3:1 border does that work']],
  },
  {
    slug: 'toggle', title: 'Toggle',
    purpose: `Checkbox, radio, and switch, sharing one label row. The label row is the target, not the 18px box — a control you have to aim at is a control that gets missed on a moving train.`,
    sections: [
      { id: 'variants', name: 'Variants', html: `
<div class="stack-2">
  <label class="toggle"><input type="checkbox" checked><span class="toggle-box">✓</span>Auto-approve runs that only touch tests</label>
  <label class="toggle"><input type="checkbox"><span class="toggle-box">✓</span>Pause other workers while I review</label>
  <label class="toggle toggle-radio"><input type="radio" name="d" checked><span class="toggle-box"></span>Unified diff</label>
  <label class="toggle toggle-radio"><input type="radio" name="d"><span class="toggle-box"></span>Side-by-side diff</label>
  <label class="toggle toggle-switch"><input type="checkbox" checked><span class="toggle-box"></span>Notify me when a run wants a decision</label>
</div>` },
    ],
    classes: [['.toggle','Label row — 44px target','Wraps a hidden native input'],
              ['.toggle-box','18px visual box','Checkbox by default'],
              ['.toggle-radio','Round box','Radio semantics'],
              ['.toggle-switch','40×24 track and knob','Immediate-effect settings']],
    tokens: [['--tap-min','44px row height.'],
             ['--r-xs / --r-full','Square checkbox / round radio and switch.'],
             ['--color-accent','Checked fill.'],
             ['--dur-fast','Knob travel.']],
    snippets: [
      ['Checkbox', `<label class="toggle">
  <input type="checkbox" checked><span class="toggle-box">✓</span>
  Auto-approve runs that only touch tests
</label>`],
      ['Switch', `<label class="toggle toggle-switch">
  <input type="checkbox" checked><span class="toggle-box"></span>
  Notify me when a run wants a decision
</label>`],
    ],
    dos: [['Wrap the input in the label','the whole row becomes the target with no extra markup'],
          ['Use a switch only for settings that apply immediately','a switch that needs a Save button is lying'],
          ['Keep the native input in the DOM','it carries keyboard and screen-reader behavior for free']],
    donts: [['Replace the native input with a `<div>`','you inherit every accessibility bug you then have to fix'],
            ['Use a switch inside a form that submits','use a checkbox'],
            ['Shrink the row below 44px to fit more settings','a settings list is not where density pays']],
  },
  {
    slug: 'card', title: 'Card',
    purpose: `A bounded surface with an optional head and foot. Cards get one radius step more than their contents so nesting reads as nesting, and an interactive card needs a focus ring — not just a hover, which half your users never see.`,
    sections: [
      { id: 'variants', name: 'Variants', html: `
<div class="demo-grid">
  <div class="card"><div class="card-head"><h4 class="card-title">Resting</h4></div>
    <div class="card-body text-muted">Default surface, <code>--shadow-1</code>.</div>
    <div class="card-foot"><button class="button button-sm">Open</button></div></div>
  <div class="card card-raised"><div class="card-head"><h4 class="card-title">Raised</h4></div>
    <div class="card-body text-muted">Floating, <code>--shadow-2</code>.</div></div>
  <div class="card card-interactive" tabindex="0"><div class="card-body">
    <p class="text-heading-s" style="margin:0 0 4px">Interactive</p>
    <p class="text-muted" style="margin:0">Hover or focus me.</p></div></div>
</div>` },
    ],
    classes: [['.card','Base — 12px radius, border, `--shadow-1`','Clips its contents'],
              ['.card-head','Sunken header strip','Title and status'],
              ['.card-title','16px semibold','Inside the head'],
              ['.card-body','16px padding','Content'],
              ['.card-foot','Action row','Top border'],
              ['.card-raised','`--shadow-2`','Floating context'],
              ['.card-interactive','Hover + focus affordance','Needs `tabindex` or a link']],
    tokens: [['--r-lg','12px — one step above its contents.'],
             ['--color-surface / --color-sunken','Body and head.'],
             ['--shadow-1 / -2','Resting and raised.']],
    snippets: [
      ['Card with head and foot', `<div class="card">
  <div class="card-head"><h4 class="card-title">Run 8f21c4</h4></div>
  <div class="card-body">Changed 7 files in src/api. Nothing merged yet.</div>
  <div class="card-foot"><button class="button button-sm button-primary">Approve</button></div>
</div>`],
    ],
    dos: [['Give an interactive card a focus style','keyboard users get no hover'],
          ['Keep the head for context, the foot for actions','a card whose actions float in the body is hard to scan'],
          ['Use `.card-raised` only when the card floats','elevation should mean layering']],
    donts: [['Nest a card inside a card','use a list or a bordered block instead'],
            ['Put the primary page action in a card foot','it belongs in the approval bar'],
            ['Add a shadow and no border','shadows disappear on some displays']],
  },
  {
    slug: 'appbar', title: 'App bar',
    purpose: `Brand, context, and status — nothing else. Actions that belong to the content belong in the content; an app bar that collects them becomes a junk drawer the user has to search.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="bordered" style="overflow:hidden">
  <div class="appbar">
    <a class="appbar-brand" href="#">{{SYMBOL18}}Fold</a>
    <span class="appbar-title">Attention</span>
    <span class="appbar-spacer"></span>
    <span class="chip chip-accent"><i class="chip-dot"></i>4 running</span>
  </div>
</div>` },
    ],
    classes: [['.appbar','56px bar with bottom border','`--color-bg`'],
              ['.appbar-brand','Symbol + wordmark link','Accent symbol, ink word'],
              ['.appbar-title','Current context','16px semibold'],
              ['.appbar-spacer','Flexible gap','Pushes status right']],
    tokens: [['--color-bg / --color-border','Bar fill and its edge.'],
             ['--color-accent','The symbol only — not the wordmark.']],
    snippets: [
      ['App bar', `<div class="appbar">
  <a class="appbar-brand" href="/">…Fold</a>
  <span class="appbar-title">Attention</span>
  <span class="appbar-spacer"></span>
  <span class="chip chip-accent"><i class="chip-dot"></i>4 running</span>
</div>`],
    ],
    dos: [['Keep it to brand, context, and one status','it is a location indicator, not a toolbar'],
          ['Show the live count here','it is the one number worth carrying on every screen'],
          ['Keep the bar background at `--color-bg`','a raised bar competes with the content it frames']],
    donts: [['Collect content actions in the bar','they belong beside what they act on'],
            ['Make the whole bar sticky at folded width','vertical space is the scarcest thing on a phone'],
            ['Color the wordmark','only the symbol takes the accent']],
  },
  {
    slug: 'nav', title: 'Rail & bottom bar',
    purpose: `One navigation, two placements: a bottom bar under 768px where the thumb is, a side rail above it. Never both at once — two navs in one view means neither is the answer to "where am I?"`,
    sections: [
      { id: 'bottom', name: 'Bottom bar · under 768', html: `
<div class="bordered" style="overflow:hidden;max-width:420px">
  <nav class="bottombar">
    <a class="navitem navitem-active" href="#" aria-current="page"><span class="navitem-label">Queue</span></a>
    <a class="navitem" href="#"><span class="navitem-label">Runs</span></a>
    <a class="navitem" href="#"><span class="navitem-label">Chats</span></a>
    <a class="navitem" href="#"><span class="navitem-label">Settings</span></a>
  </nav>
</div>` },
      { id: 'rail', name: 'Side rail · 768 and up', html: `
<div class="bordered" style="overflow:hidden;display:flex;max-width:420px">
  <nav class="rail">
    <a class="navitem navitem-active" href="#" aria-current="page"><span class="navitem-label">Queue</span></a>
    <a class="navitem" href="#"><span class="navitem-label">Runs</span></a>
    <a class="navitem" href="#"><span class="navitem-label">Chats</span></a>
    <a class="navitem" href="#"><span class="navitem-label">Settings</span></a>
  </nav>
  <div style="flex:1;padding:var(--space-4)" class="text-muted">Content pane</div>
</div>` },
    ],
    classes: [['.bottombar','Full-width bar, 56px items','Under 768 only'],
              ['.rail','Vertical column','768 and up'],
              ['.navitem','44px minimum target','Shared by both'],
              ['.navitem-active','Tinted current item','Pair with `aria-current="page"`'],
              ['.navitem-label','The label, truncating','Wrap every label. Ellipsises rather than eating the item padding']],
    tokens: [['--tap-min','44px per item.'],
             ['--color-accent-tint / --color-accent','Active fill and label.'],
             ['--bp-unfolded','768px — where the nav moves, from bottom bar to side rail.']],
    snippets: [
      ['Bottom bar', `<nav class="bottombar">
  <a class="navitem navitem-active" href="/queue" aria-current="page"><span class="navitem-label">Queue</span></a>
  <a class="navitem" href="/runs"><span class="navitem-label">Runs</span></a>
</nav>`],
    ],
    dos: [['Put the nav at the bottom under 768px','that is where a one-handed thumb reaches'],
          ['Set `aria-current="page"` as well as the class','the tint is not announced'],
          ['Size the nav by its longest label, not by a count','at 475px five items leave 71px for a label and six leave 55px; `Worktrees` measures 54.6, so six fit and a longer word does not'],
          ['Wrap every label in `.navitem-label`','it truncates a label that will not fit; bare text in a `.navitem` spends the item padding instead and closes the gap to its neighbor']],
    donts: [['Show a rail and a bottom bar together','the user cannot tell which one is authoritative'],
            ['Hide labels and ship icons alone','an unlabelled icon is a guess'],
            ['Put a destructive action in the nav','navigation moves you; it should not change anything']],
  },
  {
    slug: 'tabs', title: 'Tabs',
    purpose: `Tabs switch views; they never submit. And the active tab belongs in the address — a view you cannot link to or reload back into is a view the user will lose.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="bordered" style="overflow:hidden">
  <div class="tabs" role="tablist">
    <button class="tab tab-active" role="tab" aria-selected="true">Queue</button>
    <button class="tab" role="tab" aria-selected="false">Runs</button>
    <button class="tab" role="tab" aria-selected="false">Chats <span class="chip chip-count">3</span></button>
  </div>
  <div style="padding:var(--space-4)" class="text-muted">Panel content</div>
</div>` },
    ],
    classes: [['.tabs','Scrolling tab strip','Bottom border'],
              ['.tab','44px tab','Transparent bottom border'],
              ['.tab-active','Accent underline','Pair with `aria-selected="true"`']],
    tokens: [['--tap-min','44px tab height.'],
             ['--color-accent','Active underline.'],
             ['--stroke-icon','1.5px underline weight.']],
    snippets: [
      ['Tabs', `<div class="tabs" role="tablist">
  <button class="tab tab-active" role="tab" aria-selected="true">Queue</button>
  <button class="tab" role="tab" aria-selected="false">Runs</button>
</div>`],
    ],
    dos: [['Put the active tab in the URL','`?tab=chats` survives reload and can be shared'],
          ['Use `role="tab"` and `aria-selected`','the underline alone is invisible to a screen reader'],
          ['Let the strip scroll horizontally','truncating tab labels hides what the tabs are']],
    donts: [['Use tabs to submit or act','tabs change what you see, never what exists'],
            ['Nest tab strips','the second level is a segmented control or a filter'],
            ['Ship more than about five tabs','beyond that it is navigation, not a view switch']],
  },
  {
    slug: 'breadcrumb', title: 'Breadcrumb',
    purpose: `Where you are, and the way back up. The last item is the current page and is never a link — a link that reloads the page you are on is a small betrayal of trust.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="#">Projects</a><span class="breadcrumb-sep">/</span>
  <a href="#">foldaidev</a><span class="breadcrumb-sep">/</span>
  <span class="breadcrumb-current" aria-current="page">run_8f21c4</span>
</nav>` },
    ],
    classes: [['.breadcrumb','Wrapping trail','12.5px muted'],
              ['.breadcrumb-sep','Slash separator','Border-strong color'],
              ['.breadcrumb-current','Current page','Not a link']],
    tokens: [['--fs-caption','12.5px trail.'],
             ['--color-ink-muted / --color-ink','Ancestors vs current.']],
    snippets: [
      ['Breadcrumb', `<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="/projects">Projects</a><span class="breadcrumb-sep">/</span>
  <span class="breadcrumb-current" aria-current="page">run_8f21c4</span>
</nav>`],
    ],
    dos: [['Mark the last item `aria-current="page"`','it is the only item that is not navigation'],
          ['Let it wrap at folded width','truncated ancestors defeat the purpose'],
          ['Use the run ID as the leaf','it is the thing the user can copy']],
    donts: [['Link the current page','it does nothing and looks broken'],
            ['Replace the trail with a back button','back is history, breadcrumbs are hierarchy'],
            ['Show more than three levels at folded width','collapse the middle instead']],
  },
  {
    slug: 'banner', title: 'Banner',
    purpose: `An in-flow, persistent statement of fact. A banner carries the fact itself — unlike a toast, which is allowed to disappear because the fact lives somewhere else.`,
    sections: [
      { id: 'variants', name: 'Variants', html: `
<div class="stack">
  <div class="banner banner-warn"><span class="banner-icon">!</span><div>
    <p class="banner-title">2 runs are waiting on you.</p>
    <p class="banner-body">Nothing merges until you decide.</p></div></div>
  <div class="banner banner-error"><span class="banner-icon">×</span><div>
    <p class="banner-title">This run failed at step 4 and stopped.</p>
    <p class="banner-body">Nothing was merged. Retry or discard it.</p></div></div>
  <div class="banner banner-success"><span class="banner-icon">✓</span><div>
    <p class="banner-title">Merged to main.</p></div></div>
  <div class="banner banner-info"><span class="banner-icon">i</span><div>
    <p class="banner-title">Workers pause while you review.</p>
    <p class="banner-body">Nothing changes underneath you mid-review.</p></div></div>
</div>` },
    ],
    classes: [['.banner','Base — 12px radius, in flow','Border by default'],
              ['.banner-icon','Leading glyph','Takes the status color'],
              ['.banner-title','Semibold first line','The fact'],
              ['.banner-body','Muted second line','The consequence'],
              ['.banner-success|warn|error|info','Soft background','Border becomes transparent']],
    tokens: [['--status-*-bg','Soft fill per status.'],
             ['--status-*','Icon color.'],
             ['--r-lg','12px corner.']],
    snippets: [
      ['Error banner', `<div class="banner banner-error">
  <span class="banner-icon">×</span>
  <div>
    <p class="banner-title">This run failed at step 4 and stopped.</p>
    <p class="banner-body">Nothing was merged. Retry or discard it.</p>
  </div>
</div>`],
    ],
    dos: [['Lead with what happened, follow with what it means','the second line is where the user finds their next move'],
          ['Say what was *not* affected on a failure','"Nothing was merged" is the sentence that lowers a pulse'],
          ['Keep banners in the flow','a floating banner is a toast with commitment issues']],
    donts: [['Use a banner for a transient confirmation','that is a toast'],
            ['Stack more than two banners','past two, none of them get read'],
            ['Add an exclamation mark','the color already carries the urgency']],
  },
  {
    slug: 'toast', title: 'Toast',
    purpose: `A transient acknowledgment with an optional escape hatch. The rule that keeps it honest: a toast is never the only copy of a fact — if it vanishes and the information is gone, it should have been a banner.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="stack-2">
  <div class="toast"><span class="toast-body">Run discarded.</span>
    <button class="button button-sm button-ghost toast-action">Undo</button></div>
  <div class="toast"><span class="toast-body">Approved. Merging to main.</span></div>
</div>` },
    ],
    classes: [['.toast','Floating strip, `--shadow-2`','Max 420px'],
              ['.toast-body','Message','Grows'],
              ['.toast-action','Trailing action','Usually Undo'],
              ['.toast-stack','Fixed container','Bottom centre, right from 768']],
    tokens: [['--shadow-2','Elevation.'],
             ['--dur-base','200ms entry.'],
             ['--r-lg','12px corner.']],
    snippets: [
      ['Toast with undo', `<div class="toast">
  <span class="toast-body">Run discarded.</span>
  <button class="button button-sm button-ghost toast-action">Undo</button>
</div>`],
    ],
    dos: [['Offer Undo for anything destructive','reversibility is a brand value, not a nicety'],
          ['Keep it to one line','a toast is read in passing or not at all'],
          ['Anchor toasts above the approval bar at folded width','never cover the decision the user is making']],
    donts: [['Put the only record of an error in a toast','use a banner, which stays'],
            ['Stack more than three','the fourth is invisible by the time it arrives'],
            ['Auto-dismiss a toast that has an action','the user needs time to reach Undo']],
  },
  {
    slug: 'empty', title: 'Empty state',
    purpose: `The live fact first, the absence second. "Nothing needs you right now" states only an absence; "4 runs working. Nothing to decide yet." tells the user the system is alive and their queue is genuinely clear.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="card"><div class="empty">
  <div class="empty-mark">▢</div>
  <p class="empty-title">4 runs working. Nothing to decide yet.</p>
  <p class="empty-body">We'll put anything that wants a decision right here.</p>
  <div class="empty-action"><button class="button">View All Runs</button></div>
</div></div>` },
      { id: 'first-run', name: 'First run', html: `
<div class="card"><div class="empty">
  <div class="empty-mark">▢</div>
  <p class="empty-title">No workers yet.</p>
  <p class="empty-body">Point one at a repository and it starts reading. You approve anything it wants to change.</p>
  <div class="empty-action"><button class="button button-primary">Start A Worker</button></div>
</div></div>` },
    ],
    classes: [['.empty','Centred column','`--space-8` vertical padding'],
              ['.empty-mark','Muted glyph or icon','Optional'],
              ['.empty-title','16px semibold','The fact'],
              ['.empty-body','Muted, ≤44ch','What will appear here'],
              ['.empty-action','Single action','Optional']],
    tokens: [['--space-8','64px breathing room — the one place the product goes airy.'],
             ['--color-ink-muted','Mark and body.']],
    snippets: [
      ['Queue clear', `<div class="empty">
  <p class="empty-title">4 runs working. Nothing to decide yet.</p>
  <p class="empty-body">We'll put anything that wants a decision right here.</p>
</div>`],
    ],
    dos: [['State a live fact before the absence','it tells the user the system is working, not broken'],
          ['Say what will appear here and when','an empty state is a promise about the future'],
          ['Offer at most one action','more than one means the screen is not actually empty']],
    donts: [['Write "Nothing needs you right now"','an absence alone is not information — this is the canonical bad line'],
            ['Use an illustration','this brand is not illustrative; a muted glyph is enough'],
            ['Apologize for the emptiness','a clear queue is the goal, not a failure']],
  },
  {
    slug: 'skeleton', title: 'Skeleton',
    purpose: `A placeholder shaped like the thing that's coming. If the skeleton doesn't match what lands, it's a lie the interface tells for half a second — and the layout shift that follows is the user's punishment for believing it.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="card"><div class="card-body">
  <div class="skeleton skeleton-title"></div>
  <div class="skeleton skeleton-line"></div>
  <div class="skeleton skeleton-line" style="width:78%"></div>
  <div class="skeleton skeleton-line" style="width:54%"></div>
</div></div>` },
      { id: 'rows', name: 'Row skeletons', html: `
<div class="card list">
  <div class="list-row"><div class="list-main"><div class="skeleton skeleton-line" style="width:52%"></div>
    <div class="skeleton skeleton-line" style="width:30%;height:9px"></div></div></div>
  <div class="list-row"><div class="list-main"><div class="skeleton skeleton-line" style="width:64%"></div>
    <div class="skeleton skeleton-line" style="width:26%;height:9px"></div></div></div>
</div>` },
    ],
    classes: [['.skeleton','Base — sunken fill with a sweep','One of two sanctioned loops'],
              ['.skeleton-line','12px line','Vary the width'],
              ['.skeleton-title','18px, 40% width','Heading placeholder'],
              ['.skeleton-row','44px block','Full row placeholder']],
    tokens: [['--color-sunken','Base fill.'],
             ['--ease-standard','Sweep curve.'],
             ['--r-sm','6px corner.']],
    snippets: [
      ['Loading card', `<div class="card"><div class="card-body">
  <div class="skeleton skeleton-title"></div>
  <div class="skeleton skeleton-line"></div>
  <div class="skeleton skeleton-line" style="width:78%"></div>
</div></div>`],
    ],
    dos: [['Match the skeleton to the real layout','no layout shift when the content lands'],
          ['Vary line widths','uniform bars read as a progress bar, not as text'],
          ['Use a count instead when you have one','"38 of 214" beats any animation']],
    donts: [['Show a skeleton for under ~300ms','a flash of placeholder is worse than a beat of nothing'],
            ['Use a spinner as well','pick one loading language per surface'],
            ['Skeleton a whole page','skeleton the region that is actually loading']],
  },
  {
    slug: 'list', title: 'List & row',
    purpose: `A scannable column of things to decide on. The whole row is the target — 44px tall with 12px padding, because the target grew and the row didn't.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="card list">
  <div class="list-group-label">Waiting on you</div>
  <a class="list-row list-row-interactive" href="#"><div class="list-main">
    <p class="list-title">Add rate limiting to /api/runs</p>
    <p class="list-meta">Wants a decision · <span class="text-mono">+142 −38 · 7 files</span></p></div>
    <span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span></a>
  <a class="list-row list-row-interactive list-row-selected" href="#"><div class="list-main">
    <p class="list-title">Migrate session store to D1</p>
    <p class="list-meta">Failed at step 4. Nothing merged. · <span class="text-mono">14:06</span></p></div>
    <span class="chip chip-error"><i class="chip-dot"></i>Failed</span></a>
  <div class="list-group-label">Working</div>
  <a class="list-row list-row-interactive" href="#"><div class="list-main">
    <p class="list-title">Backfill run timestamps</p>
    <p class="list-meta">Running tests · <span class="text-mono">38 of 214</span></p></div>
    <span class="chip chip-accent"><i class="chip-dot"></i>Running</span></a>
</div>` },
    ],
    classes: [['.list','Column container','No padding of its own'],
              ['.list-row','44px row, 12/16 padding','Bottom border except last'],
              ['.list-row-interactive','Hover and focus affordance','Use on `<a>` or `<button>`'],
              ['.list-row-selected','Tinted current row','Detail-pane selection'],
              ['.list-main','Growing text column','`min-width:0` for truncation'],
              ['.list-title','14.5px, truncates','One line'],
              ['.list-meta','12.5px muted','Second line'],
              ['.list-group-label','Mono uppercase divider','Section heading']],
    tokens: [['--row-height','44px minimum.'],
             ['--color-accent-tint','Selected row.'],
             ['--color-sunken','Hover fill.']],
    snippets: [
      ['Interactive row', `<a class="list-row list-row-interactive" href="/runs/8f21c4">
  <div class="list-main">
    <p class="list-title">Add rate limiting to /api/runs</p>
    <p class="list-meta">Wants a decision · <span class="text-mono">+142 −38</span></p>
  </div>
  <span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span>
</a>`],
    ],
    dos: [['Make the whole row the link','a 44px row with a 20px hit area wastes the row'],
          ['Group rows with `.list-group-label`','"Waiting on you" is the most useful heading in the product'],
          ['Put the machine facts in mono on the meta line','they are scannable exactly because they look different']],
    donts: [['Put row actions behind hover','they do not exist on the device this product is named for'],
            ['Let the title wrap to three lines','truncate; the detail pane has the full text'],
            ['Use a list where a table is right','if you need aligned columns, use the table']],
  },
  {
    slug: 'tree', title: 'Tree',
    purpose: `A hierarchy that belongs to the data — a worktree's files, a scope, a set of nested groups. A branch is a \`<details>\`, so it collapses with no script at all; a tree that needs JavaScript to open is a tree that shows one row when the script fails.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<ul class="tree card" style="padding:8px">
  <li class="tree-branch"><details open>
    <summary class="tree-row"><span class="tree-twist">›</span><span class="tree-mark">▪</span>
      <span class="tree-name">src/api</span><span class="tree-meta">3 changed</span></summary>
    <ul class="tree-children">
      <li><a class="tree-row" href="#"><span class="tree-mark">▫</span>
        <span class="tree-name">runs.ts</span><span class="tree-meta">+142 −38</span></a></li>
      <li><a class="tree-row tree-row-selected" href="#"><span class="tree-mark">▫</span>
        <span class="tree-name">limiter.ts</span><span class="tree-meta">+64 −0</span></a></li>
    </ul>
  </details></li>
  <li class="tree-branch"><details>
    <summary class="tree-row"><span class="tree-twist">›</span><span class="tree-mark">▪</span>
      <span class="tree-name">src/db</span><span class="tree-meta">unchanged</span></summary>
    <ul class="tree-children">
      <li><a class="tree-row" href="#"><span class="tree-mark">▫</span>
        <span class="tree-name">schema.sql</span></a></li>
    </ul>
  </details></li>
</ul>
<p class="text-muted">The second branch is collapsed. Both rows are 44px, and both open from the keyboard —
that is the <code>&lt;details&gt;</code>, not a handler.</p>` },
    ],
    classes: [['.tree','The root list','`<ul>`, no list marker, no padding of its own'],
              ['.tree-branch','One node that has children','Wraps a `<details>` — `[open]` is the `<details>`\'s'],
              ['.tree-row','44px row — `<summary>`, `<a>` or `<div>`','The whole width is the target'],
              ['.tree-twist','The disclosure chevron','Rotates on `[open]`; the only marker'],
              ['.tree-mark','Leading icon slot','Muted, never the only signal'],
              ['.tree-name','The name — one line, truncated','`min-width:0`'],
              ['.tree-meta','Trailing fact','Pushed to the far end'],
              ['.tree-children','The nested list','12px step and a guide rule'],
              ['.tree-row-selected','The row you are on','`--color-accent-tint`']],
    tokens: [['--row-height','44px at every level, folded included.'],
             ['--space-3 / --space-4','The one indent step and the rule offset.'],
             ['--color-border','The guide rule that carries depth.'],
             ['--color-accent-tint','The selected row.'],
             ['--dur-fast / --ease-standard','120ms twist.']],
    snippets: [
      ['A branch', `<li class="tree-branch"><details open>
  <summary class="tree-row"><span class="tree-twist">›</span><span class="tree-name">src/api</span></summary>
  <ul class="tree-children">…</ul>
</details></li>`],
      ['A leaf', `<li><a class="tree-row" href="#"><span class="tree-name">runs.ts</span></a></li>`],
    ],
    dos: [['Keep the indent at one 12px step per level','depth is the guide rule\'s job; at 24px a six-deep path leaves a folded screen no room for the name'],
          ['Use `<details>` for a branch','it collapses, it announces expanded/collapsed, and it needs no script'],
          ['Truncate the name and keep the row 44px','the full path belongs in the detail view, not in three wrapped lines']],
    donts: [['Use a tree because the layout looks nested','if the nesting is not the data\'s, this is the wrong component'],
            ['Hide a row\'s only action behind hover','the device this product is named for has no hover'],
            ['Indent by margin on the row itself','the target stops starting at the left edge, and depth eats the name']],
  },
  {
    slug: 'table', title: 'Table',
    purpose: `Aligned columns for comparing runs. Below 768px a table is not a table — it stacks into rows, because horizontal scroll on a phone is a defeat, not a fallback. **The 768 is its \`.table-wrap\`, not the window**: a five-column table in a 660px pane inside a 933px window has to stack too, and a media query cannot see that.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="table-wrap card">
  <table class="table table-stack">
    <thead><tr><th>Run</th><th>Worker</th><th>Changed</th><th>Status</th><th>Started</th></tr></thead>
    <tbody>
      <tr><td data-label="Run">Add rate limiting</td><td data-label="Worker">opus-1</td>
        <td data-label="Changed" class="table-mono">+142 −38</td>
        <td data-label="Status"><span class="chip chip-warn"><i class="chip-dot"></i>Waiting</span></td>
        <td data-label="Started" class="table-num">14:06</td></tr>
      <tr><td data-label="Run">Migrate session store</td><td data-label="Worker">opus-2</td>
        <td data-label="Changed" class="table-mono">+18 −204</td>
        <td data-label="Status"><span class="chip chip-error"><i class="chip-dot"></i>Failed</span></td>
        <td data-label="Started" class="table-num">13:48</td></tr>
      <tr><td data-label="Run">Backfill timestamps</td><td data-label="Worker">opus-3</td>
        <td data-label="Changed" class="table-mono">+7 −0</td>
        <td data-label="Status"><span class="chip chip-accent"><i class="chip-dot"></i>Running</span></td>
        <td data-label="Started" class="table-num">13:31</td></tr>
    </tbody>
  </table>
</div>
<p class="text-muted">Narrow this page below 768px and the same table becomes stacked rows, labelled from
<code>data-label</code>.</p>` },
    ],
    classes: [['.table-wrap','Scroll container **and** query container','Required around `.table-stack`'],
              ['.table','Base table','Mono uppercase headers'],
              ['.table-stack','Collapses below 768 **of its wrapper**','Requires `data-label` on every cell'],
              ['.table-num','Right-aligned tabular','Numbers and times'],
              ['.table-mono','Mono cell','Diffs, IDs, paths']],
    tokens: [['--fs-micro','Header size.'],
             ['--color-sunken','Row hover.'],
             ['--bp-unfolded','768px — where it stacks.']],
    snippets: [
      ['Stacking table', `<div class="table-wrap">
  <table class="table table-stack">
    <thead><tr><th>Run</th><th>Changed</th></tr></thead>
    <tbody>
      <tr><td data-label="Run">Add rate limiting</td>
          <td data-label="Changed" class="table-mono">+142 −38</td></tr>
    </tbody>
  </table>
</div>`],
    ],
    dos: [['Add `data-label` to every cell','it becomes the label when the table stacks'],
          ['Wrap every `.table-stack` in a `.table-wrap`','the wrapper is the box the stack rule measures'],
          ['Right-align numbers with `.table-num`','a ragged numeric column cannot be compared'],
          ['Keep status as a chip inside the cell','the same status language as everywhere else']],
    donts: [['Scroll a table horizontally on a phone','stack it — that is what `.table-stack` is for'],
            ['Ship a `.table-stack` with no `.table-wrap`','it falls back to the window and unstacks inside a narrow pane'],
            ['Let a `.table-wrap` size itself from its table','it is a query container, so it has no intrinsic width: as a `flex: none` item it measures 0px and vanishes. Give it `flex: 1`, a grid `1fr`, or `width: 100%`'],
            ['Ship more than five columns','the sixth is never read; put it in the detail view'],
            ['Use a table for a single-column list','that is a list']],
  },
  {
    slug: 'filterbar', title: 'Filter bar',
    purpose: `What a set is narrowed by, what it is ordered by, and how many it is showing — one bar, because those three facts are read together or not at all. A count sitting anywhere else eventually reads 5 while three rows are hidden, and nobody notices.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="card">
  <div class="filterbar">
    <div class="filterbar-filters">
      <button class="filterbar-filter filterbar-filter-on" aria-haspopup="listbox">Project
        <span class="filterbar-value">fold-ai-dev</span></button>
      <button class="filterbar-filter" aria-haspopup="listbox">State
        <span class="filterbar-value">any</span></button>
      <button class="filterbar-filter" aria-haspopup="listbox">Node
        <span class="filterbar-value">any</span></button>
      <button class="filterbar-order" aria-haspopup="listbox">Oldest first</button>
    </div>
    <p class="filterbar-count">7 of 24 <span class="visually-hidden">worktrees shown</span></p>
  </div>
  <div class="list">
    <div class="list-row"><div class="list-main"><p class="list-title">Add rate limiting to /api/runs</p></div></div>
    <div class="list-row"><div class="list-main"><p class="list-title">Migrate session store to D1</p></div></div>
  </div>
</div>
<p class="text-muted">The set filter says its value in words. The tint is the cheap half — the label is the half that
survives a colorblind reader and a phone in sunlight.</p>` },
    ],
    classes: [['.filterbar','The bar — wraps, sits on `--color-sunken`','Above the set it governs'],
              ['.filterbar-filters','The controls, at the near end','Wrapping cluster'],
              ['.filterbar-filter','One axis — 44px, 8px radius','A `<button>`; `aria-haspopup` when it opens a list'],
              ['.filterbar-filter-on','Set','Tint, and the value in the label'],
              ['.filterbar-value','The value inside the label','Muted until the filter is set'],
              ['.filterbar-order','The sort control','Same control, one per bar'],
              ['.filterbar-count','How many are showing','Far end; answers to the filters']],
    tokens: [['--control-md','44px — a filter bar is a touch surface, so `.button-sm` is not allowed here.'],
             ['--r-md','8px. Status is round; a filter is an action.'],
             ['--color-sunken','The bar\'s ground.'],
             ['--color-border-strong','The 3:1 control border.'],
             ['--color-accent / --color-accent-tint','A set filter.']],
    snippets: [
      ['A filter', `<button class="filterbar-filter" aria-haspopup="listbox">State <span class="filterbar-value">any</span></button>`],
      ['Set', `<button class="filterbar-filter filterbar-filter-on" aria-haspopup="listbox">Project <span class="filterbar-value">fold-ai-dev</span></button>`],
      ['The count', `<p class="filterbar-count">7 of 24 <span class="visually-hidden">worktrees shown</span></p>`],
    ],
    dos: [['Keep the count in the bar','a badge reading 5 while three rows are filtered out is a lie, and this is the only placement that catches it'],
          ['Say the set value in the label','the tint is hue, and hue is never the signal'],
          ['Keep every control 44px','this bar is the first thing a thumb reaches on a folded screen']],
    donts: [['Draw a filter as a chip','a chip is something you read; a filter is something you press'],
            ['Use `.button-sm` to fit more filters in','wrap instead — the bar is built to'],
            ['Ship a second sort control','one order per set, or the set has two orders and neither is true']],
  },
  {
    slug: 'meter', title: 'Meter',
    purpose: `A measured number against what bounds it — 31 GB free of 48 GB allocated, on a 64 GB machine. Number first, bar second, and never a bar alone: a bar answers "roughly how full" and refuses "how much", which is the question the person placing a worktree is actually asking.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="stack" style="max-width:320px">
  <div class="meter">
    <p class="meter-head"><span class="meter-label">Free</span>
      <span class="meter-value">31 GB<span class="meter-of"> of 48 GB allocated</span></span></p>
    <div class="meter-track" aria-hidden="true"><span class="meter-fill" style="width:65%"></span></div>
    <p class="meter-context">64 GB machine</p>
  </div>
  <div class="meter">
    <p class="meter-head"><span class="meter-label">Usage</span>
      <span class="meter-value">184<span class="meter-of"> of 200 turns</span></span></p>
    <div class="meter-track" aria-hidden="true"><span class="meter-fill" style="width:92%"></span></div>
    <p class="meter-context">Resets in 3h · <span class="chip chip-warn"><i class="chip-dot"></i>Near limit</span></p>
  </div>
</div>` },
      { id: 'ghost', name: 'No value yet', html: `
<div class="meter meter-ghost" style="max-width:320px">
  <p class="meter-head"><span class="meter-label">Disk</span>
    <span class="meter-value text-muted">— of — allocated</span></p>
  <div class="meter-track" aria-hidden="true"></div>
</div>
<p class="text-muted">A measure the surface states and this rendering has no number for. Dashed, because a solid empty
track reads as zero — and zero is a measurement.</p>` },
    ],
    classes: [['.meter','The block — number, bar, context','Column, `min-width:0`'],
              ['.meter-head','Label and value on one line','Wraps at narrow widths'],
              ['.meter-label','What is being measured','12.5px medium'],
              ['.meter-value','The number','Mono, tabular numerals'],
              ['.meter-of','The denominator inside the value','Muted — it is the bound, not the fact'],
              ['.meter-track','The bar','6px, 3:1 border, `--r-full`'],
              ['.meter-fill','The measured part','Inline `width:` — the only inline style this system asks for'],
              ['.meter-context','The third term','`64 GB machine` — not the denominator'],
              ['.meter-ghost','No value yet','Dashed track, no fill']],
    tokens: [['--color-border-strong','The track border — a graphical object needs 3:1, not the divider value.'],
             ['--color-sunken','The empty part of the track.'],
             ['--color-accent','The fill.'],
             ['--r-full','Both ends of the track.'],
             ['--fs-mono','The number.']],
    snippets: [
      ['A meter', `<div class="meter">
  <p class="meter-head"><span class="meter-label">Free</span>
    <span class="meter-value">31 GB<span class="meter-of"> of 48 GB allocated</span></span></p>
  <div class="meter-track" aria-hidden="true"><span class="meter-fill" style="width:65%"></span></div>
  <p class="meter-context">64 GB machine</p>
</div>`],
      ['No value yet', `<div class="meter meter-ghost">…<div class="meter-track" aria-hidden="true"></div></div>`],
    ],
    dos: [['State the number','the bar is the shape of a fact, never the fact'],
          ['Keep the third term separate from the denominator','a full allocation and a full machine are different problems'],
          ['Leave the track `aria-hidden`','the number above it is already the accessible value; the bar would say it twice']],
    donts: [['Ship a bar with no number','it answers "roughly" to a question asked in gigabytes'],
            ['Ship a bar with no denominator','a track with no whole behind it is a picture of nothing — state the number and stop'],
            ['Colour the fill to mean a status on its own','pair it with the word, per Accessibility'],
            ['Animate the fill on load','nothing drifts or pulses but the live-run indicator']],
  },
  {
    slug: 'overlay', title: 'Modal, sheet & popover',
    purpose: `Three ways to put something on top. At folded width a modal becomes a bottom sheet, so the decision arrives inside the thumb arc rather than in the middle of a screen nobody can reach one-handed.`,
    sections: [
      { id: 'modal', name: 'Modal', html: `
<div class="modal modal-static">
  <div class="modal-head"><h3 class="modal-title">Discard this run?</h3></div>
  <div class="modal-body">The worker's 7 changed files go away. Nothing was merged, so nothing else changes.</div>
  <div class="modal-foot"><button class="button button-destructive">Discard Run</button>
    <span class="approvalbar-spacer"></span><button class="button button-ghost">Cancel</button></div>
</div>` },
      { id: 'sheet', name: 'Sheet', html: `
<div class="sheet sheet-static">
  <div class="sheet-grip"></div>
  <h4 class="text-heading-s">Filter queue</h4>
  <div class="stack-2" style="margin-top:var(--space-3)">
    <label class="toggle"><input type="checkbox" checked><span class="toggle-box">✓</span>Only waiting on me</label>
    <label class="toggle"><input type="checkbox"><span class="toggle-box">✓</span>Include finished runs</label>
  </div>
</div>` },
      { id: 'popover', name: 'Popover', html: `
<div class="popover" style="max-width:240px">
  <a class="popover-item" href="#">Open in editor</a>
  <a class="popover-item" href="#">Copy run ID</a>
  <div class="popover-sep"></div>
  <a class="popover-item text-error" href="#">Discard run</a>
</div>` },
    ],
    classes: [['.scrim','Fixed dim layer','Click closes'],
              ['.modal','Centred dialog, ≤520px','`--shadow-3`'],
              ['.modal-head / -title / -body / -foot','Dialog parts','Foot holds actions'],
              ['.sheet','Bottom sheet, ≤85vh','Folded-width modal'],
              ['.sheet-grip','Drag handle','Affordance only'],
              ['.popover','Anchored menu','`--shadow-2`'],
              ['.popover-item','44px menu row','Never the only path'],
              ['.popover-sep','Divider','Before destructive items']],
    tokens: [['--r-xl','16px — sheets and modals.'],
             ['--shadow-2 / -3','Popover / modal.'],
             ['--dur-base','200ms entry.']],
    snippets: [
      ['Confirm modal', `<div class="modal">
  <div class="modal-head"><h3 class="modal-title">Discard this run?</h3></div>
  <div class="modal-body">The worker's 7 changed files go away. Nothing was merged, so nothing else changes.</div>
  <div class="modal-foot">
    <button class="button button-destructive">Discard Run</button>
    <span class="approvalbar-spacer"></span>
    <button class="button button-ghost">Cancel</button>
  </div>
</div>`],
    ],
    dos: [['State what goes away and what does not','the second half is what makes the decision easy'],
          ['Use a sheet instead of a modal at folded width','the thumb cannot reach a centred dialog'],
          ['Separate destructive popover items with a divider','distance prevents mis-taps']],
    donts: [['Put the only path to an action in a popover','hidden actions do not exist on touch'],
            ['Stack a modal on a modal','close the first; the user has lost the thread by then'],
            ['Ask "Are you sure?"','say what will happen instead']],
  },
  {
    slug: 'tooltip', title: 'Tooltip',
    purpose: `One sentence behind a term or a figure, for the user who wants it defined once. It opens on hover and on keyboard focus, and it is never the only place a fact lives — a touch user may never open it, so anything a decision depends on goes in the row or on the control instead.`,
    sections: [
      { id: 'term', name: 'On a term', html: `
<p class="text-caption text-muted" style="padding-top:var(--space-7)">Sorted by
  <span class="tip tip-static" tabindex="0" aria-describedby="tip-demo-1">free memory<span class="tip-bubble" role="tooltip" id="tip-demo-1">Inside this machine's share, latest reading.</span></span>,
  most first.</p>` },
      { id: 'figure', name: 'On a figure', html: `
<p class="text-body" style="padding-top:var(--space-7)"><span class="tip" tabindex="0" aria-describedby="tip-demo-2"><span class="text-num">3.2 GB</span><span class="tip-bubble" role="tooltip" id="tip-demo-2">Free of an 8 GB share. Read 40s ago.</span></span> free</p>` },
    ],
    classes: [['.tip','The trigger — the term itself, dotted underline','`tabindex="0"` and `aria-describedby`'],
              ['.tip-bubble','The sentence, above the trigger','`role="tooltip"`; ≤32ch'],
              ['.tip-start|end','Anchor the bubble to the trigger\'s start or end edge','From 768px; under it every bubble is a strip above the bottom bar'],
              ['.tip-static','Demo helper — bubble held open','Documentation only']],
    tokens: [['--color-ink / --color-bg','Inverted bubble, so it reads over any surface in either theme.'],
             ['--fs-caption','12.5px sentence.'],
             ['--dur-fast','120ms open.'],
             ['--shadow-2','Lift off the page.']],
    snippets: [
      ['Term with a tooltip', `<span class="tip" tabindex="0" aria-describedby="t-free">free memory<span class="tip-bubble" role="tooltip" id="t-free">Inside this machine's share, latest reading.</span></span>`],
    ],
    dos: [['Keep it to one sentence','a second sentence is a paragraph that found a hiding place'],
          ['Use `.tip-start` or `.tip-end` on a trigger in a first or last column','a centred bubble on an edge chip is clipped at phone width'],
          ['Put the trigger on the term, not on an icon','the word is what the user is unsure of'],
          ['Give the trigger `tabindex="0"` and `aria-describedby`','a tooltip only a mouse can open is a tooltip half the users never see']],
    donts: [['Make a tooltip the only place a fact lives','touch users may never open it; put the fact in the row or on the control'],
            ['Put a control\'s reason in a tooltip','a disabled control carries its own reason'],
            ['Explain why the product behaves as it does','the tooltip defines a term; it does not argue']],
  },
  {
    slug: 'timeline', title: 'Run timeline',
    purpose: `A stepped record of what a worker actually did. Every step states what happened; a failure states where it stopped and what it did *not* touch — which is the sentence that tells a user whether to panic.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="card"><div class="card-body">
  <div class="timeline">
    <div class="timeline-step timeline-done"><div class="timeline-marker">✓</div><div>
      <p class="timeline-title">Read the spec and the touched files</p>
      <p class="timeline-meta">14:06 · 4 files</p></div></div>
    <div class="timeline-step timeline-done"><div class="timeline-marker">✓</div><div>
      <p class="timeline-title">Wrote the rate limiter</p>
      <p class="timeline-meta">14:09 · +142 −38</p></div></div>
    <div class="timeline-step timeline-running"><div class="timeline-marker"></div><div>
      <p class="timeline-title">Running tests</p>
      <p class="timeline-meta">14:12 · 38 of 214</p></div></div>
    <div class="timeline-step timeline-waiting"><div class="timeline-marker">?</div><div>
      <p class="timeline-title">Wants a decision</p>
      <p class="timeline-meta">Blocked until you review</p></div></div>
    <div class="timeline-step timeline-failed"><div class="timeline-marker">×</div><div>
      <p class="timeline-title">Failed at step 4 and stopped</p>
      <p class="timeline-meta">14:14</p>
      <p class="timeline-body">Nothing was merged. The branch is untouched.</p></div></div>
  </div>
</div></div>` },
    ],
    classes: [['.timeline','Stepped column','Connector drawn per step'],
              ['.timeline-step','One step','Grid: marker + content'],
              ['.timeline-marker','18px status marker','Colored by state class'],
              ['.timeline-title','What happened','14.5px medium'],
              ['.timeline-meta','Time and counts','Mono'],
              ['.timeline-body','Consequence','Only when there is one'],
              ['.timeline-done|running|waiting|failed','State','`running` carries the one live pulse']],
    tokens: [['--status-success|warn|error','Marker colors.'],
             ['--color-accent','Running marker and pulse.'],
             ['--color-border','Connector line.']],
    snippets: [
      ['Failed step', `<div class="timeline-step timeline-failed">
  <div class="timeline-marker">×</div>
  <div>
    <p class="timeline-title">Failed at step 4 and stopped</p>
    <p class="timeline-meta">14:14</p>
    <p class="timeline-body">Nothing was merged. The branch is untouched.</p>
  </div>
</div>`],
    ],
    dos: [['Say what a failure did not touch','it is the difference between a scare and a fact'],
          ['Show a count while work is running','"38 of 214" is worth more than any spinner'],
          ['Keep step titles in past tense for finished work','the timeline is a record, not a plan']],
    donts: [['Animate more than the running marker','the timeline is read, not watched'],
            ['Hide completed steps','the record is the point'],
            ['Use the timeline for chat','tool calls belong in the thread']],
  },
  {
    slug: 'diff', title: 'Diff viewer',
    purpose: `The core review act. Unified when folded, side-by-side when unfolded — and added and removed lines carry a gutter sign as well as a color, because the one screen where color blindness must not cost you anything is the one where you approve a change.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="diff">
  <div class="diff-file"><span>src/api/runs.ts</span>
    <span class="diff-stat-add">+4</span><span class="diff-stat-del">−1</span></div>
  <div class="diff-hunk">@@ -18,6 +18,9 @@</div>
  <div class="diff-line"><span class="diff-gutter">18</span><span>export async function createRun(req: Request) {</span></div>
  <div class="diff-line diff-del"><span class="diff-gutter">19</span><span>  const body = await req.json();</span></div>
  <div class="diff-line diff-add"><span class="diff-gutter">19</span><span>  const ok = await limiter.take(req.ip);</span></div>
  <div class="diff-line diff-add"><span class="diff-gutter">20</span><span>  if (!ok) return new Response("slow down", { status: 429 });</span></div>
  <div class="diff-line diff-add"><span class="diff-gutter">21</span><span>  const body = await req.json();</span></div>
  <div class="diff-line"><span class="diff-gutter">22</span><span>}</span></div>
</div>` },
    ],
    classes: [['.diff','Base — 6px radius, mono','Clips its rows; the query container for `.diff-split`'],
              ['.diff-file','File header with stats','Sunken strip'],
              ['.diff-stat-add / -del','+n / −n','Status colors'],
              ['.diff-hunk','Hunk marker row','Muted'],
              ['.diff-line','Gutter + code row','Wraps rather than scrolls'],
              ['.diff-gutter','Line number and sign','Not selectable'],
              ['.diff-add / .diff-del','Added / removed','Background + gutter sign'],
              ['.diff-split','Two columns from 768 **of its `.diff`**','Unified below that, and with no `.diff` around it']],
    tokens: [['--diff-add-bg / --diff-add-ink','Added line, per theme.'],
             ['--diff-del-bg / --diff-del-ink','Removed line.'],
             ['--diff-gutter','Gutter background.'],
             ['--font-mono / --fs-mono','12.5px mono.']],
    snippets: [
      ['Added line', `<div class="diff-line diff-add">
  <span class="diff-gutter">19</span>
  <span>  const ok = await limiter.take(req.ip);</span>
</div>`],
    ],
    dos: [['Keep the +/− sign in the gutter','color alone fails the exact user who most needs the review to work'],
          ['Wrap long lines at folded width','horizontal scroll inside a diff makes review impossible one-handed'],
          ['Show the file path and the stat together','the header answers "how big is this?" before you read a line']],
    donts: [['Use side-by-side below 768px','two 40-character columns are unreadable'],
            ['Put a `.diff-split` outside a `.diff`','it has no container to measure and stays unified forever'],
            ['Put a `.diff` in a grid `auto` track or set it `inline-block`','it is a query container, so it has no intrinsic width and measures 2px — its own borders — rather than its widest line'],
            ['Syntax-highlight in brand colors','the accent means "action"; a keyword is not an action'],
            ['Collapse context to zero lines','a diff without context is not reviewable']],
  },
  {
    slug: 'approvalbar', title: 'Approval bar',
    purpose: `The persistent decision affordance — where Approve, Review, and Discard live. It pins to the bottom at folded width, inside the thumb arc, and destructive keeps its distance from primary so one mis-tap never throws away a run.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="card"><div class="approvalbar">
  <p class="approvalbar-summary">7 files · <span class="text-mono">+142 −38</span> · tests passed</p>
  <button class="button button-primary">Approve</button>
  <button class="button">Review Changes</button>
  <span class="approvalbar-spacer"></span>
  <button class="button button-destructive">Discard Run</button>
</div></div>` },
      { id: 'blocked', name: 'When it can\'t be approved', html: `
<div class="card"><div class="approvalbar">
  <p class="approvalbar-summary text-error">Failed at step 4. Nothing was merged.</p>
  <button class="button button-primary" disabled>Approve</button>
  <button class="button">View Log</button>
  <span class="approvalbar-spacer"></span>
  <button class="button button-destructive">Discard Run</button>
</div></div>` },
    ],
    classes: [['.approvalbar','Sticky bottom bar','Static from 768 **of its `.pane`**'],
              ['.approvalbar-summary','What is being decided','Full width at folded'],
              ['.approvalbar-spacer','Pushes destructive away','Structural, not decorative'],
              ['.pane','The review pane around it','Supplies the box the bar measures']],
    tokens: [['--shadow-2','Lift at folded width; removed on desktop.'],
             ['--bp-unfolded','768px — where it stops being sticky.'],
             ['--control-md','44px actions.']],
    snippets: [
      ['Approval bar in its pane', `<div class="pane">
  <!-- what is being reviewed -->
  <div class="approvalbar">
    <p class="approvalbar-summary">7 files · +142 −38 · tests passed</p>
    <button class="button button-primary">Approve</button>
    <button class="button">Review Changes</button>
    <span class="approvalbar-spacer"></span>
    <button class="button button-destructive">Discard Run</button>
  </div>
</div>`],
    ],
    dos: [['Summarise what is being approved','nobody should have to scroll up to remember'],
          ['Keep the spacer between primary and destructive','the gap is the safety mechanism'],
          ['Put the bar in a `.pane`','it measures the pane, so a bar in a 600px pane stays pinned inside a wide window'],
          ['Disable Approve when approval is impossible','and say why in the summary']],
    donts: [['Put Discard next to Approve','they are the two ends of the decision, not neighbours'],
            ['Hide the bar on scroll','the decision is the reason the screen exists'],
            ['Use it for navigation','it decides; it does not move you']],
  },
  {
    slug: 'chat', title: 'Chat thread',
    purpose: `The conversation with a worker: your turns, its turns, and the tools it ran. Tool turns are mono and visually quieter than either speaker — they're evidence, not dialogue.`,
    sections: [
      { id: 'anatomy', name: 'Anatomy', html: `
<div class="thread">
  <div class="message message-user"><div class="message-head"><span class="message-author">You</span><span>14:02</span></div>
    <div class="message-body"><p>Add rate limiting to the runs endpoint. Don't touch the session store.</p></div></div>
  <div class="message"><div class="message-head"><span class="message-author">opus-1</span><span>14:06</span></div>
    <div class="message-body"><p>I'll add a token bucket keyed by IP and return 429 past the limit. Tests first — I'll leave the session store alone.</p></div></div>
  <div class="message message-tool"><div class="message-head"><span class="message-author">Tool</span><span>14:07</span></div>
    <div class="message-body">read src/api/runs.ts · 214 lines</div></div>
  <div class="message message-tool"><div class="message-head"><span class="message-author">Tool</span><span>14:09</span></div>
    <div class="message-body">write src/api/limiter.ts · +142 −38</div></div>
  <div class="message"><div class="message-head"><span class="message-author">opus-1</span><span>14:12</span></div>
    <div class="message-body"><p>Tests pass. 7 files changed. Nothing merged — it's waiting on you.</p></div></div>
</div>` },
    ],
    classes: [['.thread','Message column','`--space-4` gap'],
              ['.message','One turn, ≤72ch','Column of head + body'],
              ['.message-head','Author and time','Muted caption'],
              ['.message-author','Author name','Ink, semibold'],
              ['.message-body','The turn itself','Bordered surface'],
              ['.message-user','Right-aligned, tinted','Your turns'],
              ['.message-tool','Mono, sunken','Evidence, not dialogue']],
    tokens: [['--color-accent-tint','User turn background.'],
             ['--color-sunken','Tool turn background.'],
             ['--measure','72ch turn width.'],
             ['--font-mono','Tool turns.']],
    snippets: [
      ['Tool turn', `<div class="message message-tool">
  <div class="message-head"><span class="message-author">Tool</span><span>14:07</span></div>
  <div class="message-body">read src/api/runs.ts · 214 lines</div>
</div>`],
    ],
    dos: [['Keep tool turns quieter than speech','they are evidence the user skims, not prose they read'],
          ['Name the worker','"opus-1" is accountable; "Assistant" is not'],
          ['End a turn with the state it left behind','"Nothing merged — it\'s waiting on you"']],
    donts: [['Let a turn exceed 72ch','past the measure the eye loses the line'],
            ['Style tool output as speech','it implies the worker said it rather than did it'],
            ['Hide tool turns by default','the record of what was actually run is the trust mechanism']],
  },
];
