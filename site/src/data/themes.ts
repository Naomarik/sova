// The theme grid is read from the repository's themes/*.json at build time, so the count and the
// swatches can't drift from what the app ships. A theme's missing colors come from its base
// (dark.json or light.json), and "$name" values resolve through its `vars`.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.cwd(), "..", "themes");

type Raw = { name: string; extends?: "dark" | "light"; vars?: Record<string, string>; colors?: Record<string, string> };

export type Theme = {
  id: string;
  name: string;
  base: "dark" | "light";
  colors: Record<string, string>;
};

const read = (file: string): Raw => JSON.parse(readFileSync(join(dir, file), "utf8"));

const resolveColors = (raw: Raw) => {
  const vars = raw.vars ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.colors ?? {})) {
    out[key] = value.startsWith("$") ? (vars[value.slice(1)] ?? value) : value;
  }
  return out;
};

const bases = { dark: resolveColors(read("dark.json")), light: resolveColors(read("light.json")) };

// Built-ins first (Dark, Light), then the rest by name.
export const themes: Theme[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((file) => {
    const raw = read(file);
    const base = raw.extends === "light" ? "light" : "dark";
    return { id: file.replace(/\.json$/, ""), name: raw.name, base, colors: { ...bases[base], ...resolveColors(raw) } };
  })
  .sort((a, b) => {
    const rank = (t: Theme) => (t.id === "dark" ? 0 : t.id === "light" ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
