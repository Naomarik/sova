// The Design card's model picker: which section a model sits in, the words the main chat may use for a
// section, and the order models show in. Pure data and functions, used by the server's setupFrom and the card.
import { CLAUDE_MODELS } from "../pi-config/extensions/claude-code/catalog.ts";

export interface DesignSection {
  id: string;
  name: string;
}

/** The sections in the order the picker shows them; a provider not named here follows, by name. */
const SECTIONS: readonly DesignSection[] = [
  { id: "claude", name: "Claude" },
  { id: "gpt", name: "OpenAI" },
  { id: "zai", name: "Z.ai" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "google", name: "Google" },
  { id: "ollama-cloud", name: "Ollama Cloud" },
  { id: "ollama", name: "Ollama on this computer" },
];
const SECTION_BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

const providerOf = (ref: string): string => (ref.includes("/") ? ref.slice(0, ref.indexOf("/")) : ref).toLowerCase();
const idOf = (ref: string): string => (ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref);

/** A model's section: every Claude route is one, every OpenAI route one; Ollama Cloud and this computer's Ollama are two. */
export function designSectionOf(ref: string): DesignSection {
  const p = providerOf(ref);
  if (p === "anthropic" || p.startsWith("claude")) return SECTION_BY_ID.get("claude")!;
  if (p === "ollama-cloud") return SECTION_BY_ID.get("ollama-cloud")!;
  if (p === "ollama") return SECTION_BY_ID.get("ollama")!;
  if (p.startsWith("openai") || p.includes("codex") || p.startsWith("github-copilot")) return SECTION_BY_ID.get("gpt")!;
  if (p.startsWith("google")) return SECTION_BY_ID.get("google")!;
  if (p === "zai" || p.startsWith("zai-")) return SECTION_BY_ID.get("zai")!;
  if (p === "deepseek") return SECTION_BY_ID.get("deepseek")!;
  return { id: p, name: p ? `${p[0]!.toUpperCase()}${p.slice(1)}` : "Other" };
}

/** The words the main chat may use for a whole section, each naming exactly one. */
const SECTION_WORDS: Record<string, string> = {
  claude: "claude",
  anthropic: "claude",
  gpt: "gpt",
  openai: "gpt",
  chatgpt: "gpt",
  codex: "gpt",
  "openai-codex": "gpt",
  glm: "zai",
  zai: "zai",
  "z.ai": "zai",
  deepseek: "deepseek",
  google: "google",
  gemini: "google",
  "ollama-cloud": "ollama-cloud",
  "ollama cloud": "ollama-cloud",
  ollama: "ollama",
  "ollama-local": "ollama",
  "local ollama": "ollama",
  "ollama on this computer": "ollama",
};

/** The section a group word names ("GLM", "Z.ai", "ollama-cloud"…), or null when it names none of the known ones. */
export function designSectionOfWord(word: string): string | null {
  const w = word.trim().toLowerCase().replace(/\s+models?$/, "").replace(/^all\s+/, "").replace(/_/g, "-");
  return SECTION_WORDS[w] ?? SECTION_WORDS[w.replace(/-/g, " ")] ?? null;
}

/** Does a group word the main chat said take in this model: its section's word, or its provider's own name. */
export function designInGroup(ref: string, word: string): boolean {
  const section = designSectionOfWord(word);
  if (section) return designSectionOf(ref).id === section;
  return providerOf(ref) === word.trim().toLowerCase();
}

/**
 * Each section's models, most capable first. A model not listed goes after these, newest version first.
 * One line to add a new model. Claude's comes from its catalogue, which is already current first, each family newest first.
 */
export const DESIGN_MODEL_RANK: Readonly<Record<string, readonly string[]>> = {
  claude: CLAUDE_MODELS.map((m) => m.id),
  gpt: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna"],
  zai: ["glm-5.3", "glm-5.2", "glm-5.3-highspeed", "glm-5.2-highspeed", "glm-5-turbo", "glm-5.3-flash", "glm-4.7"],
  deepseek: ["deepseek-v4-pro", "deepseek-flash"],
  "ollama-cloud": [
    "kimi-k3.1-pro",
    "kimi-k3",
    "glm-5.3",
    "deepseek-v4-pro:0813",
    "mimo-v2.6-pro",
    "minimax-m3",
    "kimi-k2.7-code",
    "kimi-k2.6",
    "glm-5.2",
    "mistral-large-4",
    "nemotron-3-ultra",
    "gpt-oss:120b",
    "deepseek-v4.1-flash:1017",
    "deepseek-v4.1-flash",
    "minimax-m3.1-flash",
    "glm-5.3-flash",
    "mimo-v2.6-flash",
    "gemma4:31b",
    "nemotron-3-super",
    "gpt-oss:20b",
  ],
  ollama: ["gemma4:26b-a4b-it-qat", "deepseek-r1:14b", "gemma3:12b-it-qat", "qwen3:4b", "gemma3:1b", "qwen2.5:0.5b", "gemma3:270m"],
};

/** The version numbers in an id, for "newest first": "kimi-k3.1-pro" → [3, 1]. */
const versionOf = (id: string): number[] => (id.match(/\d+/g) ?? []).map(Number);
function newerFirst(a: string, b: string): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}

const sectionIndex = (id: string): number => {
  const i = SECTIONS.findIndex((s) => s.id === id);
  return i < 0 ? SECTIONS.length : i;
};

/**
 * The picker's order: sections in their order, and within one the favorites first, then the ranked list,
 * then models the list doesn't know, newest version first. It reads nothing a tick changes, so it never moves a row.
 */
export function designModelOrder<T extends { ref: string; favorite?: boolean }>(models: readonly T[]): T[] {
  const key = (m: T) => {
    const section = designSectionOf(m.ref);
    const rank = DESIGN_MODEL_RANK[section.id] ?? [];
    const at = rank.indexOf(idOf(m.ref));
    return { section, fav: m.favorite ? 0 : 1, at: at < 0 ? rank.length : at };
  };
  return [...models].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const s = sectionIndex(ka.section.id) - sectionIndex(kb.section.id) || ka.section.name.localeCompare(kb.section.name);
    if (s) return s;
    return ka.fav - kb.fav || ka.at - kb.at || newerFirst(idOf(a.ref), idOf(b.ref)) || a.ref.localeCompare(b.ref);
  });
}

/** What the picker never offers, by model id on any route. */
export const DESIGN_NEVER_IDS: ReadonlySet<string> = new Set(["claude-opus-5"]);
/** What can't run on its route: Codex Spark fails on a ChatGPT sign-in, which is what `openai-codex` is. */
export const DESIGN_NEVER_REFS: ReadonlySet<string> = new Set(["openai-codex/gpt-5.3-codex-spark"]);
