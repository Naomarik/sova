import { For, Show } from "solid-js";
import { setTypography, typography } from "../lib/theme";
import { fontById, type FontKind, fontsOf, isThemeDefault } from "../lib/typography";
import { announce } from "../lib/ui-state";

/**
 * Settings → Themes → Typography (spec/12-settings-dialog.md §12 "Typography"): the faces this
 * browser puts over the theme it wears. Two closed lists — Text (UI chrome, prose, headings) and
 * Code (paths, ids, diffs) — each a native select, because a short closed list on a phone should
 * get the platform picker. "Theme default" is the first option and the initial state: the theme's
 * own faces, which for every shipped theme are Inter and JetBrains Mono. Picking one of those
 * two explicitly is a real choice — a theme that names another face loses to it.
 *
 * Applies as you pick and persists in this browser (`sova:typography`, mirrored at the legacy
 * `pi-web:typography` while the rename bridge is open), like the theme. The
 * preview under the selects inherits the live root faces, so it is the page's own answer rather
 * than a render of the option — there is nothing it could show that the dialog around it isn't
 * already showing.
 */

/** The `<select>` value that means "no pick". Not a font id, so it can never collide with one. */
const THEME_DEFAULT = "";

function FontSelect(props: { kind: FontKind; label: string; hint: string }) {
  const id = () => `typography-${props.kind}`;
  const value = () => (props.kind === "text" ? typography().text : typography().mono) ?? THEME_DEFAULT;
  const onChange = (raw: string) => {
    const next = raw === THEME_DEFAULT ? null : (fontById(props.kind, raw)?.id ?? null);
    setTypography({ [props.kind]: next });
    const face = next ? fontById(props.kind, next)!.label : "the theme's font";
    announce(`${props.label} is now ${face}.`);
  };
  const note = () => fontById(props.kind, value())?.note;
  return (
    <div class="field settings-type-field">
      <label class="field-label" for={id()}>
        {props.label}
      </label>
      <div class="select-wrap">
        <select
          class="select"
          id={id()}
          value={value()}
          aria-describedby={`${id()}-hint`}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          <option value={THEME_DEFAULT}>Theme default</option>
          <For each={fontsOf(props.kind)}>{(f) => <option value={f.id}>{f.label}</option>}</For>
        </select>
        <span class="select-caret" aria-hidden="true">
          ▾
        </span>
      </div>
      <span class="field-hint" id={`${id()}-hint`}>
        {note() ?? props.hint}
      </span>
    </div>
  );
}

export function TypographySection() {
  const reset = () => {
    setTypography({ text: null, mono: null });
    announce("Back to the theme's fonts.");
  };
  return (
    <section class="settings-type" aria-labelledby="settings-type-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-type-title">
          Typography
        </h3>
        <button type="button" class="button button-sm" disabled={isThemeDefault(typography())} onClick={reset}>
          Use Theme Fonts
        </button>
      </div>
      <p class="settings-intro">Fonts for this browser, over whichever theme is on. Theme default is the theme's own fonts.</p>
      <div class="settings-type-fields">
        <FontSelect kind="text" label="Text" hint="Everything you read: the sidebar, messages, and headings." />
        <FontSelect kind="mono" label="Code" hint="Paths, ids, diffs, and code blocks." />
      </div>
      {/* The preview inherits the root faces: it is what the page renders, not a picture of it.
          The mono block's two lines are the same length so a misaligned column is visible. */}
      <div class="settings-type-preview" aria-label="Preview of the current fonts">
        <p class="settings-type-preview-heading">Changed 7 files in src/api</p>
        <p class="settings-type-preview-body">
          The run stopped at step 4 and nothing was merged. 3 runs are waiting on you — review them, or
          discard the one that failed.
        </p>
        <pre class="settings-type-preview-code" aria-hidden="true">
          {"+ id: 0x1F  path: src/api/runs.ts  ok\n- id: 0x2A  path: src/api/jobs.ts  ok"}
        </pre>
      </div>
      <Show when={!isThemeDefault(typography())}>
        <p class="settings-intro">
          Text: {fontById("text", typography().text)?.label ?? "theme default"} · Code:{" "}
          {fontById("mono", typography().mono)?.label ?? "theme default"}
        </p>
      </Show>
    </section>
  );
}
