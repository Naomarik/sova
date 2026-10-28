/**
 * The card toolkit's command types (§chat.transcript-cards/view-api, "Its types are published with
 * the toolkit"), generated from the catalogue (shared/commands-catalog.ts): one id per entry and
 * its params, typed as the entry declares them. src/card-toolkit/commands.gen.ts is this text;
 * `node scripts/card-toolkit-types.mjs` rewrites it, and a test fails when the two drift.
 * Pure, erasable syntax only (the script runs it through Node's type stripping).
 */
import type { CommandEntry, CommandParam } from "./commands/types.ts";

const tsType = (p: CommandParam): string => {
  if (p.enum?.length) return p.enum.map((e) => JSON.stringify(e)).join(" | ");
  switch (p.type) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "list":
      return "string[]";
    case "json":
      return "unknown";
    default:
      return "string";
  }
};

/** Param types a view may leave out though required: a session param is its card's own session. */
const FILLED_IN = new Set<string>(["session"]);

const doc = (s: string) => s.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();

/** The generated module's text. A `session` param is optional: left out, it is the card's own session. */
export function cardToolkitTypes(commands: readonly CommandEntry[]): string {
  const lines = [
    "// Generated from shared/commands-catalog.ts by scripts/card-toolkit-types.mjs: never edit by hand.",
    "// shared/card-toolkit-types.test.ts fails when this file and the catalogue drift.",
    "",
    "/** Every Sova command a card view can run, by its catalogue id. */",
    `export type CommandId =\n${commands.map((c) => `  | ${JSON.stringify(c.id)}`).join("\n")};`,
    "",
    "/** Each command's params, as its catalogue entry declares them. */",
    "export interface CommandParams {",
  ];
  for (const c of commands) {
    lines.push(`  /** ${doc(c.summary)} (${c.effect === "looks" ? "only looks" : "changes something: needs the card's project trusted"}) */`);
    const ps = Object.entries(c.params);
    if (!ps.length) {
      lines.push(`  ${JSON.stringify(c.id)}: Record<string, never>;`);
      continue;
    }
    lines.push(`  ${JSON.stringify(c.id)}: {`);
    for (const [name, p] of ps) {
      const optional = !p.required || FILLED_IN.has(p.type);
      lines.push(`    /** ${doc(p.description)} */`);
      lines.push(`    ${JSON.stringify(name)}${optional ? "?" : ""}: ${tsType(p)}${p.nullable ? " | null" : ""};`);
    }
    lines.push("  };");
  }
  lines.push("}", "", "/** Whether each command only looks (runs always) or changes something (runs once trusted). */");
  lines.push(`export const COMMAND_EFFECTS: Record<CommandId, "looks" | "changes"> = {\n${commands.map((c) => `  ${JSON.stringify(c.id)}: ${JSON.stringify(c.effect)},`).join("\n")}\n};`, "");
  return lines.join("\n");
}
