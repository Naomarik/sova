// Run: node scripts/run-tests.mjs server/preview-serve.integration.test.ts (real sockets on 127.0.0.1).
// Builds a throwaway tree in the OS temp dir and removes it afterwards.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { StaticServeError, startStaticServe, staticServes, stopStaticServe } from "./preview-serve";

const base = mkdtempSync(join(tmpdir(), "sova-preview-serve-test-"));
const root = join(base, "site");
mkdirSync(join(root, "assets"), { recursive: true });
mkdirSync(join(root, ".git"));
mkdirSync(join(root, ".sova"));
mkdirSync(join(root, "sub", ".hidden"), { recursive: true });
mkdirSync(join(root, "noindex"));
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "index.html"), "<h1>home</h1>");
writeFileSync(join(root, "docs", "index.html"), "<h1>docs</h1>");
writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
writeFileSync(join(root, "assets", "style.css"), "body{}");
writeFileSync(join(root, "noindex", "a.txt"), "a");
writeFileSync(join(root, ".git", "config"), "[core]");
writeFileSync(join(root, ".sova", "x.json"), "{}");
writeFileSync(join(root, ".env"), "SECRET=1");
writeFileSync(join(root, "sub", ".hidden", "k.txt"), "k");
writeFileSync(join(root, "sub", ".npmrc"), "t");
writeFileSync(join(base, "outside.txt"), "outside");
symlinkSync(join(base, "outside.txt"), join(root, "escape.txt"));
symlinkSync(base, join(root, "escape-dir"));
symlinkSync(join(root, ".git", "config"), join(root, "gitlink"));
symlinkSync(join(root, "assets", "app.js"), join(root, "inner.js"));

after(async () => {
  for (const s of staticServes()) await stopStaticServe(s.id);
  rmSync(base, { recursive: true, force: true });
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request: the path goes out as written (no URL normalising). */
function get(port: number, path: string, method = "GET", host = "127.0.0.1"): Promise<Res> {
  return new Promise((ok, fail) => {
    const req = request({ host, port, path, method, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(port, host, () => s.close(() => ok(true)));
  });
}

test("serves index.html and assets with their types", async () => {
  const { port } = await startStaticServe({ id: "pv_a", root });
  const home = await get(port, "/");
  assert.equal(home.status, 200);
  assert.equal(home.body, "<h1>home</h1>");
  assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(home.headers["x-content-type-options"], "nosniff");
  assert.equal(home.headers["server"], undefined);
  const js = await get(port, "/assets/app.js?v=1");
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal((await get(port, "/assets/style.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await get(port, "/docs/")).body, "<h1>docs</h1>");
  const bare = await get(port, "/docs?x=1");
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.location, "/docs/?x=1");
  // A symlink that stays inside the root serves.
  assert.equal((await get(port, "/inner.js")).status, 200);
  const head = await get(port, "/assets/app.js", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["content-length"], String("console.log(1)".length));
});

test("refuses dot paths, traversal, symlink escapes and listings with a plain 404", async () => {
  const { port } = await startStaticServe({ id: "pv_a", root });
  const refused = [
    "/.git",
    "/.git/",
    "/.git/config",
    "/%2egit/config",
    "/.sova/x.json",
    "/.env",
    "/sub/.hidden/k.txt",
    "/sub/.npmrc",
    "/../outside.txt",
    "/%2e%2e/outside.txt",
    "/assets/%2e%2e/%2e%2e/outside.txt",
    "/..%2foutside.txt",
    "/assets/..%2f..%2foutside.txt",
    "/assets%2f..%2f..%2foutside.txt",
    "/..%5coutside.txt",
    "/escape.txt",
    "/escape-dir/outside.txt",
    "/gitlink",
    "/noindex/",
    "/nothing.html",
    "/%zz",
    "/a%00b",
  ];
  for (const path of refused) {
    const res = await get(port, path);
    assert.equal(res.status, 404, path);
    assert.equal(res.body, "Not Found\n", path);
    assert.equal(res.headers["x-content-type-options"], "nosniff", path);
  }
  // A directory without the slash still never lists.
  assert.equal((await get(port, "/escape-dir")).status, 404);
  // Only redirects to a path on this origin.
  const r = await get(port, "//docs");
  assert.equal(r.headers.location, "/docs/");
});

test("405 for anything but GET and HEAD", async () => {
  const { port } = await startStaticServe({ id: "pv_a", root });
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const res = await get(port, "/", m);
    assert.equal(res.status, 405, m);
    assert.equal(res.headers.allow, "GET, HEAD");
  }
});

test("a missing root answers 404 without crashing", async () => {
  const { port } = await startStaticServe({ id: "pv_missing", root: join(base, "not-yet") });
  assert.equal((await get(port, "/")).status, 404);
  assert.equal((await get(port, "/index.html")).status, 404);
  await stopStaticServe("pv_missing");
});

test("binds 127.0.0.1 only; start is idempotent; stop frees the port", async () => {
  const first = await startStaticServe({ id: "pv_b", root });
  assert.deepEqual(await startStaticServe({ id: "pv_b", root }), first);
  assert.deepEqual(
    staticServes().find((s) => s.id === "pv_b"),
    { id: "pv_b", root, port: first.port },
  );
  // Nothing on another address of this host answers on the port.
  await assert.rejects(get(first.port, "/", "GET", "::1"));
  assert.equal(await portFree(first.port), false);
  assert.equal(await stopStaticServe("pv_b"), true);
  assert.equal(await stopStaticServe("pv_b"), false);
  assert.equal(await portFree(first.port), true);
  assert.equal(staticServes().some((s) => s.id === "pv_b"), false);
});

test("rebinds to a recorded port, and says so when it is taken", async () => {
  const { port } = await startStaticServe({ id: "pv_c", root });
  await stopStaticServe("pv_c");
  const again = await startStaticServe({ id: "pv_c", root, port });
  assert.equal(again.port, port);
  assert.equal((await get(port, "/")).status, 200);
  // Another id on the same recorded port: taken.
  await assert.rejects(
    startStaticServe({ id: "pv_d", root, port }),
    (e: unknown) => e instanceof StaticServeError && e.code === "port-taken" && e.message.includes(String(port)),
  );
  assert.equal(staticServes().some((s) => s.id === "pv_d"), false);
  // Another root for the same id keeps its port.
  const other = join(base, "other");
  mkdirSync(other);
  writeFileSync(join(other, "index.html"), "other");
  assert.equal((await startStaticServe({ id: "pv_c", root: other })).port, port);
  assert.equal((await get(port, "/")).body, "other");
  await stopStaticServe("pv_c");
});
