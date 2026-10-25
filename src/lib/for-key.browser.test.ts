// Run: pnpm test -- src/lib/for-key.browser.test.ts (Solid's reactive build).
// A refresh of the session list mints every org, project and row afresh, equal but new (§app.session-list/content-rules,
// "Only the user scrolls the list"): keyed by id, each one is built once and keeps what it built, and its accessor
// follows the fresh object. A plain `<For>` over the same data builds everything again: the failure this replaces.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSX } from "solid-js";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { ForKey } = await import("./for-key");

interface Row {
  path: string;
  title: string;
}
interface Project {
  id: string;
  rows: Row[];
}
interface Org {
  id: string;
  name: string;
  projects: Project[];
}

/** Fresh objects, equal data: what every poll of the list hands the sidebar. */
const fresh = (orgs: Org[]): Org[] => orgs.map((o) => ({ ...o, projects: o.projects.map((p) => ({ ...p, rows: p.rows.map((r) => ({ ...r })) })) }));

const DATA: Org[] = ["acme", "globex", "rakiba"].map((o) => ({
  id: `org_${o}`,
  name: o,
  projects: [0, 1].map((p) => ({ id: `prj_${o}${p}`, rows: [0, 1, 2].map((i) => ({ path: `/s/${o}${p}-${i}.jsonl`, title: `${o} ${p} ${i}` })) })),
}));

type Built = { kind: string; key: string; read: () => unknown };
/** A built thing stands where a DOM node would: `ForKey`'s children return JSX. */
const el = (b: Built): JSX.Element => b as unknown as JSX.Element;
/** What a `ForKey` returns, read back: the list of what it built. */
const built = (x: JSX.Element) => () => (x as unknown as () => Built[])();

/** The sidebar's nesting (org → project → row), each level keyed, as plain objects instead of DOM nodes. */
function tree(orgs: () => Org[]) {
  const builds: string[] = [];
  const out = solid.createRoot(() => {
    const view = ForKey<Org>({
      get each() {
        return orgs();
      },
      by: (o) => o.id,
      children: (o) => {
        builds.push(`org ${o().id}`);
        const projects = ForKey<Project>({
          get each() {
            return o().projects;
          },
          by: (p) => p.id,
          children: (p) => {
            builds.push(`project ${p().id}`);
            const rows = ForKey<Row>({
              get each() {
                return p().rows;
              },
              by: (r) => r.path,
              children: (r) => {
                builds.push(`row ${r().path}`);
                return el({ kind: "row", key: r().path, read: () => r().title });
              },
            });
            return el({ kind: "project", key: p().id, read: built(rows) });
          },
        });
        return el({ kind: "org", key: o().id, read: built(projects) });
      },
    });
    return built(view);
  });
  return { view: out, builds };
}

const flatten = (b: readonly Built[]): Built[] => b.flatMap((x) => [x, ...(x.kind === "row" ? [] : flatten(x.read() as Built[]))]);

test("fresh but equal data: every org, project and row keeps the object it built, and nothing is built again", () => {
  const [orgs, setOrgs] = solid.createSignal(DATA);
  const { view, builds } = tree(orgs);
  const first = flatten(view());
  assert.equal(first.length, 3 + 6 + 18);
  const count = builds.length;
  setOrgs(fresh(DATA));
  const second = flatten(view());
  assert.equal(builds.length, count, "a refresh builds nothing");
  assert.equal(second.length, first.length);
  second.forEach((b, i) => assert.equal(b, first[i], `${b.kind} ${b.key} is the same object`));
});

test("a changed row is updated in place; a row arriving above builds only itself, and the rows under it stay", () => {
  const [orgs, setOrgs] = solid.createSignal(DATA);
  const { view, builds } = tree(orgs);
  const first = flatten(view());
  const rakibaRow = first.find((b) => b.key === "/s/rakiba1-2.jsonl")!;
  const next = fresh(DATA);
  next[0]!.projects[0]!.rows[0]!.title = "renamed";
  next[0]!.projects[0]!.rows.unshift({ path: "/s/new.jsonl", title: "new" });
  const count = builds.length;
  setOrgs(next);
  assert.deepEqual(builds.slice(count), ["row /s/new.jsonl"], "only the new row is built");
  const second = flatten(view());
  assert.equal(second.find((b) => b.key === "/s/rakiba1-2.jsonl"), rakibaRow, "the row at the bottom is the same object");
  assert.equal(second.find((b) => b.key === "/s/acme0-0.jsonl")!.read(), "renamed", "its accessor reads the fresh title");
});

test("the failure it replaces: a plain <For> over the same fresh data builds every org again", () => {
  const [orgs, setOrgs] = solid.createSignal(DATA);
  let builds = 0;
  const view = solid.createRoot(() =>
    solid.For({
      get each() {
        return orgs();
      },
      children: (o: Org) => {
        builds++;
        return o.id as unknown as JSX.Element;
      },
    }),
  ) as unknown as () => string[];
  const first = view();
  setOrgs(fresh(DATA));
  assert.deepEqual(view(), first);
  assert.equal(builds, 6, "built twice over: three orgs, then the same three again");
});

test("a removed key's accessor still reads its last item while it is disposed", () => {
  const [orgs, setOrgs] = solid.createSignal(DATA);
  let rakiba: (() => Org) | null = null;
  solid.createRoot(() =>
    ForKey<Org>({
      get each() {
        return orgs();
      },
      by: (o) => o.id,
      children: (o) => {
        if (o().id === "org_rakiba") rakiba = o;
        return null;
      },
    }),
  );
  setOrgs(DATA.slice(0, 2));
  assert.equal(rakiba!().name, "rakiba");
});
