import type { Context, Hono } from "hono";
import type { ApprovalState, ContextApprovalSetting } from "../shared/approvals";
import type { SettingsBy } from "../shared/project-settings";
import { resolve } from "node:path";
import { changesNeedPage, folderApprovalsView, folderForCwd, folderQuickScan, parseItemChanges, projectFolder, projectForCwd, resolveChanges, writeFolderApprovals, type ApprovalChanges, type FolderRef } from "./approvals";
import { real } from "./mcp/folder";
import { allowWithoutAsking, setAllowWithoutAsking } from "./context-approval-setting";
import { notPageNorProven } from "./mesh/click-proof";
import { OrgError } from "./org-error";
import { isSenderSecret, OVERSEER_SENDER_HEADER } from "./overseer-sender";
import { notPage, type NotPage } from "./page-only";
import { RegistryError } from "./projects/registry";
import { readProject } from "./projects/spaces";

/**
 * The approval list's routes (shared/approvals.ts): a project's Context Files and Skills cards, a folder's
 * both lists for the new chat's card (any folder, a project's or not), and the Sova-wide setting.
 *
 * Who may: anyone disallows and turns asking on. Approving (Re-approve included), turning a disallowed item
 * back on and turning asking off again take the operator's own page: this computer's, or another of theirs
 * through its proven click (server/mesh/click-proof.ts). Being a peer proves nothing on its own.
 */

const NO_STORE = { "Cache-Control": "no-store" };

const APPROVE_WORDS: Record<NotPage, string> = {
  overseer: "Only you approve context files and skills, or turn a disallowed one back on: the Overseer can't. Nothing was changed.",
  local: "This computer couldn't confirm your click with the one the list is on. Try again, or decide on that computer's page. Nothing was changed.",
  chat: "A chat can't approve context files or skills, or turn a disallowed one back on: its project overseer proposes it through sova_settings, on a card you apply. Nothing was changed.",
  script: "A script can't approve context files or skills, or turn a disallowed one back on: use the project's Context Files or Skills card, or the new chat's card. Nothing was changed.",
  extension: "An extension can't approve context files or skills, or turn a disallowed one back on. Nothing was changed.",
};

const LOOSEN_WORDS: Record<NotPage, string> = {
  overseer: "Only you let context files and skills load without asking again: the Overseer can't. Nothing was changed.",
  local: "This computer couldn't confirm your click with the one the setting is on. Try again, or turn it on that computer's page. Nothing was changed.",
  chat: "A chat can't let context files and skills load without asking again: only you turn it on, in Settings → General. Nothing was changed.",
  script: "A script can't let context files and skills load without asking again: turn it on in Settings → General. Nothing was changed.",
  extension: "An extension can't let context files and skills load without asking again. Nothing was changed.",
};

/** The 403 of a page-only change, or null when this is the page or a proven click from another of the operator's. */
async function pageRefusal(c: Context, raw: string, words: Record<NotPage, string>): Promise<Response | null> {
  if (!(await notPageNorProven(c, raw))) return null;
  const who = notPage(c) ?? "script";
  return c.json({ error: words[who], yourClick: true, ...(who === "local" ? { peer: true } : {}) }, 403);
}

async function rawBody(c: Context): Promise<{ raw: string; body: Record<string, unknown> }> {
  const raw = await c.req.text().catch(() => "");
  try {
    const b = JSON.parse(raw) as unknown;
    if (b && typeof b === "object" && !Array.isArray(b)) return { raw, body: b as Record<string, unknown> };
  } catch {}
  throw new OrgError("Expected a JSON object body");
}

const handle =
  (fn: (c: Context) => Promise<Response> | Response) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError || err instanceof RegistryError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  };

/** The history's "by" for a project's line. */
function byOf(c: Context): SettingsBy {
  if (isSenderSecret(c.req.header(OVERSEER_SENDER_HEADER))) return { kind: "overseer" };
  return { kind: "operator", via: c.req.header("x-sova-token") !== undefined ? "script" : "page" };
}

const pidOf = (c: Context): string => c.req.param("pid") ?? "";

/** An absolute folder of this computer, for the folder routes. */
function cwdOf(v: unknown): string {
  if (v === undefined) throw new OrgError("Expected cwd: the chat's folder.");
  if (typeof v !== "string") throw new OrgError("cwd must be a string: an absolute folder.");
  if (!v.startsWith("/") || v.length > 4096 || /[\0\n\r]/.test(v)) throw new OrgError("cwd must be an absolute folder.");
  return v;
}

/**
 * A folder these routes answer for: one a registered project holds (its root, a folder inside it, a worktree),
 * or the folder of a session recorded on this computer. Anything else is never scanned: a caller can't list the
 * context files and skills of an arbitrary folder, or set a walk of `/` going.
 */
async function knownFolder(cwd: string): Promise<FolderRef> {
  if (projectForCwd(cwd)) return folderForCwd(cwd);
  const want = real(resolve(cwd));
  if (!(await sessionFolders()).has(want)) throw new OrgError("No project or chat of this computer is in that folder.", 404);
  return folderForCwd(cwd);
}

/** Each recorded session file's folder (its header's, real), read and resolved once per file: a header never changes. A new
    chat with no message yet counts (the session list leaves those out, but its setup card asks about them). */
const headCwds = new Map<string, string | null>();
async function sessionFolders(): Promise<Set<string>> {
  const { listSessionFiles } = await import("./sessions-index");
  const { readStoredCwd } = await import("./git-summary");
  const files = await listSessionFiles().catch(() => [] as string[]);
  const out = new Set<string>();
  for (const f of files) {
    if (!headCwds.has(f)) {
      const c = await readStoredCwd(f).catch(() => null);
      headCwds.set(f, c ? real(resolve(c)) : null);
    }
    const c = headCwds.get(f);
    if (c) out.add(c);
  }
  return out;
}

/** A project's save: through the settings' one write (history, then its chats not yet started rebuilt). */
async function saveProject(pid: string, changes: ApprovalChanges, by: SettingsBy) {
  const { setProjectApprovalStates } = await import("./project-settings");
  return setProjectApprovalStates(pid, changes, by);
}

export function registerApprovalRoutes(app: Hono<any>): void {
  // A project's cards.
  app.get(
    "/api/projects/:pid/context-files",
    handle(async (c) => {
      const { projectContextView } = await import("./projects/skills");
      return c.json(await projectContextView(readProject(pidOf(c)).id), 200, NO_STORE);
    }),
  );
  app.get(
    "/api/projects/:pid/skills",
    handle(async (c) => {
      const { projectSkillsView } = await import("./projects/skills");
      return c.json(await projectSkillsView(readProject(pidOf(c)).id), 200, NO_STORE);
    }),
  );
  for (const [path, kind] of [
    ["/api/projects/:pid/context-files", "context"],
    ["/api/projects/:pid/skills", "skills"],
  ] as const) {
    app.put(
      path,
      handle(async (c) => {
        const pid = readProject(pidOf(c)).id;
        const { raw, body } = await rawBody(c);
        const { parseContextChanges, parseSkillChanges } = await import("./projects/skills");
        const asked: ApprovalChanges = kind === "context" ? { context: parseContextChanges(body), skills: {} } : { context: {}, skills: parseSkillChanges(body) };
        // By key before who may is judged: a skill named by its name is the decision on its place.
        const folder = projectFolder(pid);
        const changes = resolveChanges(await folderQuickScan(folder), asked);
        const no = changesNeedPage(folder.key, changes) ? await pageRefusal(c, raw, APPROVE_WORDS) : null;
        if (no) return no;
        const r = await saveProject(pid, changes, byOf(c));
        return c.json(kind === "context" ? r.context : r.skills, 200, NO_STORE);
      }),
    );
  }

  // Any folder's both lists: the new chat's card (a project's folder answers for its project).
  app.get(
    "/api/folder-approvals",
    handle(async (c) => c.json(await folderApprovalsView(await knownFolder(cwdOf(c.req.query("cwd")))), 200, NO_STORE)),
  );
  app.put(
    "/api/folder-approvals",
    handle(async (c) => {
      const { raw, body } = await rawBody(c);
      const folder = await knownFolder(cwdOf(body.cwd));
      const asked: ApprovalChanges = {
        context: body.files === undefined ? {} : parseItemChanges(body.files, "context", "files"),
        skills: body.skills === undefined ? {} : parseItemChanges(body.skills, "skills", "skills"),
      };
      if (!Object.keys(asked.context).length && !Object.keys(asked.skills).length) throw new OrgError('Expected { cwd, files?: { <key>: "approved" | "disallowed" | "waiting" }, skills?: { … } } with at least one change');
      const scan = await folderQuickScan(folder);
      const changes = resolveChanges(scan, asked);
      const no = changesNeedPage(folder.key, changes) ? await pageRefusal(c, raw, APPROVE_WORDS) : null;
      if (no) return no;
      if (folder.kind === "project") await saveProject(folder.projectId!, changes, byOf(c));
      else await writeFolderApprovals(folder, changes, {}, { scan });
      return c.json(await folderApprovalsView(folder), 200, NO_STORE);
    }),
  );

  // The Sova-wide setting.
  app.get("/api/settings/context-approval", (c) => c.json({ allowWithoutAsking: allowWithoutAsking() } satisfies ContextApprovalSetting, 200, NO_STORE));
  app.put(
    "/api/settings/context-approval",
    handle(async (c) => {
      const { raw, body } = await rawBody(c);
      if (typeof body.allowWithoutAsking !== "boolean") throw new OrgError("Expected { allowWithoutAsking: true | false }");
      const on = body.allowWithoutAsking;
      const was = allowWithoutAsking();
      if (on && !was) {
        const no = await pageRefusal(c, raw, LOOSEN_WORDS);
        if (no) return no;
      }
      if (on !== was) {
        setAllowWithoutAsking(on);
        try {
          await (await import("./projects/skills-chats")).notifySetupChanged(null);
        } catch (err) {
          console.warn(`[approvals] telling new chats of the setting failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return c.json({ allowWithoutAsking: allowWithoutAsking() } satisfies ContextApprovalSetting, 200, NO_STORE);
    }),
  );
}

export type { ApprovalState };
