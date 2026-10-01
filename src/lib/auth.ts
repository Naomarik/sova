import { createSignal } from "solid-js";

// The browser's side of the main listener's token gate. The token itself
// never lives in script: it arrives once in the URL fragment (`#t=<token>`, which a browser never
// sends) or from the unlock screen's field, is posted to /api/auth/unlock, and from then on rides
// the HttpOnly cookie that answer sets. What this module keeps is only whether the server has
// refused this browser, so the shell can show the unlock screen instead of the app.

/** "unlocking": a `#t=` token is being posted; the app waits so it never fires a request ahead of
    its cookie. "open": no refusal seen. "locked": the server answered 401, or the token was refused. */
export type AuthState = "unlocking" | "open" | "locked";

const [state, setState] = createSignal<AuthState>("open");
/** Why the last unlock didn't take, for the unlock screen; null before any attempt. */
const [failure, setFailure] = createSignal<string | null>(null);

export const authState = state;
export const unlockFailure = failure;
export const isUnlocked = () => state() === "open";

/** The token in a `#t=<token>` fragment (base64url, the whole fragment, as `sova open` mints it)
    and what the fragment should read once it's taken out. Any other fragment — the app's own
    `#/…` routes — is left alone. */
export function fragmentToken(hash: string): { token: string | null; rest: string } {
  const m = /^#t=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return { token: null, rest: hash };
  return { token: m[1]!, rest: "" };
}

export type UnlockResult = "ok" | "refused" | "unreachable";

/** Post the token once; the answer sets the cookie. `fetchImpl` is for tests. */
export async function postUnlock(token: string, fetchImpl: typeof fetch = fetch): Promise<UnlockResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "same-origin",
    });
  } catch {
    return "unreachable";
  }
  return res.ok ? "ok" : "refused";
}

const FAILURE: Record<Exclude<UnlockResult, "ok">, string> = {
  refused: "That token wasn't accepted. Run sova token on the machine Sova runs on and paste what it prints.",
  unreachable: "The Sova server isn't reachable.",
};

/** The unlock screen's button and the `#t=` link both end here. Unlocking changes nothing but
    the cookie; a refusal is remembered for the unlock screen to say why. */
export async function unlock(token: string, fetchImpl: typeof fetch = fetch): Promise<UnlockResult> {
  const result = await postUnlock(token.trim(), fetchImpl);
  if (result === "ok") {
    setFailure(null);
    forgetReload();
    setState("open");
  } else {
    setFailure(FAILURE[result]);
    setState("locked");
  }
  return result;
}

/**
 * Before the app's first render: take a `#t=` token off the address bar (replaceState, so it isn't
 * left in history or a copied URL) and post it. The returned promise settles once the app may
 * render; a refused token leaves the unlock screen showing why.
 */
export async function unlockFromFragment(
  loc: Pick<Location, "hash" | "pathname" | "search"> = location,
  hist: Pick<History, "state" | "replaceState"> = history,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { token, rest } = fragmentToken(loc.hash);
  if (!token) return;
  hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}${rest}`);
  setState("unlocking");
  await unlock(token, fetchImpl);
}

/**
 * A socket upgrade the server refused reaches the page only as a close (1006, no status), so the
 * socket asks here: one gated GET, which the gate answers 401 without a cookie whatever the route.
 * Resolves false (and has shown the unlock screen) when the gate refused; true otherwise —
 * including an unreachable server, which is the reconnect loop's business, not this one's.
 */
export async function checkAccess(fetchImpl: typeof fetch = fetch, deps?: ReloadDeps): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/status", { cache: "no-store", credentials: "same-origin" });
  } catch {
    return true;
  }
  if (res.status !== 401) return true;
  onUnauthorized(await res.json().catch(() => undefined), deps);
  return false;
}

// A 401 can carry `reload: true`: the server saying the page is older than it (a bundle from
// before the gate, or before a token change). One reload per tab picks up the new bundle (the
// service worker fetches navigations network-first); a second 401 shows the unlock screen, so a
// reload can never loop. The mark lives in sessionStorage because the reload wipes everything else.
const RELOAD_MARK = "sova:auth-reloaded";

interface ReloadDeps {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  reload(): void;
}

const browserDeps = (): ReloadDeps => ({
  storage: typeof sessionStorage === "undefined" ? null : sessionStorage,
  reload: () => location.reload(),
});

function forgetReload(deps: ReloadDeps = browserDeps()) {
  try {
    deps.storage?.removeItem(RELOAD_MARK);
  } catch {
    // Storage blocked: nothing was marked.
  }
}

/** Whether a 401's body asks for a reload. */
export const wantsReload = (body: unknown): boolean =>
  typeof body === "object" && body !== null && (body as { reload?: unknown }).reload === true;

/**
 * The server refused this browser (a 401 from the main listener, or a socket it wouldn't upgrade).
 * Reloads once if the answer asked for it and this tab hasn't already; otherwise shows the unlock
 * screen. Returns what it did.
 */
export function onUnauthorized(body?: unknown, deps: ReloadDeps = browserDeps()): "reload" | "locked" {
  if (state() === "unlocking") return "locked"; // the fragment's own post is in flight; it decides
  if (wantsReload(body)) {
    let marked = true;
    try {
      if (deps.storage) {
        marked = deps.storage.getItem(RELOAD_MARK) != null;
        if (!marked) deps.storage.setItem(RELOAD_MARK, "1");
      }
    } catch {
      marked = true; // no storage to remember the reload in: never risk a loop
    }
    if (!marked) {
      deps.reload();
      return "reload";
    }
  }
  setState("locked");
  return "locked";
}

/** Any answered request after a reload: the reload did its job, so a later 401 may reload again. */
let reloadSettled = false;
export function onAuthorized(deps: ReloadDeps = browserDeps()) {
  if (reloadSettled) return;
  reloadSettled = true;
  forgetReload(deps);
}

/** Tests only: put the module back as a fresh page has it. */
export function resetAuthForTest() {
  setState("open");
  setFailure(null);
  reloadSettled = false;
}
