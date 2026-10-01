// Run: npx tsx --test src/lib/auth.test.ts
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { authState, checkAccess, fragmentToken, isUnlocked, onAuthorized, onUnauthorized, postUnlock, resetAuthForTest, unlock, unlockFailure, unlockFromFragment, wantsReload } from "./auth";
import { withJsonType } from "./api";

beforeEach(() => resetAuthForTest());

const TOKEN = "AbC-12_xyzAbC-12_xyzAbC-12_xyzAbC-12_xyz0";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function deps() {
  const d = { storage: memoryStorage(), reloads: 0, reload: () => void d.reloads++ };
  return d;
}

test("#t=<token>: the token comes off the fragment, leaving it empty", () => {
  assert.deepEqual(fragmentToken(`#t=${TOKEN}`), { token: TOKEN, rest: "" });
});

test("any other fragment is the app's own and is left alone", () => {
  for (const hash of ["", "#/c/abc", "#t=", "#t=bad token", "#/x#t=abc", "#tt=abc"]) {
    assert.deepEqual(fragmentToken(hash), { token: null, rest: hash });
  }
});

test("the unlock POST sends the token as JSON, same-origin, to /api/auth/unlock", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await postUnlock(TOKEN, fake), "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/auth/unlock");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(new Headers(calls[0]!.init.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { token: TOKEN });
});

test("a refused token locks with a reason; an accepted one opens and clears it", async () => {
  const answer = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
  assert.equal(await unlock("wrong", answer(401)), "refused");
  assert.equal(authState(), "locked");
  assert.match(unlockFailure() ?? "", /sova token/);
  assert.equal(await unlock(` ${TOKEN} `, answer(200)), "ok");
  assert.equal(isUnlocked(), true);
  assert.equal(unlockFailure(), null);
});

test("an unreachable server is said as such, not as a wrong token", async () => {
  const down = (async () => {
    throw new TypeError("network");
  }) as unknown as typeof fetch;
  assert.equal(await unlock(TOKEN, down), "unreachable");
  assert.match(unlockFailure() ?? "", /isn't reachable/);
});

test("a plain 401 shows the unlock screen and never reloads", () => {
  const d = deps();
  assert.equal(onUnauthorized({ error: "unauthorized" }, d), "locked");
  assert.equal(d.reloads, 0);
  assert.equal(isUnlocked(), false);
});

test("a 401 asking for a reload reloads once per tab, then shows the unlock screen: never a loop", () => {
  const d = deps();
  assert.equal(wantsReload({ reload: true }), true);
  assert.equal(wantsReload({ reload: "yes" }), false);
  assert.equal(onUnauthorized({ reload: true }, d), "reload");
  assert.equal(d.reloads, 1);
  // The page after the reload: the mark survived it.
  resetAuthForTest();
  assert.equal(onUnauthorized({ reload: true }, d), "locked");
  assert.equal(d.reloads, 1);
  assert.equal(authState(), "locked");
});

test("an answered request after the reload re-arms it for a later 401", () => {
  const d = deps();
  onUnauthorized({ reload: true }, d);
  resetAuthForTest();
  onAuthorized(d);
  assert.equal(onUnauthorized({ reload: true }, d), "reload");
  assert.equal(d.reloads, 2);
});

test("no storage to remember a reload in: lock instead of risking a loop", () => {
  const d = { storage: null, reloads: 0, reload: () => void d.reloads++ };
  assert.equal(onUnauthorized({ reload: true }, d), "locked");
  assert.equal(d.reloads, 0);
});

test("a #t= link: the fragment is cleared before the post, and a 401 meanwhile doesn't lock", async () => {
  const replaced: string[] = [];
  const hist = { state: null, replaceState: (_s: unknown, _t: string, url?: string | URL | null) => void replaced.push(String(url)) };
  let answer!: (r: Response) => void;
  const slow = (() => new Promise<Response>((r) => (answer = r))) as unknown as typeof fetch;
  const done = unlockFromFragment({ hash: `#t=${TOKEN}`, pathname: "/", search: "?x=1" }, hist, slow);
  assert.deepEqual(replaced, ["/?x=1"]);
  assert.equal(authState(), "unlocking");
  assert.equal(onUnauthorized(undefined, deps()), "locked");
  assert.equal(authState(), "unlocking");
  answer(new Response("{}", { status: 200 }));
  await done;
  assert.equal(isUnlocked(), true);
});

test("no #t= in the fragment: nothing is posted and the address bar is untouched", async () => {
  const hist = { state: null, replaceState: () => assert.fail("replaced") };
  const never = (() => assert.fail("posted")) as unknown as typeof fetch;
  await unlockFromFragment({ hash: "#/c/abc", pathname: "/", search: "" }, hist, never);
  assert.equal(authState(), "open");
});

test("the socket's probe: 401 locks and says refused; anything else lets the loop retry", async () => {
  const answer = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
  assert.equal(await checkAccess(answer(404), deps()), true);
  assert.equal(isUnlocked(), true);
  const down = (async () => {
    throw new TypeError("network");
  }) as unknown as typeof fetch;
  assert.equal(await checkAccess(down, deps()), true);
  assert.equal(await checkAccess(answer(401), deps()), false);
  assert.equal(authState(), "locked");
});

test("a string body without a type is labelled JSON; an explicit type or a binary body is left alone", () => {
  const typed = withJsonType({ method: "PUT", body: "{}" });
  assert.equal(new Headers(typed?.headers).get("Content-Type"), "application/json");
  const wav = { method: "POST", headers: { "Content-Type": "audio/wav" }, body: "x" };
  assert.equal(withJsonType(wav), wav);
  const bin = { method: "POST", body: new Uint8Array(1) };
  assert.equal(withJsonType(bin), bin);
  assert.equal(withJsonType(undefined), undefined);
});

test("a socket asks the gate only when the close could be its refusal", async () => {
  const { mayBeRefused } = await import("./socket");
  assert.equal(mayBeRefused(1006, false), true); // an upgrade answered 401 reaches the page as this
  assert.equal(mayBeRefused(1008, true), true);
  assert.equal(mayBeRefused(4401, true), true);
  assert.equal(mayBeRefused(1006, true), false); // a dropped link after it was open: just reconnect
  assert.equal(mayBeRefused(1001, false), false);
});
