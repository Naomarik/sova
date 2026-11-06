// A browser of stand-ins for the dictation strip's tests (voice-strip.test.ts, its .browser sibling):
// the mic's permission, a getUserMedia that answers only when told, an AudioContext, and timers run
// by hand, so these tests are about what the strip does and never the wall clock.
import assert from "node:assert/strict";
import { adoptVoice } from "./status";

export const SENTENCE = "The microphone didn't start within 10 seconds. Quit and reopen Sova or your browser, then try again.";
export const LIMIT = 10_000;

const realTimeout = setTimeout;

export function standIns() {
  let timers: { fn: () => void; ms: number; id: number }[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const put = (name: string, value: unknown) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  let permission = { state: "granted", addEventListener() {}, removeEventListener() {} };
  let closed = 0;
  const me = {
    /** Every getUserMedia so far, to settle from a test. */
    asked: [] as { resolve(s: MediaStream): void }[],
    /** What the page has listening on `window`. */
    keys: new Map<string, (e: unknown) => void>(),
    closed: () => closed,
    setPermission: (state: string) => void (permission.state = state),
    waiting: (ms: number) => timers.filter((t) => t.ms === ms).length,
    /** Lets the promises settle: real time, while the page's timers stay by hand. */
    flush: async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => realTimeout(r, 0));
    },
    /** Runs the oldest pending timer of exactly `ms`, or fails when none is waiting. */
    fire: (ms: number) => {
      const t = timers.find((x) => x.ms === ms);
      if (!t) assert.fail(`no timer of ${ms} ms; waiting: ${timers.map((x) => x.ms).join(", ")}`);
      timers = timers.filter((x) => x !== t);
      t.fn();
    },
    install() {
      timers = [];
      closed = 0;
      me.asked.length = 0;
      me.keys.clear();
      permission = { state: "granted", addEventListener() {}, removeEventListener() {} };
      let next = 1;
      put("setTimeout", (fn: () => void, ms: number) => {
        const id = next++;
        timers.push({ fn, ms, id });
        return id;
      });
      put("clearTimeout", (id: number) => {
        timers = timers.filter((t) => t.id !== id);
      });
      class Ctx {
        state = "running";
        close = async () => void closed++;
        resume = async () => {};
      }
      put("window", {
        AudioContext: Ctx,
        isSecureContext: true,
        addEventListener: (k: string, h: (e: unknown) => void) => void me.keys.set(k, h),
        removeEventListener: (k: string) => void me.keys.delete(k),
      });
      put("document", { addEventListener() {}, removeEventListener() {}, activeElement: null, hidden: false, visibilityState: "visible" });
      put("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      put("navigator", {
        mediaDevices: {
          getUserMedia: () =>
            new Promise<MediaStream>((resolve) => {
              me.asked.push({ resolve });
            }),
        },
        permissions: { query: async () => permission },
      });
      put("fetch", async () => new Response("{}"));
      adoptVoice({ state: "ready", log: { lines: [], seq: 0 } } as never);
    },
    restore() {
      for (const [name, d] of saved) {
        if (d) Object.defineProperty(globalThis, name, d);
        else delete (globalThis as Record<string, unknown>)[name];
      }
      saved.clear();
    },
  };
  return me;
}
