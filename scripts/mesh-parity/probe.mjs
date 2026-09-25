// Preloaded into the server under test (node --import <this> --import tsx server/index.ts): records
// WHO creates a timer, a file watcher, a listening server or an outbound request, by the first
// stack frame in the app's own code, and writes the tally at exit to $PARITY_PROBE_OUT.
// This answers "does the mesh, while off, start a timer / watch a file / dial out?" directly,
// where an event-loop wakeup count could only hint at it.

import { writeFileSync } from "node:fs";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import timers from "node:timers";
import { syncBuiltinESMExports } from "node:module";

const OUT = process.env.PARITY_PROBE_OUT;
const ROOT = process.cwd() + "/";
const sites = new Map();

/** The first frame in the app (server/, shared/, pi-config/), as "<file>" relative to the tree. */
function site() {
  const stack = new Error().stack?.split("\n").slice(3) ?? [];
  for (const line of stack) {
    const m = /(?:file:\/\/)?(\/[^():]+):\d+:\d+/.exec(line);
    if (!m) continue;
    const file = m[1];
    if (file.includes("/node_modules/") || !file.startsWith(ROOT)) continue;
    return file.slice(ROOT.length);
  }
  return "<outside the app>";
}
const note = (kind) => {
  const key = `${kind} ${site()}`;
  sites.set(key, (sites.get(key) ?? 0) + 1);
};

const wrap = (obj, name, kind) => {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function (...args) {
    note(kind);
    return orig.apply(this, args);
  };
};
wrap(globalThis, "setInterval", "setInterval");
wrap(globalThis, "setTimeout", "setTimeout");
wrap(timers, "setInterval", "setInterval");
wrap(timers, "setTimeout", "setTimeout");
wrap(fs, "watch", "fs.watch");
wrap(fs, "watchFile", "fs.watchFile");
wrap(net.Server.prototype, "listen", "listen");
wrap(http, "request", "http.request");
wrap(https, "request", "https.request");
wrap(globalThis, "fetch", "fetch");
wrap(net, "connect", "net.connect");
wrap(net, "createConnection", "net.connect");
syncBuiltinESMExports();

process.on("exit", () => {
  if (!OUT) return;
  try {
    writeFileSync(OUT, JSON.stringify(Object.fromEntries([...sites].sort()), null, 1) + "\n");
  } catch {}
});
