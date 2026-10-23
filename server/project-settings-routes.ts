import type { Context, Hono } from "hono";
import { OrgError } from "./org-error";
import { OVERSEER_SENDER_HEADER, overseerSender } from "./overseer-sender";
import { pageOnlyRefusal } from "./page-only";
import { projectOf } from "./project-overseer-store";
import { applyCard, fieldLabel, readHistory, valueText, settingsInfo, SettingsRefusal, undoRow, withdrawCard } from "./project-settings";
import { SettingsGitError } from "./project-settings-git";

/**
 * A project's settings (§app.project-overseer/settings; the list is in shared/project-settings.ts). Main listener only.
 * Apply (and Land, `card: "local"`) is a trust grant: only the operator's own page on this machine.
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message }, err.status);
      if (err instanceof SettingsRefusal) return c.json({ error: err.message }, 400);
      if (err instanceof SettingsGitError) return c.json({ error: `Git: ${err.message}` }, 409);
      throw err;
    }
  };

const pid = (c: Context): string => {
  const id = c.req.param("pid") ?? "";
  projectOf(id);
  return id;
};

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {}
  throw new OrgError("Expected a JSON object body");
}

const APPLY_WORDS = {
  overseer: "Only you apply a settings card: the Overseer can't.",
  local: "A settings card is applied only on this machine.",
  chat: "A chat can't apply a settings card: apply it yourself on its card.",
  script: "A script can't apply a settings card: apply it yourself on its card.",
  extension: "An extension can't apply a settings card: apply it yourself on its card.",
};

export function registerProjectSettingsRoutes(app: Hono<any>): void {
  const base = "/api/projects/:pid/settings";
  app.get(base, handle(async (c) => c.json(await settingsInfo(pid(c)), 200, NO_STORE)));
  app.get(`${base}/history`, handle(async (c) => c.json([...readHistory(pid(c))].reverse().map((r) => ({ ...r, label: fieldLabel(r.field), fromText: valueText(r.field, r.from), toText: valueText(r.field, r.to) })), 200, NO_STORE)));
  app.post(
    `${base}/undo`,
    handle(async (c) => {
      const id = pid(c);
      const b = await body(c);
      if (typeof b.id !== "string") throw new OrgError("Expected {id}: a settings history line's id (h…).");
      return c.json(await undoRow(id, b.id, { fromOverseer: !!overseerSender(c.req.header(OVERSEER_SENDER_HEADER)) }));
    }),
  );
  app.post(
    `${base}/cards/:card/withdraw`,
    handle(async (c) => {
      const id = pid(c);
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
      const fingerprint = b && typeof b === "object" ? b.fingerprint : undefined;
      if (fingerprint !== undefined && typeof fingerprint !== "string") throw new OrgError("fingerprint must be the text the card showed.");
      await withdrawCard(id, c.req.param("card") ?? "", { operator: true, fingerprint });
      return c.json(await settingsInfo(id), 200, NO_STORE);
    }),
  );
  app.post(
    `${base}/apply`,
    handle(async (c) => {
      const notYou = pageOnlyRefusal(c, APPLY_WORDS);
      if (notYou) return c.json({ error: notYou }, 403);
      const id = pid(c);
      const b = await body(c);
      if (typeof b.card !== "string" || typeof b.fingerprint !== "string") throw new OrgError("Expected {card, fingerprint}: the card's id and the fingerprint it showed.");
      return c.json(await applyCard(id, b.card, b.fingerprint));
    }),
  );
}
