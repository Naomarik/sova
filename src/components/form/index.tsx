/**
 * The form kit: every box, list and switch in Sova. A box keeps exactly what was typed (never a
 * number input, which hands back "" for "1e" and loses it); a value its rule refuses turns the box
 * red with one sentence under it (shared/form-rules.ts, the same words the server refuses in), and a
 * limited text shows "n / most". Labels, hints and errors are wired to the control by id. Base CSS
 * classes only (`.field`, `.input`, `.field-error`, `.toggle`), no app state: src/card-toolkit
 * re-exports it.
 */
import { createMemo, createUniqueId, For, type JSX, Show, splitProps } from "solid-js";
import { count, measured, problemOf, type Rule } from "../../../shared/form-rules";

interface FieldProps {
  label: JSX.Element;
  /** The label is read aloud, not shown (a fieldset's legend already says it). */
  hideLabel?: boolean;
  hint?: JSX.Element;
  /** The value's rule: red and its sentence while the value fails it, "n / most" for limited text. */
  rule?: Rule;
  /** The sentence's name for this field, when the rule's label isn't it ("Quick action 2's label"). */
  ruleLabel?: string;
  /** A problem the form knows that no rule says (a duplicate name, a save that failed). Wins over the rule's. */
  error?: string | null;
  /** Drawn beside the control, in a row of class `afterClass` (both, or neither): a live "Now: 3 of 10 running.". */
  after?: JSX.Element;
  afterClass?: string;
  /** Ids of more text describing the control. */
  describedBy?: string;
  class?: string;
  id?: string;
}

const cls = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

type Aria = { id: string; "aria-invalid": "true" | undefined; "aria-describedby": string | undefined };
const FIELD_KEYS = ["label", "hideLabel", "hint", "rule", "ruleLabel", "error", "after", "afterClass", "describedBy", "class", "id"] as const;

/** A labelled field around one control: its hint, its one error sentence and its count. */
function Field(p: FieldProps & { value?: string; control: (aria: Aria) => JSX.Element }) {
  const id = p.id ?? createUniqueId();
  const hint = createMemo(() => p.hint);
  const problem = () => p.error ?? (p.rule && p.value !== undefined ? problemOf(p.rule, p.value, p.ruleLabel) : null);
  const max = () => (p.rule?.kind === "text" && p.value !== undefined ? p.rule.max : null);
  const used = () => measured(p.rule as { trim?: boolean }, p.value ?? "");
  // Getters, so the control is built once and its aria follows the value.
  const aria: Aria = {
    id,
    get "aria-invalid"() {
      return problem() ? "true" : undefined;
    },
    get "aria-describedby"() {
      return [p.describedBy, hint() && `${id}-hint`, problem() && `${id}-error`, max() !== null && `${id}-count`].filter(Boolean).join(" ") || undefined;
    },
  };
  return (
    <div class={cls("field", p.class)}>
      <label class={p.hideLabel ? "visually-hidden" : "field-label"} for={id}>
        {p.label}
      </label>
      <Show when={p.afterClass} fallback={p.control(aria)}>
        <div class={p.afterClass}>
          {p.control(aria)}
          {p.after}
        </div>
      </Show>
      <Show when={hint()}>
        <span class="field-hint" id={`${id}-hint`}>
          {hint()}
        </span>
      </Show>
      <Show when={problem()}>
        <span class="field-error" id={`${id}-error`}>
          {problem()}
        </span>
      </Show>
      <Show when={max()}>
        {(m) => (
          <span class={`${used() > m() ? "field-error" : "field-hint"} text-num`} id={`${id}-count`}>
            {count(used())} / {count(m())}
          </span>
        )}
      </Show>
    </div>
  );
}

type InputAttrs = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "value" | "onInput" | "id" | "class">;
export type TextFieldProps = FieldProps & InputAttrs & { value: string; onInput(raw: string): void; inputClass?: string };

/** A one-line text box. */
export function TextField(props: TextFieldProps) {
  const [f, own, rest] = splitProps(props, FIELD_KEYS, ["value", "onInput", "inputClass"]);
  return (
    <Field
      {...f}
      value={own.value}
      control={(aria) => (
        <input class={cls("input", own.inputClass)} {...rest} {...aria} value={own.value} onInput={(e) => own.onInput(e.currentTarget.value)} />
      )}
    />
  );
}

/** A number box: text that keeps what was typed ("", "1e", "-"), checked by its whole-number rule. */
export const NumberField = (props: TextFieldProps) => (
  <TextField type="text" inputmode="numeric" autocomplete="off" {...props} inputClass={cls("text-num", props.inputClass)} />
);

type AreaAttrs = Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onInput" | "id" | "class">;

/** A long text box, with "n / most" under it when its rule limits it. */
export function TextArea(props: FieldProps & AreaAttrs & { value: string; onInput(raw: string): void; inputClass?: string }) {
  const [f, own, rest] = splitProps(props, FIELD_KEYS, ["value", "onInput", "inputClass"]);
  return (
    <Field
      {...f}
      value={own.value}
      control={(aria) => (
        <textarea class={cls("input textarea", own.inputClass)} {...rest} {...aria} value={own.value} onInput={(e) => own.onInput(e.currentTarget.value)} />
      )}
    />
  );
}

export interface Option {
  value: string;
  label: JSX.Element;
  hint?: JSX.Element;
}

/** A list to pick from: `options`, or `<option>`s as children (for groups). */
export function Select(
  props: FieldProps & { value: string; onChange(value: string): void; options?: readonly Option[]; children?: JSX.Element; disabled?: boolean; selectClass?: string },
) {
  const [f, own] = splitProps(props, FIELD_KEYS);
  return (
    <Field
      {...f}
      control={(aria) => (
        <div class="select-wrap">
          <select class={cls("select", own.selectClass)} {...aria} disabled={own.disabled} onChange={(e) => own.onChange(e.currentTarget.value)}>
            <For each={own.options}>
              {(o) => (
                <option value={o.value} selected={o.value === own.value}>
                  {o.label}
                </option>
              )}
            </For>
            {own.children}
          </select>
          <span class="select-caret" aria-hidden="true">
            ▾
          </span>
        </div>
      )}
    />
  );
}

/** A checkbox (`switch`: drawn as a switch, its label first), with an optional hint under it. */
export function Toggle(props: {
  label: JSX.Element;
  checked: boolean;
  onChange(checked: boolean): void;
  hint?: JSX.Element;
  switch?: boolean;
  disabled?: boolean;
  class?: string;
  id?: string;
}) {
  const hintId = createUniqueId();
  const input = () => (
    <input type="checkbox" id={props.id} checked={props.checked} disabled={props.disabled} aria-describedby={props.hint ? hintId : undefined} onChange={(e) => props.onChange(e.currentTarget.checked)} />
  );
  return (
    <>
      <label class={cls("toggle", props.switch && "toggle-switch", props.class)}>
        <Show when={props.switch} fallback={[input(), <span class="toggle-box" aria-hidden="true" />, <span>{props.label}</span>]}>
          <span>{props.label}</span>
          {input()}
          <span class="toggle-box" />
        </Show>
      </label>
      <Show when={props.hint}>
        <p class="field-hint" id={hintId}>
          {props.hint}
        </p>
      </Show>
    </>
  );
}

/** One of a few, as radio buttons; each option's hint follows its label. */
export function Choice(props: { label: string; value: string; options: readonly Option[]; onChange(value: string): void; disabled?: boolean; class?: string }) {
  const name = createUniqueId();
  return (
    <div role="radiogroup" aria-label={props.label} class={props.class}>
      <For each={props.options}>
        {(o) => (
          <label class="toggle">
            <input type="radio" name={name} checked={props.value === o.value} disabled={props.disabled} onChange={() => props.onChange(o.value)} />
            <span class="toggle-box" aria-hidden="true" />
            <span>
              {o.label}
              <Show when={o.hint}>
                <span class="field-hint"> · {o.hint}</span>
              </Show>
            </span>
          </label>
        )}
      </For>
    </div>
  );
}

/** A search box: its label is read aloud, its placeholder says what it finds. */
export function SearchField(props: Omit<TextFieldProps, "hideLabel" | "rule">) {
  return <TextField type="search" autocomplete="off" hideLabel {...props} />;
}
