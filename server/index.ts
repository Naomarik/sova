// Placeholder — the backend member replaces this file.
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();
app.get("/api/health", (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: 4800 }, (info) => {
  console.log(`pi-web server on http://localhost:${info.port}`);
});
