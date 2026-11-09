// The page's routes for a chat's design coordinator. Each names the parent chat by `?path=`; a request is the
// user's own click or typed words, and none of them starts a turn in the main chat.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { isDesignSignInAnswer, type DesignSignInAnswer } from "../../shared/design";
import { notPage } from "../page-only";
import { resolveSessionPath } from "../paths";
import { idOf } from "../sessions-index";
import type { BrowseParent } from "./browse";
import { answerCoordinator, confirmRun, messageCoordinator, shotsDir } from "./coordinator";

const BAD_PATH = "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)";

function parentOf(c: Context): BrowseParent | null {
  const path = resolveSessionPath(c.req.query("path"));
  if (!path || !existsSync(path)) return null;
  return { sessionId: idOf(path), path };
}

const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  try {
    const v = await c.req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const YOUR_CLICK = "Only your own click on the coordinator's card in Sova's page answers this.";
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function mountCoordinatorRoutes(app: Hono): void {
  app.post("/api/design/runs/:run/confirm", async (c) => {
    if (notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const b = await bodyOf(c);
    if (b.verdict !== "design" && b.verdict !== "not-this") return c.json({ error: 'verdict must be "design" or "not-this".' }, 400);
    try {
      await confirmRun(p, c.req.param("run"), b.verdict, text(b.text).trim() || undefined);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: message(err) }, 409);
    }
  });

  app.post("/api/design/coordinator/message", async (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const b = await bodyOf(c);
    const words = text(b.text).trim();
    if (!words || !text(b.key)) return c.json({ error: "A message needs its text and a key." }, 400);
    try {
      // Only the person's own page vouches for an address it names (a script's or a chat's call still delivers).
      return c.json(await messageCoordinator(p, words, `user:${text(b.key)}`, notPage(c) === null));
    } catch (err) {
      return c.json({ error: message(err) }, 409);
    }
  });

  app.post("/api/design/coordinator/answer", async (c) => {
    if (notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const b = await bodyOf(c);
    const id = text(b.id);
    const answer = b.answer;
    if (!id || !(answer === "yes" || answer === "no" || isDesignSignInAnswer(answer))) return c.json({ error: "An answer needs the question's id and yes, no or the sign-in fields." }, 400);
    try {
      await answerCoordinator(p, id, answer as "yes" | "no" | DesignSignInAnswer);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: message(err) }, 409);
    }
  });

  app.get("/api/design/shots/:file", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const file = c.req.param("file");
    if (!/^s\d+-(desktop|phone)\.png$/.test(file)) return c.json({ error: "No such picture." }, 404);
    try {
      return c.body(new Uint8Array(readFileSync(join(shotsDir(p.sessionId), file))), 200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    } catch {
      return c.json({ error: "No such picture." }, 404);
    }
  });
}
