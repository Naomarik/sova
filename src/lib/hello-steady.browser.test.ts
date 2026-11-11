// Run: pnpm test -- src/lib/hello-steady.browser.test.ts (Solid's reactive build).
// A new chat's screen through a hello (a decision on its folder's list rebuilds the chat and its socket
// says hello again): the profile never blinks out, and the empty screen's "read from the top" fires
// only when the screen turns empty, never at a hello that leaves it empty. Either one threw the reader
// to the top of the page at each Approve. The last test holds the chat and its thread to these
// helpers: putting either old shape back (the profile cleared at the hello, or the move on a raw `on`
// over the prop) fails it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createProfileHold, onEmptyChange } = await import("./hello-steady");

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a hello keeps the profile shown until its profile message, or the message after its place, settles it", async () => {
  type Info = { pickable: boolean };
  const shown: (Info | null)[] = [];
  const hold = createProfileHold<Info>((v) => shown.push(v), 50);
  const picker = { pickable: true };
  hold.said(picker);
  // The rebuild's hello, then its train: the profile's message comes after it.
  hold.hello();
  assert.deepEqual(shown, [picker], "nothing is cleared at the hello");
  hold.said({ pickable: true });
  hold.settled(); // the claude_login after the profile's place: already settled, so it changes nothing
  assert.deepEqual(shown.slice(1), [{ pickable: true }]);
  assert.ok(shown.every((v) => v !== null), "the picker never went away");

  // A hello with no profile after it (the chat has sent its first message): settled as none.
  hold.hello();
  hold.settled();
  assert.equal(shown.at(-1), null);

  // Nothing at all after the hello (an older train): the time settles it.
  hold.said(picker);
  hold.hello();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(shown.at(-1), null);
  hold.dispose();
});

test("the empty screen's move runs at a new value only, not at each re-read of what it reads", async () => {
  const [items, setItems] = solid.createSignal<string[]>([]);
  const [rows, setRows] = solid.createSignal(0);
  const moves: [boolean, boolean | undefined][] = [];
  const dispose = solid.createRoot((d) => {
    // Like ChatView's emptyScreen: it reads several signals, and a hello writes each anew.
    onEmptyChange(() => items().length === 0 && rows() === 0, (now, was) => moves.push([now, was]));
    return d;
  });
  await tick();
  assert.deepEqual(moves, [[true, undefined]]);
  // A hello: fresh empty lists, the same value.
  setItems([]);
  setRows(0);
  setItems([]);
  await tick();
  assert.deepEqual(moves, [[true, undefined]], "a hello that leaves it empty moves nothing");
  setItems(["first"]);
  await tick();
  assert.deepEqual(moves.at(-1), [false, true]);
  dispose();
});

test("the chat's profile is written only through the hold, and the thread's empty move only through the gate", () => {
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  const chat = src("../components/ChatView.tsx");
  // The signal's setter appears where it is made and where the hold is given it, nowhere else: a
  // hello that cleared it directly (the jump) would be a third.
  const writes = [...chat.matchAll(/\bsetProfileInfo\b/g)].length;
  assert.equal(writes, 2, "setProfileInfo is used only by createSignal and createProfileHold");
  assert.match(chat, /createProfileHold<ChatProfileInfo>\(setProfileInfo,/);
  const hello = chat.slice(chat.indexOf('case "hello":'));
  assert.match(hello.slice(0, hello.indexOf("break;")), /profileHold\.hello\(\)/, "the hello holds the profile");
  const thread = src("../components/Thread.tsx");
  assert.match(thread, /onEmptyChange\(\s*\(\) => !!props\.empty,/);
  assert.doesNotMatch(thread, /\bon\(\s*\(\)\s*=>[^,]*props\.empty/, "no raw on() over props.empty");
});
