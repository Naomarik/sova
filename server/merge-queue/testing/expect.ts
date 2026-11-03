/**
 * Tests only: a small `expect` over node:assert for the merge-queue run tests (the project's tests run on node:test's
 * API; bun's own `expect` isn't in its types). Only the matchers those tests use.
 */
import assert from "node:assert/strict";

const ANY = Symbol("arrayContaining");
type Contains = { [ANY]: unknown[] };

/** Whether `actual` has every key of `expected` (recursively; arrays element by element). */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && ANY in (expected as object)) {
    const want = (expected as Contains)[ANY];
    return Array.isArray(actual) && want.every((w) => actual.some((a) => matches(a, w)));
  }
  if (expected instanceof RegExp) return typeof actual === "string" ? expected.test(actual) : actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(actual[i], e));
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
  }
  return Object.is(actual, expected);
}

/** JSON-ish equality that, like bun's toEqual, ignores keys whose value is undefined. */
const strip = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x].sort() : x instanceof Map ? Object.fromEntries(x) : x))));

export function expect(actual: unknown, message?: string) {
  const self = {
    toBe: (v: unknown) => assert.strictEqual(actual, v, message),
    toEqual: (v: unknown) =>
      v && typeof v === "object" && ANY in (v as object) ? assert.ok(matches(actual, v), message ?? `expected ${JSON.stringify(actual)} to contain ${JSON.stringify((v as Contains)[ANY])}`) : assert.deepStrictEqual(strip(actual), strip(v), message),
    toMatchObject: (v: unknown) => assert.ok(matches(actual, v), message ?? `expected ${JSON.stringify(actual, null, 1)}\nto match ${JSON.stringify(v, null, 1)}`),
    toMatch: (re: RegExp | string) => assert.match(String(actual), typeof re === "string" ? new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : re, message),
    toContain: (v: unknown) => assert.ok(typeof actual === "string" ? actual.includes(String(v)) : Array.isArray(actual) && actual.includes(v), message ?? `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(v)}`),
    toBeNull: () => assert.strictEqual(actual, null, message),
    toBeUndefined: () => assert.strictEqual(actual, undefined, message),
    toBeTruthy: () => assert.ok(actual, message),
    toBeInstanceOf: (c: abstract new (...a: never[]) => unknown) => assert.ok(actual instanceof c, message ?? `not an instance of ${c.name}`),
    toHaveLength: (n: number) => assert.strictEqual((actual as { length: number }).length, n, message),
    toBeLessThan: (n: number) => assert.ok((actual as number) < n, message ?? `${actual} is not below ${n}`),
    toThrow: (what?: RegExp | (abstract new (...a: never[]) => unknown)) => assert.throws(actual as () => unknown, what as RegExp, message),
    not: {
      toThrow: () => assert.doesNotThrow(actual as () => unknown, message),
      toContain: (v: unknown) => assert.ok(!(typeof actual === "string" ? actual.includes(String(v)) : Array.isArray(actual) && actual.includes(v)), message ?? `expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(v)}`),
      toBe: (v: unknown) => assert.notStrictEqual(actual, v, message),
    },
  };
  return self;
}
expect.arrayContaining = (xs: unknown[]): Contains => ({ [ANY]: xs });
