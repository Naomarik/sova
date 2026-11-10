import { createRoot, createSignal, onCleanup, type Accessor } from "solid-js";
import { sessionHashParts, sessionRouteFromHash } from "./mesh";

/**
 * What a chat's Lookbook has open (a design's page and chat, or the coordinator), kept in the
 * browser's history and the page's address: each open is one history step, Back and Forward retrace
 * them, closing goes back past them, and `#/s/<path>?design=A` / `?design=coordinator` reopens the
 * view on a reload or from a copied address. Opening only ever pushes or replaces history entries
 * (no hashchange of its own); Back and Forward between them change only the `design` parameter,
 * which names the same session, so the app's route stays as it was.
 */
export type DesignOpenTarget = { kind: "design"; label: string } | { kind: "coordinator" };

const COORDINATOR = "coordinator";

/** The address's word for a target. A design's label never reads "coordinator" (they are letters). */
export const designParamOf = (t: DesignOpenTarget): string => (t.kind === "coordinator" ? COORDINATOR : t.label);

/** The target a session hash's `design` parameter names, or null (none, or not a session hash). */
export function designOfHash(hash: string): DesignOpenTarget | null {
  const raw = sessionHashParts(hash)?.params.get("design");
  if (!raw) return null;
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return v === COORDINATOR ? { kind: "coordinator" } : { kind: "design", label: v };
}

/** The hash with its `design` parameter set to the target (removed for null). A hash that isn't a
    session's is returned as it is: a group's address carries no design, its history step only. */
export function hashWithDesign(hash: string, t: DesignOpenTarget | null): string {
  const parts = sessionHashParts(hash);
  if (!parts) return hash;
  const params = new Map(parts.params);
  params.delete("design");
  if (t) params.set("design", encodeURIComponent(designParamOf(t)));
  const qs = [...params].map(([k, v]) => `${k}=${v}`).join("&");
  return `#/s/${parts.path}${qs ? `?${qs}` : ""}`;
}

export const sameTarget = (a: DesignOpenTarget | null, b: DesignOpenTarget | null): boolean =>
  a === b || (!!a && !!b && designParamOf(a) === designParamOf(b) && a.kind === b.kind);

/** The record a history entry keeps of what it has open: whose (the chat), what, and how many of
    this view's steps lead to it (0: the entry was arrived at with it open, by a reload or an address). */
export type DesignStep = { key: string; target: DesignOpenTarget; depth: number };

const STATE_KEY = "sovaDesign";

export function stepOf(state: unknown, key: string): DesignStep | null {
  const s = (state as Record<string, unknown> | null)?.[STATE_KEY] as DesignStep | undefined;
  return s && typeof s === "object" && s.key === key && s.target ? s : null;
}

export function stateWith(state: unknown, step: DesignStep | null): Record<string, unknown> {
  const base = state && typeof state === "object" ? { ...(state as Record<string, unknown>) } : {};
  if (step) base[STATE_KEY] = step;
  else delete base[STATE_KEY];
  return base;
}

/**
 * What an entry has open for this chat: its own record, else its address's parameter when the
 * address names this chat (one typed or copied in), else nothing.
 */
export function targetAt(state: unknown, hash: string, key: string, path: string): DesignOpenTarget | null {
  const step = stepOf(state, key);
  if (step) return step.target;
  return sessionRouteFromHash(hash)?.path === path ? designOfHash(hash) : null;
}

// ---- one controller per chat ------------------------------------------------------------------

type Controller = {
  target: Accessor<DesignOpenTarget | null>;
  /** The surface that draws the open view (the first one mounted: a card or the Gallery). */
  drawer: Accessor<symbol | null>;
  join(me: symbol): void;
  leave(me: symbol): void;
  open(t: DesignOpenTarget): void;
  close(): void;
  /** What it names is gone: the view closes and the address stops naming it, with no history step. */
  drop(): void;
  refs: number;
  dispose(): void;
};

const controllers = new Map<string, Controller>();

function makeController(key: string, path: string): Controller {
  return createRoot((dispose) => {
    const initial = targetAt(history.state, location.hash, key, path);
    // An address that names a view with no record of its own (a reload, a copied address): the
    // entry gets one, so Back and closing count from here.
    if (initial && !stepOf(history.state, key)) {
      history.replaceState(stateWith(history.state, { key, target: initial, depth: 0 }), "", location.href);
    }
    const [target, setTarget] = createSignal<DesignOpenTarget | null>(initial, { equals: sameTarget });
    const [drawers, setDrawers] = createSignal<symbol[]>([]);
    /** Set by a close that went back through history: the entry it lands on shows nothing. */
    let closing = false;
    const strip = () => {
      const want = hashWithDesign(location.hash, null);
      if (stepOf(history.state, key) || want !== location.hash) {
        history.replaceState(stateWith(history.state, null), "", want);
      }
    };
    const onPop = () => {
      if (closing) {
        closing = false;
        strip();
        setTarget(null);
        return;
      }
      setTarget(targetAt(history.state, location.hash, key, path));
    };
    window.addEventListener("popstate", onPop);
    const ctl: Controller = {
      target,
      drawer: () => drawers()[0] ?? null,
      join: (me) => setDrawers((l) => [...l, me]),
      leave: (me) => setDrawers((l) => l.filter((x) => x !== me)),
      open(t) {
        if (sameTarget(target(), t)) return;
        const was = stepOf(history.state, key);
        const depth = target() && was ? was.depth + 1 : 1;
        history.pushState(stateWith(history.state, { key, target: t, depth }), "", hashWithDesign(location.hash, t));
        setTarget(t);
      },
      close() {
        if (!target()) return;
        const step = stepOf(history.state, key);
        setTarget(null);
        if (step && step.depth > 0) {
          closing = true;
          history.go(-step.depth);
        } else strip();
      },
      drop() {
        if (!target()) return;
        setTarget(null);
        strip();
      },
      refs: 0,
      dispose() {
        window.removeEventListener("popstate", onPop);
        dispose();
      },
    };
    return ctl;
  });
}

/**
 * A surface that opens this chat's Lookbook views (the card, the Gallery). Every surface of a chat
 * shares one open view; the first mounted draws it (`draws()`).
 */
export function useDesignOpen(path: string, host: string | null) {
  const key = `${host ?? ""}|${path}`;
  let ctl = controllers.get(key);
  if (!ctl) controllers.set(key, (ctl = makeController(key, path)));
  ctl.refs++;
  const me = Symbol("design-open");
  ctl.join(me);
  const held = ctl;
  onCleanup(() => {
    held.leave(me);
    if (--held.refs > 0) return;
    controllers.delete(key);
    held.dispose();
  });
  return {
    target: held.target,
    draws: () => held.drawer() === me,
    open: (t: DesignOpenTarget) => held.open(t),
    close: () => held.close(),
    drop: () => held.drop(),
  };
}

export type DesignOpener = ReturnType<typeof useDesignOpen>;
