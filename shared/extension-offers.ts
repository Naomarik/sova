/**
 * What an extension offers Sova (§app.extensions/offers, ext-contract-v1.15): its manifest entry's
 * `commands` and `screens` keys, validated and bounded into the `offers` field GET /api/extensions
 * carries. The one generic mechanism every place on Sova's screens reads: a place asks only the
 * extensions whose `screens` names it. Pure; erasable syntax only (shared/commands-ext.ts, which it
 * reuses, is loaded by Node's type stripping for the command line).
 *
 * Copied field by field from strings that passed their rule, never the manifest's own objects, so
 * nothing the entry carries besides (an env, a header, a token) can reach the page.
 */
import type { ExtensionCommandInfo, ExtensionOffers, ScreenPlace } from "./protocol.ts";
import { COMMANDS_MAX, extCommand, extCommandsFrom, extOverseerKeys } from "./commands-ext.ts";

/** Every place an extension may add to, in the order Sova draws them. An unknown name is dropped
    (a newer extension on an older Sova). */
export const SCREEN_PLACES = ["reply", "row", "card"] as const satisfies readonly ScreenPlace[];

/** Every menu a command may declare itself an entry of (`"menu": "session"` on the command: the
    Agents board row's ⋯ menu, src/lib/menu-place.ts). Any other value leaves the command out of every menu, never out
    of `commands`: the command line still runs it. */
export const MENU_PLACES = ["session"] as const satisfies readonly NonNullable<ExtensionCommandInfo["menu"]>[];
export type MenuPlace = (typeof MENU_PLACES)[number];

/** Names past this many in `screens` are never read. */
const SCREENS_READ_MAX = 16;

/** The path on an extension's proxied backend that a place asks: GET `/ext/<id>` + this. */
export const screenPath = (place: ScreenPlace): string => `/api/screens/${place}`;

export interface OffersResult {
  /** Null when nothing valid is declared: the entry's list item then has no `offers` key at all. */
  offers: ExtensionOffers | null;
  /** What was left out and why, for the server's once-per-process log. */
  dropped: string[];
}

/** An entry's raw `commands` and `screens` → what it validly offers. Never throws, never drops the entry. */
export function offersOf(extId: string, raw: { commands?: unknown; screens?: unknown }): OffersResult {
  const dropped: string[] = [];
  const offers: ExtensionOffers = {};

  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) dropped.push("commands is not an array");
    else {
      const declared = declaredCommands(extId, raw.commands);
      let badMenus = 0;
      const badKeys = new Map<string, number>();
      const commands: ExtensionCommandInfo[] = extCommandsFrom(extId, raw.commands).map((c) => {
        const info: ExtensionCommandInfo = { name: c.id.slice(`ext.${extId}.`.length), label: c.label };
        if (c.summary) info.summary = c.summary;
        const own = declared.get(info.name);
        const menu = own?.menu;
        if (menu !== undefined) {
          if (isMenuPlace(menu)) info.menu = menu;
          else badMenus++;
        }
        // ext-contract-v1.18: each key alone; only `true` rides along here (the description is read from the
        // manifest by overseerExtCommands, for sova_ext and the Overseer's About panel).
        const keys = extOverseerKeys(own);
        if (keys.overseer) info.overseer = true;
        if (keys.job) info.job = true;
        for (const k of keys.dropped) badKeys.set(k, (badKeys.get(k) ?? 0) + 1);
        return info;
      });
      if (commands.length < raw.commands.length) dropped.push(`${raw.commands.length - commands.length} of its commands`);
      if (badMenus) dropped.push(`${badMenus} of its menu entries`);
      for (const [k, n] of badKeys) dropped.push(`${n} of its commands' ${k} keys`);
      if (commands.length) offers.commands = commands;
    }
  }

  if (raw.screens !== undefined) {
    if (!Array.isArray(raw.screens)) dropped.push("screens is not an array");
    else {
      const named = new Set(raw.screens.slice(0, SCREENS_READ_MAX));
      const screens = SCREEN_PLACES.filter((p) => named.has(p));
      if (screens.length < raw.screens.length) dropped.push(`${raw.screens.length - screens.length} of its screens`);
      if (screens.length) offers.screens = screens;
    }
  }

  return { offers: offers.commands || offers.screens ? offers : null, dropped };
}

const isMenuPlace = (v: unknown): v is MenuPlace => typeof v === "string" && (MENU_PLACES as readonly string[]).includes(v);

/** Each kept command's raw declaration by name: the first valid command of a name, exactly the
    one extCommandsFrom keeps. Callers read single values from it (its `menu`, its v1.18 keys through
    extOverseerKeys), never copy the object. */
export function declaredCommands(extId: string, commands: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(commands)) return out;
  for (const c of commands.slice(0, COMMANDS_MAX)) {
    const entry = extCommand(extId, c);
    if (!entry) continue;
    const name = entry.id.slice(`ext.${extId}.`.length);
    if (!out.has(name)) out.set(name, c as Record<string, unknown>);
  }
  return out;
}

/** Whether an extension's offers name this place. */
export const offersPlace = (offers: ExtensionOffers | undefined, place: ScreenPlace): boolean => !!offers?.screens?.includes(place);
