// Run: pnpm test -- src/lib/shell-box.browser.test.ts (Solid's reactive build).
// The message box in shell mode (§chat.shell-mode/box), as Composer.tsx wires it: the draft it opens
// with (its mode saved apart from its text), Enter before the chat connects, the chat's answer to a
// Run arriving while you type, a hand-back; and the whole output's window reading page by page
// (§chat.shell-mode/card).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createShellBox } = await import("./shell-box");
const { NOT_CONNECTED_YET } = await import("./shell-mode");
const { createOutputReader, OUTPUT_GONE } = await import("./shell-output");
type ShellAnswer = import("./shell-mode").ShellAnswer;
type ShellControl = import("./shell-mode").ShellControl;
type StoredDraft = import("./shell-box").StoredDraft;

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A box over a stand-in chat: the shell control it is given (or none), its Runs and answers, and every save. */
function harness(o: { stored?: StoredDraft; server?: StoredDraft; shell?: boolean } = {}) {
  const runs: { command: string; priv: boolean }[] = [];
  const writes: { text: string; mode?: string }[] = [];
  const said: string[] = [];
  let cleared = 0;
  let next = 0;
  const [answer, setAnswer] = solid.createSignal<ShellAnswer | null>(null);
  const control: ShellControl = {
    run: (command, priv) => {
      runs.push({ command, priv });
      return { clientId: `c${++next}` };
    },
    answer,
  };
  const [hasShell, setHasShell] = solid.createSignal(o.shell ?? true);
  let box!: ReturnType<typeof createShellBox>;
  const dispose = solid.createRoot((dispose) => {
    box = createShellBox({
      shell: () => (hasShell() ? control : null),
      stored: () => o.stored ?? { text: "" },
      load: () => Promise.resolve(o.server ?? o.stored ?? { text: "" }),
      write: (text, mode) => void writes.push(mode ? { text, mode } : { text }),
      announce: (t) => void said.push(t),
      cleared: () => void cleared++,
    });
    return dispose;
  });
  return { box, runs, writes, said, setAnswer, setHasShell, dispose, cleared: () => cleared };
}

describe("a draft reopening", () => {
  test("a command saved in shell mode reopens as one, marker and all; a leading ! in a message stays text", () => {
    const cmd = harness({ stored: { text: "pnpm test", mode: "private" } });
    assert.equal(cmd.box.mode(), "private");
    assert.equal(cmd.box.text(), "pnpm test");
    cmd.dispose();
    for (const text of ["!ls", "![shot](a.png)"]) {
      const msg = harness({ stored: { text } });
      assert.equal(msg.box.mode(), "off", `${text} is a message`);
      assert.equal(msg.box.text(), text);
      msg.dispose();
    }
  });

  test("from the server after a reload: the saved mode comes back with the text", async () => {
    const h = harness({ server: { text: "git status", mode: "shell" } });
    assert.equal(h.box.text(), "");
    await tick();
    assert.equal(h.box.mode(), "shell");
    assert.equal(h.box.text(), "git status");
    assert.deepEqual(h.writes, [], "opening a draft saves nothing");
    h.dispose();
  });

  test("a box that has no shell mode yet shows the command as its text, and opens it once shell mode comes", async () => {
    const h = harness({ stored: { text: "ls", mode: "shell" }, shell: false });
    assert.equal(h.box.mode(), "off");
    assert.equal(h.box.text(), "!ls", "the marker in view, never a hidden command");
    h.setHasShell(true);
    await tick();
    assert.equal(h.box.mode(), "shell");
    assert.equal(h.box.text(), "ls");
    // Shell mode going (the chat's hello says it has none): its text again, the stored mode kept.
    h.setHasShell(false);
    await tick();
    assert.equal(h.box.text(), "!ls");
    assert.deepEqual(h.writes, []);
    h.dispose();
  });

  test("typing in a box whose command shows as text saves a message", async () => {
    const h = harness({ stored: { text: "ls", mode: "shell" }, shell: false });
    h.box.input("!ls -la", "insertText", false);
    assert.deepEqual(h.writes.at(-1), { text: "!ls -la" });
    h.dispose();
  });
});

describe("Enter before the chat connects", () => {
  test("nothing is sent, as a command or a message; the box says why, and the reason goes once connected", () => {
    const h = harness({ stored: { text: "make", mode: "shell" } });
    assert.equal(h.box.run({ canSend: false, blocked: { quiet: true }, readOnly: false }), "held");
    assert.deepEqual(h.runs, []);
    assert.equal(h.box.reason(), NOT_CONNECTED_YET);
    assert.deepEqual(h.said, [NOT_CONNECTED_YET]);
    assert.equal(h.box.text(), "make", "the command stays");
    assert.equal(h.box.mode(), "shell");
    h.box.connected();
    assert.equal(h.box.reason(), null);
    h.dispose();
  });

  test("shell mode going away turns the command into visible text at once, so no Enter sends a hidden command", () => {
    const h = harness({ stored: { text: "ls", mode: "shell" } });
    h.setHasShell(false);
    assert.equal(h.box.mode(), "off");
    assert.equal(h.box.text(), "!ls");
    assert.equal(h.box.run({ canSend: true, blocked: null, readOnly: false }), "message");
    assert.deepEqual(h.runs, []);
    h.dispose();
  });

  test("a message box's Enter is the composer's to send", () => {
    const h = harness({ stored: { text: "hello" } });
    assert.equal(h.box.run({ canSend: true, blocked: null, readOnly: false }), "message");
    h.dispose();
  });
});

describe("the chat's answer arriving while you type", () => {
  test("a start for a Run you've changed since leaves the box as it is", async () => {
    const h = harness({ stored: { text: "sleep 5", mode: "shell" } });
    assert.equal(h.box.run({ canSend: true, blocked: null, readOnly: false }), "sent");
    assert.deepEqual(h.runs, [{ command: "sleep 5", priv: false }]);
    h.box.input("sleep 5 && ls", "insertText", false);
    h.setAnswer({ clientId: "c1" });
    await tick();
    assert.equal(h.box.text(), "sleep 5 && ls", "what you typed stays");
    assert.equal(h.box.mode(), "shell");
    assert.equal(h.box.pending(), null, "and the next Run may go");
    h.dispose();
  });

  test("another device's command starting changes nothing here", async () => {
    const h = harness({ stored: { text: "ls", mode: "shell" } });
    h.box.run({ canSend: true, blocked: null, readOnly: false });
    h.setAnswer({ clientId: "someone-else" });
    await tick();
    assert.equal(h.box.text(), "ls");
    assert.ok(h.box.pending(), "still waiting on its own answer");
    h.dispose();
  });

  test("an unchanged box empties and leaves shell mode when its Run starts; a refusal keeps it and says why", async () => {
    const h = harness({ stored: { text: "ls", mode: "private" } });
    h.box.run({ canSend: true, blocked: null, readOnly: false });
    assert.deepEqual(h.runs, [{ command: "ls", priv: true }]);
    h.setAnswer({ clientId: "c1" });
    await tick();
    assert.equal(h.box.text(), "");
    assert.equal(h.box.mode(), "off");
    assert.equal(h.cleared(), 1);
    assert.deepEqual(h.writes.at(-1), { text: "" });
    assert.equal(h.said.at(-1), "Command started. Shell mode off.");
    h.box.input("!", "insertText", false);
    h.box.input("rm -rf x", "insertText", false);
    h.box.run({ canSend: true, blocked: null, readOnly: false });
    h.setAnswer({ clientId: "c2", refused: "The kill guard refused `rm -rf x`." });
    await tick();
    assert.equal(h.box.text(), "rm -rf x");
    assert.equal(h.box.reason(), "The kill guard refused `rm -rf x`.");
    h.dispose();
  });

  test("a hand-back makes the box a message, the command kept in view as its text", () => {
    const h = harness({ stored: { text: "ls", mode: "shell" } });
    const t = h.box.asMessage();
    assert.equal(t, "!ls");
    h.box.setDraft(["handed back", t].join("\n\n"));
    assert.equal(h.box.mode(), "off");
    assert.deepEqual(h.writes.at(-1), { text: "handed back\n\n!ls" }, "saved with no mode");
    h.dispose();
  });

  test("a stopped reply's text that starts with ! comes back as a message, never a runnable command", () => {
    // As Composer's restored effect does: aheadOfDraft(reply, asMessage()), into an empty shell box.
    const h = harness();
    h.box.input("!", "insertText", false);
    assert.equal(h.box.mode(), "shell");
    h.box.setDraft(["!rm -rf build", h.box.asMessage()].filter((t) => t.trim()).join("\n\n"));
    assert.equal(h.box.mode(), "off");
    assert.equal(h.box.text(), "!rm -rf build");
    assert.equal(h.box.run({ canSend: true, blocked: null, readOnly: false }), "message");
    assert.equal(h.runs.length, 0);
    h.dispose();
  });
});

describe("Type anywhere", () => {
  test("a ! a key outside the box typed in is a plain !; the box stays a message box", () => {
    const h = harness();
    assert.equal(h.box.input("!", "insertText", false, true), null);
    assert.equal(h.box.mode(), "off");
    assert.equal(h.box.text(), "!");
    h.dispose();
  });

  test("the box takes typing only once the stored draft has arrived", async () => {
    const h = harness({ server: { text: "saved" } });
    assert.equal(h.box.loaded(), false);
    await tick();
    assert.equal(h.box.loaded(), true);
    h.dispose();
  });
});

describe("the whole output's window", () => {
  const pages = (texts: string[]) => {
    const asked: number[] = [];
    let at = 0;
    const offsets = texts.map((t) => ((at += t.length), at - t.length));
    const total = at;
    return {
      asked,
      fetch: (from: number) => {
        asked.push(from);
        const i = offsets.indexOf(from);
        return Promise.resolve({ output: texts[i]!, from, next: i + 1 < texts.length ? offsets[i + 1]! : null, bytes: total });
      },
    };
  };

  test("reads the first page, and Load More the next from where it stopped, to the end", async () => {
    const p = pages(["one\n", "two\n", "three\n"]);
    const r = solid.createRoot(() => createOutputReader({ fetch: p.fetch, gone: () => false }));
    await r.load();
    assert.equal(r.read()?.text, "one\n");
    // A double press while a page is out asks once.
    const a = r.load();
    void r.load();
    await a;
    assert.deepEqual(p.asked, [0, 4]);
    await r.load();
    assert.equal(r.read()?.text, "one\ntwo\nthree\n");
    assert.equal(r.read()?.next, null);
    await r.load();
    assert.deepEqual(p.asked, [0, 4, 8], "nothing more at the end");
  });

  test("a deleted file says it's gone; another failure keeps what was read and Try Again asks the same page", async () => {
    const gone = solid.createRoot(() => createOutputReader({ fetch: () => Promise.reject(Object.assign(new Error("404"), { status: 404 })), gone: (e) => (e as { status?: number }).status === 404 }));
    await gone.load();
    assert.equal(gone.error(), OUTPUT_GONE);

    let fail = false;
    const p = pages(["a", "b"]);
    const asked: number[] = [];
    const r = solid.createRoot(() =>
      createOutputReader({
        fetch: (from) => (asked.push(from), fail ? Promise.reject(new Error("500 Internal Server Error")) : p.fetch(from)),
        gone: () => false,
      }),
    );
    await r.load();
    fail = true;
    await r.load();
    assert.equal(r.error()?.kind, "failed");
    assert.match(r.error()?.body ?? "", /^500/);
    assert.equal(r.read()?.text, "a");
    fail = false;
    await r.load();
    assert.deepEqual(asked, [0, 1, 1]);
    assert.equal(r.read()?.text, "ab");
    assert.equal(r.error(), null);
  });

  test("a window closed while a page is out keeps nothing of it", async () => {
    let release!: () => void;
    const r = solid.createRoot(() =>
      createOutputReader({ fetch: (from) => new Promise((res) => (release = () => res({ output: "late", from, next: null, bytes: 4 }))), gone: () => false }),
    );
    const p = r.load();
    r.close();
    release();
    await p;
    assert.equal(r.read(), null);
  });
});
