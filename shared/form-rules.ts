/**
 * One way to check a typed value, for every form in Sova and the route that saves it: the form asks
 * `check` as you type (the box goes red, its one sentence under it, Save waits), and the route asks
 * the same rule before it writes, refusing in the same words. Limits live in per-feature tables in
 * `shared/` (`shared/overseer-limits.ts`, …) that both sides import. Pure, no imports: the server, the
 * app and the card toolkit all load it.
 */

/** A whole number from `min` to `max`, typed ("12") or stored (12). `optional`: blank is allowed (null). */
export interface WholeRule {
  kind: "whole";
  label: string;
  min: number;
  max: number;
  optional?: boolean;
}
/** Text of at most `max` characters (`min`, default 0). `trim`: measured and saved trimmed. */
export interface TextRule {
  kind: "text";
  label: string;
  max: number;
  min?: number;
  trim?: boolean;
  /** The sentence for a blank required box, instead of "{label} can't be empty." */
  empty?: string;
}
/** Anything else: `issue` names the problem with the (trimmed) text, or null. */
export interface CustomRule {
  kind: "custom";
  label: string;
  issue(text: string): string | null;
}
export type Rule = WholeRule | TextRule | CustomRule;

export type Checked<T = unknown> = { ok: true; value: T } | { ok: false; message: string };

/** "8,000": a count as forms say it. */
export const count = (n: number): string => n.toLocaleString("en-US");

/** The length a text rule measures: trimmed when it trims. */
export const measured = (rule: Pick<TextRule, "trim">, text: string): number => (rule.trim ? text.trim() : text).length;

/**
 * Whether `raw` (what the box holds, or what a request carries) passes `rule`, and its value: a
 * number for `whole` (null when optional and blank), the (trimmed) text otherwise. `label`
 * overrides the rule's own, for one of many ("Quick action 2's label").
 */
export function check(rule: WholeRule, raw: unknown, label?: string): Checked<number | null>;
export function check(rule: Rule, raw: unknown, label?: string): Checked;
export function check(rule: Rule, raw: unknown, label = rule.label): Checked {
  const no = (message: string): Checked => ({ ok: false, message });
  if (rule.kind === "whole") {
    const bad = no(`${label} must be a whole number from ${count(rule.min)} to ${count(rule.max)}.`);
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : null;
    if (text === "" && rule.optional) return { ok: true, value: null };
    if (text === null || !/^-?\d+$/.test(text)) return bad;
    const n = Number(text);
    return n >= rule.min && n <= rule.max ? { ok: true, value: n } : bad;
  }
  if (typeof raw !== "string") return no(`${label} must be text.`);
  const text = rule.kind === "text" && !rule.trim ? raw : raw.trim();
  if (rule.kind === "text") {
    const min = rule.min ?? 0;
    if (min > 0 && text.length === 0) return no(rule.empty ?? `${label} can't be empty.`);
    if (text.length < min) return no(`${label} must be at least ${count(min)} characters.`);
    if (text.length > rule.max) return no(`${label} can be at most ${count(rule.max)} characters.`);
  } else {
    const why = rule.issue(text);
    if (why) return no(why);
  }
  return { ok: true, value: text };
}

/** `rule`'s sentence for `raw`, or null when it passes. */
export const problemOf = (rule: Rule, raw: unknown, label?: string): string | null => {
  const r = check(rule, raw, label);
  return r.ok ? null : r.message;
};

/** One field of a form, in page order: its rule and what it holds now; `at` says where it is. */
export interface FieldCheck<At = unknown> {
  rule: Rule;
  value: unknown;
  label?: string;
  at?: At;
}

/**
 * The first problem in page order: a field that fails its rule, or a sentence a form adds for what
 * no one field says (a cross-field check), given as `{ message, at }`. Null when all pass.
 */
export function firstIssue<At>(checks: readonly (FieldCheck<At> | { message: string | null; at?: At })[]): { message: string; at?: At } | null {
  for (const c of checks) {
    const message = "rule" in c ? problemOf(c.rule, c.value, c.label) : c.message;
    if (message) return { message, at: c.at };
  }
  return null;
}
