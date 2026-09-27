// A person's Edit form sends only what it changed (§app.organizations/org-page), so a value written
// elsewhere after the form opened (a wrap-up, another tab) is never written back. Pure, for tsx --test.

import type { Person, PersonInput } from "../../shared/orgs";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** A value as the form builds it: strings trimmed, empty contact channels dropped, keys in order. */
function norm(v: unknown): unknown {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined && x !== "")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, norm(x)]),
    );
  return v ?? "";
}

/** The fields of `input` that differ from the person as the form loaded them; {} when none do. */
export function changedFields(loaded: Person, input: PersonInput): Partial<PersonInput> {
  const out: Partial<PersonInput> = {};
  for (const key of Object.keys(input) as (keyof PersonInput)[]) {
    if (input[key] === undefined || same(input[key], loaded[key])) continue;
    (out as Record<string, unknown>)[key] = input[key];
  }
  return out;
}
