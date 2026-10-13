// Test only (the chat-runtime trial, al_3 stage 3): firing the Overseer's brief on demand in a hermetic
// server. Mounted at /api/test only with SOVA_CHAT_TEST_SERVED=1 (server/app.ts), behind the usual
// sign-in; never in production.
//   POST /api/test/overseer/tick   one check now, the 10-minute gap ignored: {briefed} or {error}
//   POST /api/test/overseer/brief  {body}: one brief, as a schedule or the auto-resume report sends it
import { Hono } from "hono";
import { briefOverseer, tickNowForTest } from "./overseer";

export const chatTrialRoutes = new Hono();

chatTrialRoutes.post("/overseer/tick", async (c) => c.json(await tickNowForTest({ ignoreGap: true })));

chatTrialRoutes.post("/overseer/brief", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { body?: unknown };
  if (typeof body.body !== "string" || !body.body.trim()) return c.json({ error: "body must be a non-blank string" }, 400);
  try {
    await briefOverseer(body.body);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) });
  }
});
