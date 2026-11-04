import type { OverseerAbilitiesInfo, OverseerCaps } from "../shared/protocol";
import type { OverseerExtCommand } from "./extensions";

/**
 * What the global Overseer can do (§app.overseer/extension-commands, §app.overseer/about): one reading of
 * the extension commands offered to it, grouped by extension with each extension's health, which both
 * `sova_ext` and the Overseer's About panel use, so the panel and what the Overseer can run never
 * disagree. A command is the Overseer's when its extension marks it `overseer: true`; it can run it
 * while that extension is running (its health check answers). Nothing else switches one on or off.
 */

/** An extension's health as the extension host reports it; null when it isn't installed now. */
export type ExtHealth = { status: "ok" | "down"; error?: string } | null;

/** One installed extension that marks commands for the Overseer, with its health now. */
export interface ExtAbility {
  extension: { id: string; title: string };
  /** Its backend answers its health check: its commands can run. */
  running: boolean;
  /** Why it isn't running (the health check's reason), when it isn't. */
  error?: string;
  commands: OverseerExtCommand[];
}

/**
 * The offered commands grouped by extension, in manifest order, each extension's health asked once.
 * An extension the host no longer knows (uninstalled since the offers were read) is left out.
 */
export async function extAbilities(offered: readonly OverseerExtCommand[], health: (id: string) => Promise<ExtHealth>): Promise<ExtAbility[]> {
  const groups = new Map<string, ExtAbility>();
  for (const c of offered) {
    const g = groups.get(c.extension.id);
    if (g) g.commands.push(c);
    else groups.set(c.extension.id, { extension: c.extension, running: false, commands: [c] });
  }
  const out: ExtAbility[] = [];
  for (const g of groups.values()) {
    const h = await health(g.extension.id).catch(() => null);
    if (!h) continue;
    g.running = h.status === "ok";
    if (!g.running) g.error = h.error ?? "its backend didn't answer its health check";
    out.push(g);
  }
  return out;
}

/** The commands the Overseer can run now: those of running extensions. */
export const runnableCommands = (abilities: readonly ExtAbility[]): OverseerExtCommand[] => abilities.filter((a) => a.running).flatMap((a) => a.commands);

/**
 * Its built-in abilities, kept short for the About panel: one line per area of its fixed tools
 * (server/overseer-tools.ts and its parts). Not a tool list: the tools themselves stay the model's.
 */
export const BUILT_IN_ABILITIES: OverseerAbilitiesInfo["builtIn"] = [
  { name: "Sessions", text: "Reads every session here and on linked hosts; starts, messages, renames, archives and sets the model of sessions, and answers their dialogs." },
  { name: "Cards", text: "Asks you on a card before acting on anything you didn't ask for in your own message." },
  { name: "Notes, ideas and todos", text: "Keeps standing notes, files ideas and launches explorers on them, and keeps your todos." },
  { name: "Links", text: "Links sessions across your hosts." },
  { name: "Organizations", text: "Keeps organizations, projects, rosters and project overseers, and starts gatherings." },
  { name: "Projects", text: "Runs and checks a project's copies, reads its git history and specs, and reads this server's log." },
  { name: "WhatsApp", text: "Checks the WhatsApp sender, and starts it when it is stopped." },
];

/** The About panel's whole answer: built-in abilities, the limits now, and the extensions' commands. */
export function abilitiesInfo(abilities: readonly ExtAbility[], caps: OverseerCaps): OverseerAbilitiesInfo {
  return {
    builtIn: BUILT_IN_ABILITIES,
    caps,
    extensions: abilities.map((a) => ({
      id: a.extension.id,
      title: a.extension.title,
      running: a.running,
      ...(a.error ? { error: a.error } : {}),
      commands: a.commands.map((c) => ({
        id: c.command.id,
        label: c.command.label,
        ...(c.command.summary ? { summary: c.command.summary } : {}),
        ...(c.description ? { description: c.description } : {}),
        job: c.job,
      })),
    })),
  };
}
