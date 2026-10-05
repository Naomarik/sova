// Stands in for src/lib/live.ts while extract-live.ts replays src/lib/live.test.ts: every store mutator is the
// real one, logged first, so each store the tests make becomes one recorded sequence of calls (inputs/
// live-test.json). The tests' own assertions still run against the real store.
import * as live from "../../../../../src/lib/live";

export * from "../../../../../src/lib/live";

/** The mutators a sequence records; each takes the store's setter first. */
export const MUTATORS = ["applyEvent", "addPendingPrompt", "applyQueue", "markRemoved", "markQueued", "markDelivered", "takeBackQueued"] as const;
export type Mutator = (typeof MUTATORS)[number];

export interface Call {
  fn: Mutator;
  /** The arguments after the setter, as JSON. */
  args: unknown[];
}
export interface Sequence {
  name: string;
  calls: Call[];
}

export const recorded: Sequence[] = [];
let testName = "(outside a test)";
const bySetter = new Map<unknown, Sequence>();

/** node:test's `test`, as the replay sees it: names the sequences its stores make and runs the body now, so a
    failing assertion stops the extraction. live.test.ts's tests are synchronous; an async one is refused. */
export function test(name: string, fn: () => unknown): void {
  testName = name;
  if (fn() instanceof Promise) throw new Error(`${name}: an async test; the extraction replays synchronous ones only`);
  testName = "(outside a test)";
}

function sequenceOf(set: unknown): Sequence {
  let seq = bySetter.get(set);
  if (!seq) {
    seq = { name: testName, calls: [] };
    bySetter.set(set, seq);
    recorded.push(seq);
  }
  return seq;
}

const logged =
  <F extends (set: any, ...rest: any[]) => any>(fn: Mutator, real: F) =>
  (set: Parameters<F>[0], ...rest: unknown[]): ReturnType<F> => {
    const args = [...rest];
    while (args.length && args[args.length - 1] === undefined) args.pop();
    if (args.includes(undefined)) throw new Error(`${testName}: ${fn} with an undefined argument before others; JSON can't keep it`);
    sequenceOf(set).calls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
    return real(set, ...rest);
  };

export const applyEvent = logged("applyEvent", live.applyEvent);
export const addPendingPrompt = logged("addPendingPrompt", live.addPendingPrompt);
export const applyQueue = logged("applyQueue", live.applyQueue);
export const markRemoved = logged("markRemoved", live.markRemoved);
export const markQueued = logged("markQueued", live.markQueued);
export const markDelivered = logged("markDelivered", live.markDelivered);
export const takeBackQueued = logged("takeBackQueued", live.takeBackQueued);
