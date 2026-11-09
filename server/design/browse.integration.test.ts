import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { designBrowse, type DesignBrowseDeps } from "./browse";
import { lookAtDesign } from "./look";
import { discoverTourBrowser } from "../tours/browser";
import { chooseBrowserTemp } from "../settings-browser-temp.test.helper";

// Chrome's sockets need a short temp path, whatever TMPDIR this run was given.
const temp = chooseBrowserTemp();
if ("dir" in temp) {
  process.env.TMPDIR = temp.dir;
  after(() => temp.cleanup());
}
let browser = "dir" in temp;
try { discoverTourBrowser(); } catch { browser = false; }
const dir = mkdtempSync(join(tmpdir(), "sb-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const sessionFile = join(dir, "c.jsonl");
writeFileSync(sessionFile, "");
const context = async () => ({ sessionId: "c", sessionFile, cwd: dir, agentDir: dir, sandbox: { on: false } });
const parent = { sessionId: "c", path: sessionFile };

let writes = 0;
const pages: Record<string, string> = {
  "/": `<!doctype html><title>Home</title><h1>Home</h1><a href="/settings">Settings</a><form action="/save" method="post"><button>Save</button></form><button id="ajax" type="button" onclick="fetch('/save',{method:'POST'});document.body.append('sent')">Ajax</button>`,
  "/settings": `<!doctype html><title>Settings</title><h1>Your settings</h1>`,
  "/third": `<!doctype html><title>T</title><h1>Third</h1><img src="http://127.0.0.2:1/x.png">`,
};
const site: Server = createServer((req, res) => {
  if (req.method !== "GET") { writes++; res.writeHead(200); return res.end("ok"); }
  const body = pages[req.url ?? ""];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
  res.end(body ?? "no");
});
await new Promise<void>((ok) => site.listen(0, "127.0.0.1", () => ok()));
after(() => new Promise<void>((done) => site.close(() => done())));
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

const deps: DesignBrowseDeps = {
  context,
  registry: () => ({ instances: [] }) as never,
  stores: { approvals: { isApproved: () => false }, accounts: { forOrigin: () => null }, signIns: { login: () => undefined, takeCode: () => undefined, forget: () => {}, storage: () => undefined, setStorage: () => {} }, named: (o) => o === origin },
};
const click = (name: string, role = "link") => ({ op: "click", target: { kind: "role", role, name } });

test("walks to a screen by clicking a link, and pictures it at both widths", { skip: !browser }, async () => {
  const out = await designBrowse(parent, { url: `${origin}/`, actions: [click("Settings")] }, deps);
  assert.equal(out.kind, "pictures", JSON.stringify(out));
  if (out.kind !== "pictures") return;
  assert.deepEqual(out.shots.map((s) => s.size), ["desktop", "phone"]);
  assert.ok(out.shots.every((s) => s.png.length > 1000));
  assert.match(out.outline, /Your settings/);
});

test("a click on a form's submit button is refused and nothing is written", { skip: !browser }, async () => {
  const before = writes;
  const out = await designBrowse(parent, { url: `${origin}/`, sizes: ["desktop"], actions: [click("Save", "button")] }, deps);
  assert.equal(out.kind, "refused", JSON.stringify(out));
  assert.match(out.kind === "refused" ? out.message : "", /never submits forms/);
  assert.equal(writes, before);
});

test("a write the page sends on a click is stopped before it reaches the site", { skip: !browser }, async () => {
  const before = writes;
  const out = await designBrowse(parent, { url: `${origin}/`, sizes: ["desktop"], actions: [click("Ajax", "button")] }, deps);
  assert.equal(out.kind, "pictures", JSON.stringify(out));
  assert.equal(writes, before);
});

test("a page reaching an unapproved origin stops the look and asks", { skip: !browser }, async () => {
  const out = await designBrowse(parent, { url: `${origin}/third`, sizes: ["desktop"] }, deps);
  assert.equal(out.kind, "needs-site", JSON.stringify(out));
});

test("a design's own page is pictured, its scripts run, and it can't leave", { skip: !browser }, async () => {
  const html = `<!doctype html><title>D</title><h1 id="h">Before</h1><script>document.getElementById("h").textContent="After"</script><img src="http://127.0.0.2:1/x.png">`;
  const r = await lookAtDesign(parent, "A", { sizes: ["desktop"] }, { context, readPage: () => html });
  assert.equal(r.shots.length, 1);
  assert.match(r.outline, /After/);
});
