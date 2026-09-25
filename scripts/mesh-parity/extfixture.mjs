// A fixture extension for the parity run: a loopback echo backend (HTTP + WS) and a one-file UI,
// installed through <agent dir>/sova/extensions.json. The mesh reuses the extension proxy for
// /peer/<id>/*, so this is where a refactor of that proxy would show: status codes, headers,
// bodies, and WS close codes mirrored end to end.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

export async function startEchoBackend(tree, port) {
  const { WebSocketServer } = createRequire(`${tree}/package.json`)("ws");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    const code = Number(url.searchParams.get("code") ?? 200);
    res.writeHead(code, { "content-type": "application/json", "x-echo": "1", "set-cookie": "echo=1; Path=/" });
    res.end(JSON.stringify({ method: req.method, path: url.pathname, query: url.search, body: Buffer.concat(chunks).toString(), contentType: req.headers["content-type"] ?? null, hasCookie: "cookie" in req.headers }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ hello: new URL(req.url, "http://x").pathname }));
      ws.on("message", (d) => {
        const text = d.toString();
        if (text.startsWith("close:")) ws.close(Number(text.slice(6)), "echo-close");
        else ws.send(`echo:${text}`);
      });
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { stop: () => new Promise((r) => { wss.close(); server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** Install the manifest: one live extension, one whose backend is down, one malformed entry. */
export function installExtensions(agentDir, root, echoPort, downPort) {
  const dist = join(root, "ext-echo-dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<!doctype html><html><head><title>Echo</title><link rel="stylesheet" href="/design/base.css"></head><body><h1>Echo extension</h1><script src="assets/app.js"></script></body></html>\n`);
  writeFileSync(join(dist, "assets", "app.js"), `document.body.dataset.ready = "1";\n`);
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  writeFileSync(
    join(agentDir, "sova", "extensions.json"),
    JSON.stringify({
      version: 1,
      extensions: [
        { id: "echo", title: "Echo", description: "Parity fixture extension", icon: "terminal", dist, api: `http://127.0.0.1:${echoPort}` },
        { id: "down", title: "Down", dist, api: `http://127.0.0.1:${downPort}` },
        { id: "bad id", dist: "relative", api: "http://example.com" },
      ],
    }, null, 2) + "\n",
  );
}

/** REST steps through the proxy. */
export function extensionSteps() {
  const G = (name, url) => ({ name, method: "GET", url, headers: {} });
  return [
    G("ext:list", "/api/extensions"),
    G("ext:echo-redirect", "/ext/echo"),
    G("ext:echo-index", "/ext/echo/"),
    G("ext:echo-asset", "/ext/echo/assets/app.js"),
    G("ext:echo-missing-asset", "/ext/echo/assets/nope.js"),
    G("ext:echo-traversal", "/ext/echo/..%2f..%2fetc%2fpasswd"),
    G("ext:echo-api-get", "/ext/echo/api/thing?x=1&y=two"),
    { name: "ext:echo-api-post", method: "POST", url: "/ext/echo/api/thing", body: '{"a":1}', headers: { "content-type": "application/json", cookie: "sova=secret" } },
    { name: "ext:echo-api-put", method: "PUT", url: "/ext/echo/api/x", body: "plain", headers: { "content-type": "text/plain" } },
    G("ext:echo-api-500", "/ext/echo/api/fail?code=500"),
    G("ext:echo-api-404", "/ext/echo/api/fail?code=404"),
    G("ext:echo-ws-plain-get", "/ext/echo/ws/echo"),
    G("ext:down-api", "/ext/down/api/x"),
    G("ext:down-index", "/ext/down/"),
    G("ext:list-after", "/api/extensions"),
  ];
}

/** WS through the proxy: open, echo twice, then ask the backend to close with a custom code. */
export async function extensionWs(collect, tree, wsBase) {
  const out = {};
  let sent = false;
  out["ext-ws:echo"] = await collect(tree, `${wsBase}/ext/echo/ws/echo?q=1`, {
    ms: 5000,
    onMessage: (m, ws) => {
      if (sent) return;
      sent = true;
      ws.send("one");
      ws.send("two");
      setTimeout(() => ws.send("close:4321"), 300);
    },
    raw: true,
  });
  out["ext-ws:down"] = await collect(tree, `${wsBase}/ext/down/ws/echo`, { ms: 3000, raw: true });
  return out;
}
