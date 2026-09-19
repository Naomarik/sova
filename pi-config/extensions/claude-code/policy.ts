/** Deliberately small, explicit launch policy. Never translates Pi tool names silently. */
export const DEFAULT_CLAUDE_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];
export const CLAUDE_PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "manual", "dontAsk", "plan"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export interface ClaudePolicy {
	permissionMode: ClaudePermissionMode;
	allowedTools?: string[];
	maxBudgetUsd?: number;
}
export function parseClaudePolicy(value: unknown): ClaudePolicy {
	if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
		throw new Error("claude-code backendOptions must be an object.");
	}
	const raw = (value ?? {}) as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!["permissionMode", "allowedTools", "maxBudgetUsd"].includes(key)) {
			throw new Error(`Unknown claude-code backend option: ${key}`);
		}
	}
	const permissionMode = raw.permissionMode ?? "bypassPermissions";
	if (!CLAUDE_PERMISSION_MODES.includes(permissionMode as ClaudePermissionMode)) {
		throw new Error(`Claude permissionMode must be ${CLAUDE_PERMISSION_MODES.join(", ")}.`);
	}
	if (raw.allowedTools !== undefined && (!Array.isArray(raw.allowedTools) || raw.allowedTools.some(v => typeof v !== "string" || !v.trim() || v.trimStart().startsWith("-") || /[\x00-\x1f\x7f]/.test(v)))) {
		throw new Error("Claude allowedTools must be nonempty native permission rules, never CLI flags or control characters.");
	}
	if (raw.maxBudgetUsd !== undefined && (typeof raw.maxBudgetUsd !== "number" || !Number.isFinite(raw.maxBudgetUsd) || raw.maxBudgetUsd <= 0)) {
		throw new Error("Claude maxBudgetUsd must be a finite positive number.");
	}
	return { permissionMode: permissionMode as ClaudePermissionMode, allowedTools: raw.allowedTools as string[] | undefined, maxBudgetUsd: raw.maxBudgetUsd as number | undefined };
}
export function validateClaudeTools(tools: string[] | undefined): string[] {
	const selected = tools ?? DEFAULT_CLAUDE_TOOLS;
	for (const tool of selected) {
		if (!/^[A-Z][A-Za-z0-9_]*$/.test(tool)) {
			throw new Error(`Invalid Claude tool name ${JSON.stringify(tool)}. Use native names such as Read, Edit, Bash (not Pi's lowercase names).`);
		}
	}
	return [...new Set(selected)];
}
export function validateClaudeModel(model: string | undefined): string {
	const selected = model ?? "sonnet";
	if (!selected.trim() || selected.startsWith("-") || /[\s/\0]/.test(selected)) {
		throw new Error("Claude model must be a CLI alias or model ID, not a Pi provider/model ID.");
	}
	return selected;
}
export function validateClaudeEffort(effort: string | undefined): string {
	const selected = effort ?? "medium";
	if (!["low", "medium", "high", "xhigh", "max"].includes(selected)) {
		throw new Error("Claude effort must be low, medium, high, xhigh, or max.");
	}
	return selected;
}
