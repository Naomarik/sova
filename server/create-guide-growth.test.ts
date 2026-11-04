// §chat.create-mode/growth-rule: every item of Sova's own lists has a topic in Create's guide, in the
// branch that adds it. create-guide-growth.json beside this test is the one place that says which topic
// owns which item, by exact name (no prefix or pattern, so a new item can't pass on a neighbour's word),
// and holds the SOVA_* names a user never sets. Adding an item: add it there under its topic, and say it
// in that topic's entry (pi-config/extensions/mode/create/<topic>.md).
//
// Its limit, as the claim says: it holds only where Sova keeps a list. It can't see a new control inside
// an existing tab, or a new file.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COMMANDS } from "../shared/commands-catalog";
import { SCREEN_PLACES } from "../shared/extension-offers";
import { POWERS } from "../shared/powers";
import { DEFINITION_KEYS } from "../shared/project-contract";
import { SETTING_IDS } from "../shared/settings-reference";
import { SETTINGS_TABS } from "../src/lib/settings-nav";
import { CREATE_FILES, CREATE_TOPICS, stripOwnerNotes } from "../pi-config/extensions/mode/create/guide.ts";
import { MINOR_MODES } from "../pi-config/extensions/mode/minor.ts";
import { MODES } from "../pi-config/extensions/mode/state.ts";
import { settingsDocs } from "./sync/docs";

const ROOT = new URL("..", import.meta.url).pathname;
const MAP = JSON.parse(readFileSync(new URL("./create-guide-growth.json", import.meta.url), "utf8")) as {
  notForUsers: string[];
  items: Record<string, Record<string, string>>;
};

/** Every key of the project definition, `<section>.<key>`, the alternatives of a section flattened. */
const definitionKeys = (): string[] =>
  Object.entries(DEFINITION_KEYS).flatMap(([section, keys]) => [...new Set((keys as readonly (string | readonly string[])[]).flat())].map((key) => `${section}.${key}`));

/**
 * The SOVA_* names Sova's code reads from the environment, tests and their fixtures left out: `env.SOVA_X`,
 * a name as a string (some are read through a constant, `JEV_KEY_ENV = "SOVA_JEV_KEY"`), or a shell's
 * `$SOVA_X`, `${SOVA_X}` and `SOVA_X=`. A bare SOVA_X is a variable of the code (`SOVA_ADAPTERS`), not a setting.
 */
const ENV_SHAPED = /(?:env\.|["'`$]|\$\{|^\s*(?:export\s+)?(?=SOVA_[A-Z0-9_]*=))(SOVA_[A-Z0-9]+(?:_[A-Z0-9]+)*)\b/gm;

function scanEnv(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "tests" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|sh)$/.test(e.name) && !/\.test\.|\.fixture\./.test(e.name))
        for (const m of readFileSync(p, "utf8").matchAll(ENV_SHAPED)) if (e.name.endsWith(".sh") || !m[0].startsWith("${")) found.add(m[1]!); // `${X}` in a template string is the code's own X.
    }
  };
  for (const dir of ["server", "shared", "src", "scripts", "pi-config"]) walk(join(ROOT, dir));
  return [...found].sort();
}

const asWords = (s: string) => s.toLowerCase().replace(/-/g, " ");
const says = (text: string, word: string) => new RegExp(`(?<![\\w.])${asWords(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(asWords(text));

type Lists = Record<string, readonly string[]>;
const lists = (): Lists => ({
  tab: SETTINGS_TABS,
  definition: definitionKeys(),
  setting: SETTING_IDS,
  power: POWERS,
  mode: MODES,
  minor: MINOR_MODES,
  place: SCREEN_PLACES,
  doc: settingsDocs("/a", "/a/sova").map((doc) => doc.key),
  command: COMMANDS.map((command) => command.id),
  env: scanEnv().filter((name) => !MAP.notForUsers.includes(name)),
});

/** The word an entry must carry for an item, or undefined when naming every one would only be a list. */
function wordOf(kind: string, item: string): string | undefined {
  if (kind === "command") return undefined; // A catalogue: `scripts` teaches `sova list`, which names them all.
  if (kind === "doc") return item.split("/").pop()!.replace(/^settings:/, "");
  if (kind === "definition") {
    const [section, key] = item.split(".") as [string, string];
    return section === "top" || section === "merge" || section === "release" ? key : undefined;
  }
  return item;
}

/** Each item with no topic, each mapped item no list has, and each mapped topic that doesn't exist. */
function mapProblems(have: Lists, items: Record<string, Record<string, string>>, topics: readonly string[]): string[] {
  const out: string[] = [];
  for (const [kind, list] of Object.entries(have)) {
    const mapped = items[kind] ?? {};
    for (const item of list) if (!Object.hasOwn(mapped, item)) out.push(`${kind} ${item} has no topic: add it to server/create-guide-growth.json, and say it in that topic's entry`);
    for (const [item, topic] of Object.entries(mapped)) {
      if (!list.includes(item)) out.push(`${kind} ${item} no longer exists: take it out of server/create-guide-growth.json`);
      if (!topics.includes(topic)) out.push(`${kind} ${item}: no topic ${topic}`);
    }
  }
  return out;
}

/** Each item whose topic's entry doesn't name it, for the people writing the entries. */
function unsaid(items: Record<string, Record<string, string>>, entry: (topic: string) => string): string[] {
  const out: string[] = [];
  for (const [kind, mapped] of Object.entries(items))
    for (const [item, topic] of Object.entries(mapped)) {
      const word = wordOf(kind, item);
      if (word !== undefined && !says(entry(topic), word)) out.push(`${topic}: doesn't say ${kind} ${word}`);
    }
  return out.sort();
}

test("every item of Sova's own lists has a topic, and every mapped item still exists", () => {
  assert.deepEqual(mapProblems(lists(), MAP.items, CREATE_TOPICS), []);
});

test("a topic's entry names each item it owns", () => {
  // Joined, so a failure prints the whole worklist, not a truncated diff.
  assert.equal(unsaid(MAP.items, (topic) => stripOwnerNotes(CREATE_FILES[topic] ?? "")).join("\n"), "");
});

test("every SOVA_* name is either a user's, under a topic, or on the not-for-users list, never both", () => {
  const scanned = scanEnv();
  assert.ok(scanned.includes("SOVA_PORT") && scanned.includes("SOVA_WORKER_NICE"), "the scan finds known names");
  assert.deepEqual(MAP.notForUsers.filter((name) => !scanned.includes(name)), [], "a not-for-users name Sova no longer has");
  assert.deepEqual(MAP.notForUsers.filter((name) => Object.hasOwn(MAP.items.env ?? {}, name)), []);
});

test("the check fails on a new item, a gone item and an unnamed one", () => {
  const items = { power: { share: "overseers", gone: "overseers" }, mode: { create: "nope" } };
  assert.deepEqual(mapProblems({ power: ["share", "fresh"], mode: ["create"] }, items, ["overseers"]), [
    "power fresh has no topic: add it to server/create-guide-growth.json, and say it in that topic's entry",
    "power gone no longer exists: take it out of server/create-guide-growth.json",
    "mode create: no topic nope",
  ]);
  assert.deepEqual(unsaid({ tab: { "merge-queue": "landing" } }, () => "Settings → Merge Queue"), []);
  assert.deepEqual(unsaid({ tab: { "merge-queue": "landing" } }, () => "the queue"), ["landing: doesn't say tab merge-queue"]);
  assert.deepEqual(unsaid({ env: { SOVA_PORT: "computers" } }, () => "SOVA_PORTS"), ["computers: doesn't say env SOVA_PORT"]);
  assert.deepEqual(unsaid({ command: { "session.list": "scripts" } }, () => ""), [], "a command's word is its topic, not its entry");
});
