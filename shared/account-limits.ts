/**
 * Settings → Accounts' limits, read by the rename box (src/components/AccountsSettings.tsx) and the
 * save (server/claude-accounts.ts PATCH), refused in the same words (shared/form-rules.ts).
 */
import type { TextRule } from "./form-rules";

export const LOGIN_NAME_RULE: TextRule = { kind: "text", label: "Login name", max: 80, trim: true };
