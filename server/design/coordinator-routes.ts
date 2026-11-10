// The page's routes for a chat's design coordinator. Each names the parent chat by `?path=`; a request is the
// user's own click or typed words, and none of them starts a turn in the main chat.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { isDesignLinkUse, isDesignSignInAnswer, type DesignSignInAnswer } from "../../shared/design";
import { notPage } from "../page-only";
import { resolveSessionPath } from "../paths";
import { idOf } from "../sessions-index";
import type { BrowseParent } from "./browse";
import { ownImagesLine } from "./asset-routes";
import { answerBrief, answerCoordinator, editBrief, messageCoordinator, notThisScreen, resolveBriefConflict, setBriefImage, setBriefLink, shotsDir } from "./coordinator";
import { designView } from "./live";

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
const YOUR_CLICK = "Only your own click on the coordinator's card or the Lookbook's brief in Sova's page answers this.";
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function mountCoordinatorRoutes(app: Hono): void {
  const onBrief = (name: string, fn: (p: BrowseParent, run: string, b: Record<string, unknown>) => Promise<void> | void | string) =>
    app.post(`/api/design/runs/:run/brief/${name}`, async (c) => {
      if (notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
      const p = parentOf(c);
      if (!p) return c.json({ error: BAD_PATH }, 400);
      try {
        const out = await fn(p, c.req.param("run"), await bodyOf(c));
        if (typeof out === "string") return c.json({ error: out }, 400);
        return c.json(designView(p.sessionId));
      } catch (err) {
        return c.json({ error: message(err) }, 409);
      }
    });

  onBrief("edit", (p, run, b) => {
    if (b.field !== "summary" && b.field !== "prompt" && b.field !== "look" && b.field !== "notes") return 'field must be "summary", "prompt", "look" or "notes".';
    if (typeof b.text !== "string") return "An edit needs its text.";
    return editBrief(p, run, { field: b.field, text: b.text, ...(typeof b.url === "string" ? { url: b.url } : {}) });
  });

  onBrief("answers", (p, run, b) => {
    if (b.recommended === true) return answerBrief(p, run, "recommended");
    if (!Array.isArray(b.picks) || !b.picks.length) return "Answers need picks, or recommended: true.";
    const picks = (b.picks as Record<string, unknown>[]).map((x) => ({ id: text(x?.id), ...(typeof x?.option === "number" ? { option: x.option } : {}), ...(typeof x?.text === "string" ? { text: x.text } : {}) }));
    return answerBrief(p, run, picks);
  });

  onBrief("conflict", (p, run, b) => (b.choice === "keep" || b.choice === "rewrite" ? resolveBriefConflict(p, run, b.choice) : 'choice must be "keep" or "rewrite".'));

  onBrief("link", (p, run, b) => (typeof b.url === "string" && isDesignLinkUse(b.use) ? setBriefLink(p, run, b.url, b.use) : "A link needs its url and a use."));

  onBrief("image", (p, run, b) => {
    if (typeof b.name !== "string" || typeof b.use !== "boolean") return "An image needs its name and a use.";
    setBriefImage(p, run, b.name, b.use);
  });

  onBrief("not-this-screen", (p, run, b) => notThisScreen(p, run, text(b.text).trim() || undefined));

  app.post("/api/design/coordinator/message", async (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: BAD_PATH }, 400);
    const b = await bodyOf(c);
    const words = text(b.text).trim();
    const images = Array.isArray(b.images) ? b.images.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
    if ((!words && !images.length) || !text(b.key)) return c.json({ error: "A message needs its text or an image, and a key." }, 400);
    try {
      // Your own images join the chat's set here; the coordinator hears their names, never their bytes.
      if (images.length && notPage(c)) return c.json({ error: YOUR_CLICK }, 403);
      const added = images.length ? await ownImagesLine(p, images) : "";
      const said = [words, added].filter(Boolean).join("\n\n");
      // Only the person's own page vouches for an address it names (a script's or a chat's call still delivers).
      return c.json(await messageCoordinator(p, said, `user:${text(b.key)}`, notPage(c) === null));
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
