import { createSignal, onCleanup, createEffect, type Accessor } from "solid-js";
import type { ProviderWait } from "../../shared/provider-limits";
import { getProviderWaiting } from "./api";

/**
 * Who waits on a provider's request limit now, by session id (§app.provider-limits/waiting-shown):
 * GET /api/provider-limits/waiting, read from the queue files every 2 s while any view that could
 * show a wait asks for it (a running chat, a working session in the list, a working worker), and
 * not at all otherwise. Views read `providerWait(sessionId)`.
 */
const POLL_MS = 2_000;
const [waits, setWaits] = createSignal<Record<string, ProviderWait>>({});
let demand = 0;
let timer: ReturnType<typeof setInterval> | undefined;

async function load(): Promise<void> {
  if (typeof document !== "undefined" && document.hidden) return;
  try {
    setWaits((await getProviderWaiting()).sessions ?? {});
  } catch {
    // An older server, or a blip: nothing shown as waiting.
    setWaits({});
  }
}

function start(): void {
  if (++demand > 1) return;
  void load();
  timer = setInterval(() => void load(), POLL_MS);
}

function stop(): void {
  if (--demand > 0) return;
  if (timer) clearInterval(timer);
  timer = undefined;
  setWaits({});
}

/** Poll while `active()` is true (in a component's owner; stops with it). */
export function watchProviderWaits(active: Accessor<boolean>): void {
  let on = false;
  createEffect(() => {
    const want = active();
    if (want && !on) start();
    if (!want && on) stop();
    on = want;
  });
  onCleanup(() => {
    if (on) stop();
    on = false;
  });
}

/** This session's wait, if its model request waits on a provider's limit now. */
export const providerWait = (sessionId: string | undefined | null): ProviderWait | undefined => (sessionId ? waits()[sessionId] : undefined);
