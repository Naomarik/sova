/**
 * The base styles of a view's document in the sealed box (§chat.transcript-cards/sealed-box, "Sova's
 * look"): Sova's typography and its native controls (buttons, text fields, selects, checkboxes,
 * radios, sliders) drawn on the theme's tokens, which the page sends with each load. No control is
 * left to the browser's own look, so a view that writes plain `<input type="range">` or `<select>`
 * gets Sova's. Nothing here loads anything: the box's policy refuses every request, so the select's
 * caret and the check marks are drawn with CSS alone. DOM-free (imported by its unit test).
 */
// The view's color-scheme stays `normal`, as its frames' do: a frame whose document's scheme differs
// from its element's gets an opaque backdrop, never the card's own background.
export const CARD_VIEW_BASE_CSS = [
  `html{-webkit-text-size-adjust:100%;color-scheme:normal}`,
  `html,body{margin:0;padding:0;background:transparent}`,
  `body{color:var(--color-ink);font-family:var(--font-body),system-ui,sans-serif;font-size:var(--fs-body,14px);line-height:var(--lh-body,1.5);-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}`,
  `h1,h2,h3,h4{font-family:var(--font-display),system-ui,sans-serif;margin:0 0 var(--space-2,8px)}`,
  `p{margin:0 0 var(--space-2,8px)}`,
  `code,pre{font-family:var(--font-mono),ui-monospace,monospace;font-size:var(--fs-mono,13px)}`,
  // Buttons, as Sova's small secondary button.
  `button{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2,8px);min-height:var(--control-sm,36px);padding:0 var(--space-3,12px);border:var(--stroke-icon,1.5px) solid var(--color-border-strong);border-radius:var(--r-md,8px);background:var(--color-surface);color:var(--color-ink);font:inherit;font-weight:var(--fw-medium,500);cursor:pointer}`,
  `button:hover{border-color:var(--color-accent)}`,
  `button:disabled{opacity:.42;cursor:default}`,
  // Text fields and selects, as Sova's input and select.
  `input,select,textarea{box-sizing:border-box;font:inherit;color:var(--color-ink);background:var(--color-surface);border:var(--stroke-icon,1.5px) solid var(--color-border-strong);border-radius:var(--r-md,8px);padding:0 var(--space-3,12px);min-height:var(--control-sm,36px);accent-color:var(--color-accent)}`,
  `textarea{padding:var(--space-2,8px) var(--space-3,12px);min-height:calc(var(--control-sm,36px) * 2)}`,
  `input::placeholder,textarea::placeholder{color:var(--color-ink-muted)}`,
  `input:hover,select:hover,textarea:hover{border-color:var(--color-ink-muted)}`,
  `input:disabled,select:disabled,textarea:disabled{opacity:.42;cursor:not-allowed}`,
  `select{appearance:none;-webkit-appearance:none;padding-right:var(--space-6,32px);cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--color-ink-muted) 50%),linear-gradient(135deg,var(--color-ink-muted) 50%,transparent 50%);background-position:calc(100% - 17px) 50%,calc(100% - 12px) 50%;background-size:5px 5px;background-repeat:no-repeat}`,
  `option{background:var(--color-surface);color:var(--color-ink)}`,
  // Checkboxes and radios, as Sova's toggle box.
  `input[type=checkbox],input[type=radio]{appearance:none;-webkit-appearance:none;display:inline-grid;place-content:center;width:18px;height:18px;min-height:0;margin:0 var(--space-2,8px) 0 0;padding:0;vertical-align:-3px;border-radius:var(--r-xs,4px);background:var(--color-surface);cursor:pointer}`,
  `input[type=radio]{border-radius:var(--r-full,999px)}`,
  `input[type=checkbox]:checked,input[type=radio]:checked{background:var(--color-accent);border-color:var(--color-accent)}`,
  `input[type=checkbox]:checked::before{content:"";width:5px;height:9px;margin-top:-2px;border:solid var(--color-on-accent);border-width:0 2px 2px 0;transform:rotate(45deg)}`,
  `input[type=radio]:checked::before{content:"";width:8px;height:8px;border-radius:var(--r-full,999px);background:var(--color-on-accent)}`,
  // Sliders: a sunken track with the control's ring, the filled part and the knob in the accent.
  `input[type=range]{appearance:none;-webkit-appearance:none;height:var(--control-sm,36px);min-height:0;padding:0;border:0;border-radius:0;background:transparent;cursor:pointer;vertical-align:middle}`,
  `input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:var(--r-full,999px);background:var(--color-sunken);box-shadow:inset 0 0 0 var(--stroke-icon,1.5px) var(--color-border-strong)}`,
  `input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;margin-top:-6px;border:2px solid var(--color-surface);border-radius:var(--r-full,999px);background:var(--color-accent);box-shadow:0 0 0 var(--stroke-icon,1.5px) var(--color-accent)}`,
  `input[type=range]::-moz-range-track{height:6px;border-radius:var(--r-full,999px);background:var(--color-sunken);box-shadow:inset 0 0 0 var(--stroke-icon,1.5px) var(--color-border-strong)}`,
  `input[type=range]::-moz-range-progress{height:6px;border-radius:var(--r-full,999px);background:var(--color-accent)}`,
  `input[type=range]::-moz-range-thumb{width:14px;height:14px;border:2px solid var(--color-surface);border-radius:var(--r-full,999px);background:var(--color-accent);box-shadow:0 0 0 var(--stroke-icon,1.5px) var(--color-accent)}`,
  `input[type=range]:hover,input[type=range]:disabled{border:0}`,
  `progress,meter{accent-color:var(--color-accent)}`,
  // One focus ring for every control, Sova's.
  `button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:var(--focus-ring,2px solid var(--color-accent));outline-offset:var(--focus-offset,2px)}`,
  `.muted{color:var(--color-ink-muted)}`,
].join("\n");
