/**
 * `/claude-login <id>`: move this chat to the Claude login the user picked in Sova's composer
 * (§app.claude-logins/switch-login). Sova calls the handler directly, the way the web mode switch
 * calls `/mode`; a terminal has no picker. A refusal throws, with the reason as its message.
 */
import { CLAUDE_LOGIN_ENTRY, type ClaudeLoginChoice, type ClaudeLogins } from "../accounts.ts";
import type { ClaudeSessionBridge } from "./types.ts";

export const CLAUDE_LOGIN_COMMAND = "claude-login";

/** What a pick needs of the host's logins (accounts.ts ClaudeLogins). */
export type LoginPickSource = Pick<ClaudeLogins, "pickable" | "take" | "selectId" | "choice">;

/** The newest `claude-login` entry on a branch (oldest first): its login and the name it gave it. */
function newestEntry(branch: readonly unknown[]): { login: string; label?: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i] as { type?: unknown; customType?: unknown; data?: { login?: unknown; label?: unknown } };
		if (e?.type === "custom" && e.customType === CLAUDE_LOGIN_ENTRY && typeof e.data?.login === "string")
			return { login: e.data.login, ...(typeof e.data.label === "string" && e.data.label ? { label: e.data.label } : {}) };
	}
	return undefined;
}

/**
 * Move the session to login `args` (its id). A login free at the keeper is borrowed by name first
 * (ClaudeLogins.take, only while the mesh is on). "same": it is already on that login.
 */
export async function pickChatLogin(
	args: string,
	session: { id: string | undefined; branch: readonly unknown[] },
	deps: { bridge: ClaudeSessionBridge; logins: LoginPickSource },
): Promise<"switched" | "same"> {
	const id = args.trim();
	if (!id || /\s/.test(id)) throw new Error("Name one Claude login: /claude-login <login id>.");
	if (!session.id) throw new Error("This session has no id yet.");
	const switchTo = deps.bridge.switchSessionLogin?.bind(deps.bridge);
	if (!switchTo) throw new Error("This runtime's Claude Code bridge predates switching logins. Restart Sova to switch.");
	let pick = deps.logins.pickable(id);
	if ("refused" in pick) {
		// Not here: with the mesh on it may be free at the keeper. take() returns at once otherwise.
		await deps.logins.take(id);
		pick = deps.logins.pickable(id);
		if ("refused" in pick) throw new Error(pick.refused);
	}
	const recorded = newestEntry(session.branch);
	const fromId = recorded?.login ?? deps.logins.selectId();
	const from: ClaudeLoginChoice = deps.logins.choice(fromId) ?? { id: fromId, label: recorded?.label ?? fromId, env: {} };
	const outcome = switchTo(session.id, pick.choice, from);
	if (outcome === "busy") throw new Error("Claude is still answering. Switch once the reply ends.");
	if (outcome === "unknown") throw new Error("Claude Code models are off for this session.");
	return outcome;
}
