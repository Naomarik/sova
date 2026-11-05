import type { Context, Hono } from "hono";
import { pageOnlyRefusal } from "./page-only";
import { applySovaCard, refreshSovaNotes, sovaCardsInfo, SovaSettingsRefusal, withdrawSovaCard } from "./sova-settings";

/**
 * Sova-wide settings cards (§chat.create-mode/settings-cards; the list is in shared/sova-settings-reference.ts). Main
 * listener only. Apply is a trust grant, as a project card's is: only the person's own page on this computer.
 */

const NO_STORE = { "Cache-Control": "no-store" };

const APPLY_WORDS = {
  overseer: "Only you apply a settings card: the Overseer can't.",
  local: "A settings card is applied only on this machine.",
  chat: "A chat can't apply a settings card: apply it yourself on its card.",
  script: "A script can't apply a settings card: apply it yourself on its card.",
  extension: "An extension can't apply a settings card: apply it yourself on its card.",
};

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof SovaSettingsRefusal) return c.json({ error: err.message }, ((err as { status?: 404 | 409 }).status ?? 400) as 400 | 404 | 409);
      throw err;
    }
  };

export function registerSovaSettingsRoutes(app: Hono<any>): void {
  app.get("/api/settings/cards", async (c) => {
    await refreshSovaNotes();
    return c.json(sovaCardsInfo(), 200, NO_STORE);
  });
  app.post(
    "/api/settings/cards/:card/withdraw",
    handle(async (c) => {
      withdrawSovaCard(c.req.param("card") ?? "");
      return c.json(sovaCardsInfo(), 200, NO_STORE);
    }),
  );
  app.post(
    "/api/settings/apply",
    handle(async (c) => {
      const notYou = pageOnlyRefusal(c, APPLY_WORDS);
      if (notYou) return c.json({ error: notYou }, 403);
      const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b || typeof b.card !== "string" || typeof b.fingerprint !== "string") return c.json({ error: "Expected {card, fingerprint}: the card's id and the fingerprint it showed." }, 400);
      return c.json(await applySovaCard(b.card, b.fingerprint, b.input));
    }),
  );
}
