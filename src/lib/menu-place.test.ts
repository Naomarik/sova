// Run: pnpm test -- src/lib/menu-place.test.ts
// The menu places' extension lane (src/lib/menu-place.ts): which entries show in each of the five
// menus, in what order and how many; and running one, through the extension proxy, with the
// payload its menu built and the sentence it says.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { entryTitle, isSovaName, MENU_ROWS_MAX, MENU_RUN_TIMEOUT_MS, MENU_NAMES, menuGroups, menuName, runMenuEntry, sameGroups } from "./menu-place";
import { MENU_PLACES } from "../../shared/extension-offers";
import type { ExtensionInfo } from "../../shared/protocol";

const ext = (id: string, commands: NonNullable<ExtensionInfo["offers"]>["commands"], over: Partial<ExtensionInfo> = {}): ExtensionInfo => ({
  id,
  title: id.toUpperCase(),
  status: "ok",
  offers: { commands },
  ...over,
});

describe("menuGroups", () => {
  test("no extensions, or none that declare a session entry, is no group", () => {
    assert.deepEqual(menuGroups(undefined, "session"), []);
    assert.deepEqual(menuGroups([], "session"), []);
    const none = [
      { id: "plain", title: "Plain", status: "ok" } as ExtensionInfo,
      ext("cli", [{ name: "x", label: "X" }]),
      { id: "reply", title: "Reply", status: "ok", offers: { screens: ["reply"] } } as ExtensionInfo,
    ];
    assert.deepEqual(menuGroups(none, "session"), []);
  });

  test("one group per extension, in manifest order, entries in declared order, only session entries", () => {
    const got = menuGroups(
      [
        ext("b", [{ name: "one", label: "One", menu: "session", summary: "First" }, { name: "skip", label: "Skip" }, { name: "two", label: "Two", menu: "session" }]),
        ext("a", [{ name: "x", label: "X", menu: "session" }]),
      ],
      "session",
    );
    assert.deepEqual(got, [
      { extension: "b", title: "B", entries: [{ extension: "b", extensionTitle: "B", name: "one", label: "One", summary: "First" }, { extension: "b", extensionTitle: "B", name: "two", label: "Two" }] },
      { extension: "a", title: "A", entries: [{ extension: "a", extensionTitle: "A", name: "x", label: "X" }] },
    ]);
  });

  test("an extension whose backend is down adds nothing", () => {
    const list = [ext("up", [{ name: "x", label: "X", menu: "session" }]), ext("down", [{ name: "y", label: "Y", menu: "session" }], { status: "down", error: "connection refused" })];
    assert.deepEqual(
      menuGroups(list, "session").map((g) => g.extension),
      ["up"],
    );
  });

  test(`at most ${MENU_ROWS_MAX} rows in all, the first extensions first`, () => {
    const many = (id: string, n: number) => ext(id, Array.from({ length: n }, (_, i) => ({ name: `c${i}`, label: `C${i}`, menu: "session" as const })));
    const got = menuGroups([many("a", 5), many("b", 5), many("c", 2)], "session");
    assert.equal(MENU_ROWS_MAX, 8);
    assert.deepEqual(
      got.map((g) => [g.extension, g.entries.length]),
      [["a", 5], ["b", 3]],
    );
  });

  test("a poll that changes nothing is the same groups; any change of a row is not", () => {
    const list = [ext("a", [{ name: "x", label: "X", menu: "session", summary: "S" }])];
    assert.equal(sameGroups(menuGroups(list, "session"), menuGroups(structuredClone(list), "session")), true);
    const changed = (f: (e: ExtensionInfo) => void) => {
      const l = structuredClone(list);
      f(l[0]!);
      return sameGroups(menuGroups(list, "session"), menuGroups(l, "session"));
    };
    assert.equal(changed((e) => (e.title = "Z")), false);
    assert.equal(changed((e) => (e.offers!.commands![0]!.label = "Y")), false);
    assert.equal(changed((e) => (e.offers!.commands![0]!.summary = "T")), false);
    assert.equal(changed((e) => (e.offers!.commands![0]!.name = "y")), false);
    assert.equal(changed((e) => (e.status = "down")), false);
  });

  test("an entry that takes one of Sova's names is left out, whatever its case, spacing or ellipsis", () => {
    for (const name of MENU_NAMES) {
      const variants = [name, name.toUpperCase(), ` ${name.toLowerCase()} `, name.replace(/ /g, "  "), name.endsWith("…") ? name.slice(0, -1) : `${name}…`, name.endsWith("…") ? `${name.slice(0, -1)}...` : `${name}...`];
      for (const label of variants) {
        const got = menuGroups([ext("x", [{ name: "c", label, menu: "session" }, { name: "d", label: "Real One", menu: "session" }])], "session");
        assert.deepEqual(got[0]!.entries.map((e) => e.label), ["Real One"], JSON.stringify(label));
      }
    }
    assert.equal(menuName("  Move   to Group… "), "move to group");
    assert.equal(isSovaName("Copy Paths"), false, "a longer label is its own");
    assert.equal(isSovaName("Archive Issue"), false);
  });

  test("one list of Sova's names for every menu: a name of any menu is reserved in all four", () => {
    for (const place of MENU_PLACES) {
      const got = menuGroups([ext("x", [{ name: "a", label: "Archive", menu: place }, { name: "b", label: "Open", menu: place }, { name: "c", label: "Copy Path", menu: place }, { name: "d", label: "Real One", menu: place }])], place);
      assert.deepEqual(got[0]!.entries.map((e) => e.label), ["Real One"], place);
    }
  });

  test("each menu shows only its own entries", () => {
    const list = [ext("x", MENU_PLACES.map((place) => ({ name: place, label: `For ${place}`, menu: place })))];
    for (const place of MENU_PLACES) assert.deepEqual(menuGroups(list, place)[0]!.entries.map((e) => e.name), [place]);
  });

  test("the tooltip names the extension", () => {
    assert.equal(entryTitle({ extension: "t", extensionTitle: "Tickets", name: "file", label: "File Issue" }), "File Issue · From Tickets");
  });
});

describe("runMenuEntry", () => {
  const entry = { extension: "my ext", extensionTitle: "Tickets", name: "file", label: "File Issue" };
  const record = (answer: () => Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer();
    };
    return { calls, fetch };
  };

  test("POSTs each menu's payload as it is: the session menu's {session} is the same bytes as before", async () => {
    const payloads: Record<string, string>[] = [{ session: "s-1" }, { group: "g-1" }, { session: "s-2" }, { session: "s-3", entry: "e1" }, { project: "p-1", branch: "sova/x", session: "c-1" }];
    for (const payload of payloads) {
      const r = record(async () => new Response("{}", { status: 200 }));
      await runMenuEntry(entry, payload, r.fetch);
      assert.equal(r.calls[0]!.init.body, JSON.stringify(payload));
    }
    const r = record(async () => new Response("{}", { status: 200 }));
    await runMenuEntry(entry, { session: "s-1" }, r.fetch);
    assert.equal(r.calls[0]!.init.body, '{"session":"s-1"}');
  });

  test("POSTs {session} to the extension's command through the proxy, and says it was sent", async () => {
    const r = record(async () => new Response("{}", { status: 200 }));
    assert.equal(await runMenuEntry(entry, { session: "s-1" }, r.fetch), "Sent to Tickets.");
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.url, "/ext/my%20ext/api/commands/file");
    assert.equal(r.calls[0]!.init.method, "POST");
    assert.equal(r.calls[0]!.init.body, JSON.stringify({ session: "s-1" }));
    assert.equal(r.calls[0]!.init.credentials, "same-origin");
  });

  test("a backend that takes the call and never answers: no answer, after the timeout", async () => {
    assert.equal(MENU_RUN_TIMEOUT_MS, 10_000);
    // Never settles on its own: only the run's own signal ends it.
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const stuck = new Promise<string>((r) => setTimeout(() => r("still waiting after 3 s"), 3_000).unref?.());
    assert.equal(await Promise.race([runMenuEntry(entry, { session: "s-1" }, hang, 50), stuck]), "Tickets isn't answering.");
  });

  test("a refusal says the status; no answer says so", async () => {
    assert.equal(await runMenuEntry(entry, { session: "s-1" }, record(async () => new Response("no", { status: 502 })).fetch), "Tickets answered HTTP 502.");
    assert.equal(
      await runMenuEntry(entry, { session: "s-1" }, record(() => Promise.reject(new TypeError("failed"))).fetch),
      "Tickets isn't answering.",
    );
  });
});
