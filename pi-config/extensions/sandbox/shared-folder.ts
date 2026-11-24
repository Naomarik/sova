/**
 * A chat's shared folder: one directory per top-level chat that the chat, every worker it starts
 * (pi or Claude Code, any depth) and every team member can read and write. It holds briefs,
 * reports, alignment files and team handover notes.
 *
 * A chat with a home (Sova's chat homes) keeps it in its home, `<home>/shared/`, and it stays there
 * when the chat is archived: only the chat's own Delete removes it, with the home. An older chat's
 * lives under the user's state dir, `~/.local/state/sova/shared/<session key>` (a hermetic
 * server's: `$SOVA_SHARED_BASE/<session key>`, see SHARED_BASE_ENV): outside the
 * agent dir (read-only to every confined agent, and the home of code Sova loads) and outside every
 * repository (nothing stray shows in a branch). Sova never loads code from it.
 *
 * A confined worker gets it through its parent scope (`ParentScope.shared`, always the ROOT
 * chat's); every worker also gets `SOVA_SHARED_DIR` in its environment.
 *
 * Team handover notes: `<shared>/teams/<chat key>/<team_id>/<role>/handover.md`. `<shared>/teams` is
 * read-only to every confined agent; each member gets its own `<role>` folder writable, so a member
 * can never write (or plant) another member's note.
 *
 * Node builtins only, no pi imports: the server imports it.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The environment variable a worker learns its chat's shared folder from. */
export const SHARED_DIR_ENV = "SOVA_SHARED_DIR";

/** The file name of a member's handover note inside its own folder. */
export const HANDOVER_FILE = "handover.md";

/**
 * A session id as one safe directory name. Team IDs restart at team_01 in every parent session, so
 * notes are keyed by the session as well; a session without an id (or one that sanitises to
 * nothing) uses `fallback`, which must be unique to this process.
 */
export function sessionDirKey(sessionId: string | undefined, fallback: string): string {
	const key = (sessionId ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 128);
	return key || fallback;
}

/**
 * Where a server's hermetic copy keeps its chats' folders instead (`pnpm run dev:hermetic` sets it to
 * `<worktree>/.cache/sova-shared`), so its state never lands in the user's real home. Every chat and
 * worker that server starts inherits it. Absolute paths only; anything else is ignored.
 */
export const SHARED_BASE_ENV = "SOVA_SHARED_BASE";

/** The base every chat's shared folder lives in: `$SOVA_SHARED_BASE`, else `<home>/.local/state/sova/shared`. */
export function sharedBase(home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
	const own = env[SHARED_BASE_ENV];
	return own && isAbsolute(own) ? own : join(home, ".local", "state", "sova", "shared");
}

/** The homes folder a chat process is told (`SOVA_CHAT_HOMES_ROOT`, the server's resolved one; else the
    `SOVA_CHAT_HOMES` override, absolute); the server names its own through setChatHomesRoot. */
export const CHAT_HOMES_ROOT_ENV = "SOVA_CHAT_HOMES_ROOT";
export const CHAT_HOMES_ENV = "SOVA_CHAT_HOMES";
/** The home of a chat process's chat, or of the root chat above a worker or team member. */
export const CHAT_HOME_ENV = "SOVA_CHAT_HOME";

let homesRootOf: (() => string) | undefined;

/** The server resolves its homes folder from its state root (server/chat-homes/root.ts) and names it here. */
export function setChatHomesRoot(fn: () => string): void {
	homesRootOf = fn;
}

/** The home of the chat whose key is `key` (its manifest is there), or undefined: a chat from before homes. */
export function chatHomeDirOf(key: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const fromEnv = env[CHAT_HOMES_ROOT_ENV] || env[CHAT_HOMES_ENV];
	const root = homesRootOf?.() ?? (fromEnv && isAbsolute(fromEnv) ? fromEnv : undefined);
	if (!root || !key) return undefined;
	const dir = join(root, key);
	return existsSync(join(dir, "manifest.json")) ? dir : undefined;
}

/** The shared folder of the chat whose session key (or id) is `sessionKey`: `<home>/shared` for a chat with a home. */
export function chatSharedFolder(sessionKey: string, home: string = homedir()): string {
	const key = sessionDirKey(sessionKey, "");
	if (!key) throw new Error("a shared folder needs a session key");
	const own = chatHomeDirOf(key);
	return own ? join(own, "shared") : join(sharedBase(home), key);
}

/**
 * Remove a chat's shared folder (its chat was archived or deleted): every brief, report and
 * handover note in it goes with it. Only ever `<shared base>/<key>`, never anything the key could
 * climb out to; a missing folder is fine. False when removing failed (logged by the caller).
 */
export function removeChatSharedFolder(sessionKey: string, home: string = homedir()): boolean {
	const key = sessionDirKey(sessionKey, "");
	if (!key) return true;
	// A home's shared folder is kept when its chat is archived; the chat's own Delete removes the whole home.
	if (chatHomeDirOf(key)) return true;
	try {
		rmSync(chatSharedFolder(sessionKey, home), { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/** `<shared>/teams`: every team's notes, read-only to confined agents (each member's own folder excepted). */
export function sharedTeamsDir(shared: string): string {
	return join(shared, "teams");
}

/**
 * Make the shared folder and its `teams/` (0700), and a member's own note folder when given: a
 * writable or read-only path must exist before the sandbox can bind it. Best-effort: a failure
 * shows later as the sandbox's own refusal.
 */
export function ensureSharedFolder(shared: string, note?: string): void {
	try {
		mkdirSync(sharedTeamsDir(shared), { recursive: true, mode: 0o700 });
		if (note) mkdirSync(note, { recursive: true, mode: 0o700 });
	} catch {
		// The confined command's own error says what is missing.
	}
}

/** One member's own note folder: `<shared>/teams/<chat key>/<team_id>/<role slug>`. */
export function memberNoteDir(shared: string, chatKey: string, teamId: string, roleSlug: string): string {
	return join(sharedTeamsDir(shared), chatKey, teamId, roleSlug);
}

/**
 * The shared folder a session uses: a worker's inherited one (its `--sandbox-parent` scope's
 * `shared`, else `SOVA_SHARED_DIR` in the env given), else its own chat's. Undefined when none is
 * known (no session id yet, a malformed scope).
 */
export function sharedFolderOf(o: { sessionId?: string; workerFlags?: Record<string, string | true> | null; env?: Record<string, string | undefined>; home?: string }): string | undefined {
	const raw = o.workerFlags?.["sandbox-parent"];
	if (typeof raw === "string") {
		try {
			const s = (JSON.parse(raw) as { shared?: unknown }).shared;
			if (typeof s === "string" && s.startsWith("/")) return s;
		} catch {
			// Malformed: fall through to the env, as a worker's own extension would refuse anyway.
		}
	}
	const fromEnv = o.env?.[SHARED_DIR_ENV];
	if (fromEnv && fromEnv.startsWith("/")) return fromEnv;
	if (o.workerFlags && (o.workerFlags["sandbox-parent"] !== undefined || o.workerFlags.sandbox !== undefined)) return undefined;
	const key = sessionDirKey(o.sessionId, "");
	return key ? chatSharedFolder(key, o.home) : undefined;
}
