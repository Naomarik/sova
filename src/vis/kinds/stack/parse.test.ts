import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { StackSpec } from "./parse";

const ok = <T>(kind: string, body: string): T => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as T;
};

test("stack: layers top to bottom with items, note, tone", () => {
  const s = ok<StackSpec>("stack", 'Browser | Solid app, "Service worker, PWA" | accent\nServer | Hono, ws | REST + 2 sockets\nDisk | | muted');
  assert.deepEqual(s.layers, [
    { label: "Browser", items: ["Solid app", "Service worker, PWA"], tone: "accent" },
    { label: "Server", items: ["Hono", "ws"], note: "REST + 2 sockets" },
    { label: "Disk", items: [], tone: "muted" },
  ]);
});
