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

// Chrome's sockets need a short temp path, whatever TMPDIR this run was given. Shortest first: an attempt
// nests its own folder below this one, so a temp dir that only just fits Chrome's limit doesn't.
const temp = chooseBrowserTemp(["/tmp", "/dev/shm", tmpdir()]);
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

test("on a site approved but not named, a page reaching another origin stops the look and asks", { skip: !browser }, async () => {
  const approvedOnly: DesignBrowseDeps = { ...deps, stores: { ...deps.stores, named: () => false, approvals: { isApproved: (o) => o === origin } } };
  const out = await designBrowse(parent, { url: `${origin}/third`, sizes: ["desktop"] }, approvedOnly);
  assert.equal(out.kind, "needs-site", JSON.stringify(out));
});

test("on your link, a part at a private address is left out and the look still ends with a picture", { skip: !browser }, async () => {
  const out = await designBrowse(parent, { url: `${origin}/third`, sizes: ["desktop"] }, deps);
  assert.equal(out.kind, "pictures", JSON.stringify(out));
});

test("a design's own page is pictured, its scripts run, and it can't leave", { skip: !browser }, async () => {
  const html = `<!doctype html><title>D</title><h1 id="h">Before</h1><script>document.getElementById("h").textContent="After"</script><img src="http://127.0.0.2:1/x.png">`;
  const r = await lookAtDesign(parent, "A", { sizes: ["desktop"] }, { context, readPage: () => html });
  assert.equal(r.shots.length, 1);
  assert.match(r.outline, /After/);
});

test("a version's views: one browser clicks each path from a fresh load, and finds the open tab, a dead control and a click that changes nothing", { skip: !browser }, async () => {
  const { checkVersionViews } = await import("./views");
  const html = `<!doctype html><html><head><style>[hidden]{display:none}section{height:600px}#plans{background:#cde}#usage{background:#edc}#billing{background:#dec}</style></head><body>
<div role="tablist"><button role="tab" type="button" aria-selected="true" data-sova-view="Plans" onclick="show('plans')">Plans</button><button role="tab" type="button" data-sova-view="Usage" onclick="show('usage')">Usage</button></div>
<button type="button" data-sova-view="Account menu" onclick="document.getElementById('menu').hidden=false">Account</button>
<div id="menu" hidden><a href="#billing" data-sova-view="Billing" data-sova-via="Account menu" onclick="show('billing')">Billing</a></div>
<button type="button" data-sova-view="Ghost" style="display:none">Ghost</button>
<button type="button" data-sova-view="Nothing">Nothing</button>
<section id="plans"><h1>Plans</h1></section><section id="usage" hidden><h1>Usage</h1></section><section id="billing" hidden><h1>Billing</h1></section>
<script>function show(id){for(const s of document.querySelectorAll("section"))s.hidden=s.id!==id;document.getElementById("menu").hidden=true}</script>
</body></html>`;
  const views = await checkVersionViews(parent, "A", 1, { context, readPage: () => html });
  assert.deepEqual(
    views?.map((v) => [v.name, v.state, v.start ?? false]),
    [["Plans", "ok", true], ["Usage", "ok", false], ["Account menu", "ok", false], ["Billing", "ok", false], ["Ghost", "unreachable", false], ["Nothing", "unchanged", false]],
  );
  assert.match(views?.find((v) => v.name === "Ghost")?.problem ?? "", /matched 0 visible controls/);
});
