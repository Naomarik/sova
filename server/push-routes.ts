import { Hono, type Context } from "hono";
import type { PushInfo } from "../shared/protocol";
import { sendTest } from "./push";
import {
  defaultPushSettings,
  pushSettingsFile,
  readDevices,
  readOrCreateVapid,
  readPushSettings,
  removeDevice,
  upsertDevice,
  wireDevice,
  writePushSettings,
} from "./push-store";

// /api/push (shared/protocol.ts, the Web Push block). Mounted with app.route in index.ts. Every
// answer is no-store; none carries a device's endpoint or keys.

const NO_STORE = { "Cache-Control": "no-store" };

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function pushInfo(): PushInfo {
  return {
    publicKey: readOrCreateVapid().publicKey,
    devices: readDevices().map(wireDevice),
    settings: readPushSettings(),
    defaults: defaultPushSettings(),
    file: pushSettingsFile(),
  };
}

export const pushRoutes = new Hono();

pushRoutes.get("/", (c) => {
  try {
    return c.json(pushInfo(), 200, NO_STORE);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500, NO_STORE);
  }
});

pushRoutes.put("/settings", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Expected a JSON object." }, 400, NO_STORE);
  const saved = writePushSettings(body);
  if ("error" in saved) return c.json({ error: saved.error }, 400, NO_STORE);
  return c.json({ settings: saved, defaults: defaultPushSettings(), file: pushSettingsFile() }, 200, NO_STORE);
});

pushRoutes.post("/subscribe", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Expected a JSON object." }, 400, NO_STORE);
  const r = upsertDevice({ subscription: body.subscription, label: body.label, resync: body.resync, replaces: body.replaces });
  if ("error" in r) return c.json({ error: r.error }, 400, NO_STORE);
  if ("removed" in r) return c.json({ error: "This device was removed from phone notifications. Turn them on here again to add it back." }, 410, NO_STORE);
  return c.json(wireDevice(r.device), 200, NO_STORE);
});

pushRoutes.delete("/subscribe", async (c) => {
  const body = await jsonBody(c);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
  const id = typeof body?.id === "string" && /^[0-9a-f]{16}$/.test(body.id) ? body.id : undefined;
  if (!endpoint && !id) return c.json({ error: "Name the device: { endpoint } or { id }." }, 400, NO_STORE);
  return c.json({ removed: removeDevice(endpoint ? { endpoint } : { id }, true) }, 200, NO_STORE);
});

pushRoutes.post("/test", async (c) => {
  const body = (await jsonBody(c)) ?? {};
  const id = typeof body.id === "string" ? body.id : undefined;
  const r = await sendTest(id);
  if ("error" in r) return c.json({ error: r.error }, r.status, NO_STORE);
  return c.json(r, 200, NO_STORE);
});
