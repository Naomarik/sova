/** Settings → MCP Servers' Add form boxes, checked by the form (src/lib/mcp.ts) and the add/edit routes (server/mcp/routes.ts) in the same words. */
import type { CustomRule } from "./form-rules";

/** A server's name: never sova, Sova's own. */
export const SERVER_NAME_RULE: CustomRule = { kind: "custom", label: "Name", issue: (t) => (t.toLowerCase() === "sova" ? "The name sova is Sova's own. Pick another." : null) };
/** A secret's name, as server/mcp/values.ts isSecretName takes it; "" is the default name. */
export const SECRET_NAME_RULE: CustomRule = {
  kind: "custom",
  label: "Secret's Name",
  issue: (t) => (t && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? "A secret's name is letters, digits and underscores." : null),
};
