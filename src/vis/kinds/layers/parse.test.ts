import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { LayersSpec } from "./parse";

const ok = <T>(kind: string, body: string): T => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as T;
};

test("layers: layers top to bottom with items, note, tone", () => {
  const s = ok<LayersSpec>("layers", 'Browser | Solid app, "Service worker, PWA" | accent\nServer | Hono, ws | REST + 2 sockets\nDisk | | muted');
  assert.deepEqual(s.layers, [
    { label: "Browser", items: ["Solid app", "Service worker, PWA"], tone: "accent" },
    { label: "Server", items: ["Hono", "ws"], note: "REST + 2 sockets" },
    { label: "Disk", items: [], tone: "muted" },
  ]);
});

test("layers: mark a layer by its label; errors say what to write", () => {
  const s = ok<LayersSpec>("layers", 'Browser | Solid app\n"Edge cache" | CDN\nmark "Edge cache" warn "stale for 60s"\nmark Browser');
  assert.deepEqual(s.emphasis, [
    { key: "1", tone: "warn", note: "stale for 60s", n: 1 },
    { key: "0", tone: "accent" },
  ]);
  const err = (body: string) => {
    const r = parseVis("layers", body);
    assert.equal(r.ok, false);
    return (r as { message: string }).message;
  };
  assert.match(err("Browser | a\nmark Server"), /no layer Server/);
  assert.match(err("Browser"), /a layer is/);
  assert.match(err("Browser | a | b | c | d"), /a layer is/);
});
