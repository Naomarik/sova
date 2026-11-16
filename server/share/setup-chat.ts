import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { SHARE_PORT_DEFAULT, type FrontGuide, type PublicLinksFile, type SetupChatOption } from "../../shared/public-links";
import { localRequest } from "../mesh/proxy";
import { yourClickRefusal } from "../page-only";
import { readPublicLinks } from "../public-links";
import { stateRoot } from "../state-root";
import { accountGuide, frontGuide } from "./front";

/**
 * Set Up With a Chat (§mesh.tunnel/setup-chat): POST /api/public-links/setup-chat {option, model?} opens a new
 * chat seeded with that option's setup brief. The brief is the folder's AGENTS.md (as the connection agent's is,
 * POST /api/sessions/connect), re-written on every start; the first message asks the chat to begin.
 *
 * The chat runs each step only with the user's approval, never writes a Sova setting (the settings routes refuse it
 * anyway, as the page's only), and never asks for or handles the Cloudflare token. It ends by telling the user to
 * save the address (and the token) in Settings → Public links and press Verify. The brief carries no token: none of
 * the guides it is built from has one.
 */

export const SETUP_OPTIONS: readonly SetupChatOption[] = ["account", "web-server", "funnel"];

const OPTION_LABELS: Record<SetupChatOption, string> = {
  account: "Cloudflare Account",
  "web-server": "Your own web server",
  funnel: "Tailscale Funnel",
};

/** The seeded first message, what the user sees as the chat's start. */
export const firstMessage = (option: SetupChatOption): string =>
  `Help me set up ${OPTION_LABELS[option]} for Sova's public links. Follow AGENTS.md in this folder: go one step at a time and ask me before you run anything.`;

const PLACEHOLDER_URL = "https://share.example.com";

function guideText(guide: FrontGuide): string {
  const steps = guide.steps.map((s, i) => `${i + 1}. ${s.label}${s.root ? " (needs root)" : ""}\n\n\`\`\`\n${s.text}\n\`\`\``);
  const notes = guide.notes?.length ? `\n\nNotes:\n${guide.notes.map((n) => `- ${n}`).join("\n")}` : "";
  return `${steps.join("\n\n")}${notes}`;
}

/** The option's steps, generated as Settings → Public links shows them, for this computer's share port. */
function stepsOf(option: SetupChatOption, file: PublicLinksFile, sharePort: number): string {
  const saved = file.gateway?.publicUrl;
  if (option === "account") return guideText(accountGuide({ sharePort, ...(file.account?.publicUrl ? { publicUrl: file.account.publicUrl } : {}), ...(file.account?.previewUrl ? { previewUrl: file.account.previewUrl } : {}) }));
  const gateway = (front: "vhost" | "caddy" | "funnel") => frontGuide({ publicUrl: saved ?? PLACEHOLDER_URL, front, sharePort, acceptFrom: "all" });
  if (option === "funnel") return guideText(gateway("funnel"));
  return `With nginx (or another web server already on this computer):\n\n${guideText(gateway("vhost"))}\n\nOr with Caddy:\n\n${guideText(gateway("caddy"))}`;
}

/** The brief for `option` (pure, for tests). */
export function setupBrief(option: SetupChatOption, file: PublicLinksFile = readPublicLinks()): string {
  const sharePort = file.gateway?.sharePort ?? SHARE_PORT_DEFAULT;
  const label = OPTION_LABELS[option];
  const ask =
    option === "web-server" && !file.gateway?.publicUrl
      ? `\nFirst ask the user which domain the links should open at, and use it wherever the steps say ${new URL(PLACEHOLDER_URL).host}.\n`
      : option === "account" && !file.account?.publicUrl
        ? `\nFirst ask the user which hostname the links should open at, and use it wherever the steps say ${new URL(PLACEHOLDER_URL).host}.\n`
        : "";
  const finish =
    option === "account"
      ? "open Settings → Public links, pick Cloudflare → Account, enter the public address (and the preview address, if they made the wildcard hostname), paste the tunnel's token there, save, and press Verify"
      : option === "funnel"
        ? "open Settings → Public links, pick Tailscale → Funnel, enter this computer's ts.net address, save, and press Verify"
        : "open Settings → Public links, pick Your own web server, enter the address, save, and press Verify";
  const token =
    option === "account"
      ? "\n- Never ask for, read, print, store or pass on the Cloudflare tunnel token. It is a credential: only the user pastes it, in Settings → Public links. If they paste it here, tell them not to, and to paste it in Settings instead; never repeat it.\n- Steps in the Cloudflare dashboard are the user's: tell them what to click. Don't install the tunnel as a service on this computer: Sova runs it."
      : "";
  return `# Set up ${label} for Sova's public links

You are helping the user make Sova's share links open from outside through ${label}. Sova's share listener is on
http://127.0.0.1:${sharePort} on this computer; that port, and only that port, is what the setup forwards to.
Never forward Sova's own app port or any other port.
${ask}
## Rules

- Run each step only after the user approves it: say what it does first. A step that needs root: show it and ask the
  user to approve it or run it themselves.
- Never write or change a Sova setting: don't edit anything in Sova's state folder, don't call Sova's settings routes,
  and don't run Sova's scripts to change one. The user saves the setting themselves.${token}
- Stop and say so if a step fails; don't work around it with changes the steps don't name.

## The steps

${stepsOf(option, file, sharePort)}

## When it's done

Tell the user to ${finish}. Until they save it, their links keep opening where they open now.
`;
}

/** What the route needs from the app (server/app.ts's own session code; tests pass their own). */
export interface SetupChatDeps {
  /** A new web session in `cwd` (its file written now), or the app's error answer. */
  create(c: Context, cwd: string): Promise<{ path: string } | Response>;
  /** Set the model before the first message. */
  setModel(path: string, model: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** This computer's default profile, which sets the model (§chat.profiles/default). */
  applyDefault(path: string, cwd: string): Promise<{ ok: true } | { ok: false; error: string }>;
  prompt(path: string, text: string): Promise<{ ok: true } | { ok: false; error: string; status: number }>;
  summary(path: string): Promise<object | null>;
}

const MODEL = /^[^/\s]+\/\S+$/;

/** POST /api/public-links/setup-chat. Main listener only, and only the person's own click in the page. */
export async function setupChatRoute(c: Context, deps: SetupChatDeps): Promise<Response> {
  if (!localRequest(c)) return c.json({ error: "Not found" }, 404);
  const refused = yourClickRefusal(c, "setupChat");
  if (refused) return refused;
  const body = (await c.req.json().catch(() => undefined)) as { option?: unknown; model?: unknown } | undefined;
  const option = body?.option;
  if (typeof option !== "string" || !(SETUP_OPTIONS as readonly string[]).includes(option)) return c.json({ error: `option is one of ${SETUP_OPTIONS.join(", ")}` }, 400);
  const model = body?.model;
  if (model !== undefined && (typeof model !== "string" || !MODEL.test(model) || model.length > 200)) return c.json({ error: 'model is "provider/model"' }, 400);
  const opt = option as SetupChatOption;
  const dir = join(stateRoot(), "public-links-setup", opt);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `AGENTS.md.${process.pid}.tmp`);
  writeFileSync(tmp, setupBrief(opt));
  renameSync(tmp, join(dir, "AGENTS.md"));
  const made = await deps.create(c, dir);
  if (made instanceof Response) return made;
  // The model before the first message: the one the page named, else this computer's default.
  const set = typeof model === "string" ? await deps.setModel(made.path, model) : await deps.applyDefault(made.path, dir);
  const sent = await deps.prompt(made.path, firstMessage(opt));
  if (!sent.ok) return c.json({ error: `Created the chat, but its first message was refused: ${sent.error}`, session: made }, sent.status as 400);
  const summary = (await deps.summary(made.path)) ?? made;
  return c.json(set.ok ? summary : { ...summary, modelNotSet: set.error }, 201);
}
