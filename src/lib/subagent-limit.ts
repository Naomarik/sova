import type { SubagentProfilesInfo } from "../../shared/subagent-profiles";

/** Usage-limit wording, and only that: auth, network and policy failures are never a usage limit,
    and a bare "429" doesn't even say whose it is. The first three alternatives are the claude-code
    transport's own limit classifier (its LIMIT_TEXT) verbatim, so a real Claude limit the row
    sees says the same thing the failover saw. */
const LIMIT_WORDS = /(usage limit|hit your (?:usage )?limit|out of (?:extra )?usage|limit will reset|rate.?limit|quota.*(?:exceed|exhaust)|too many requests)/i;

/** A turn provider ids as the profiles list them: claude-code-cli chats draw from the same Claude
    login pool as claude-code workers, which the extension's workerProvider already calls "claude". */
const TURN_PROVIDER_ALIASES: Readonly<Record<string, string>> = { "claude-code-cli": "claude" };

/** A raw provider id as the canonical one the profiles list. */
export const canonicalProvider = (id: string): string => TURN_PROVIDER_ALIASES[id.toLowerCase()] ?? id;

/** The provider a thread row's producer spends: its own "provider/model"'s first segment,
    alias-canonicalized — never the session's current model; undefined when the row doesn't know. */
export function rowProvider(model: string | undefined | null): string | undefined {
  const id = model?.split("/")[0];
  return id ? canonicalProvider(id) : undefined;
}

/** The providers a limit row can name: canonical id → the words that name it in an error's text.
    First match wins; an unknown name is never guessed at. */
const PROVIDER_WORDS: readonly [string, RegExp][] = [
  ["claude", /\b(?:claude|anthropic)\b/i],
  ["openai-codex", /\b(?:openai[\s-]?codex|openai|codex|chatgpt)\b/i],
  ["zai", /\b(?:z\.ai|zai|zhipu)\b/i],
  ["ollama-cloud", /\bollama\b/i],
  ["deepseek", /\bdeepseek\b/i],
];

/**
 * The provider exhausted by this error, or null = no row (the limit row's one rule: read, never
 * invent). Gate first: no limit wording, no provider. Then an explicit provider name in the text,
 * mapped to its canonical id. Then the failed turn's own provider, handed over by the server with
 * the error — never the chat model guessed at a worker's or tool's failure: those errors carry no
 * provider here at all.
 */
export function exhaustedProvider(message: string, turnProvider?: string | null): string | null {
  if (!LIMIT_WORDS.test(message)) return null;
  for (const [id, words] of PROVIDER_WORDS) if (words.test(message)) return id;
  return turnProvider ? canonicalProvider(turnProvider) : null;
}

/**
 * One failure, one row: an errored turn's own thread row carries the limit row (with that
 * row's own provider), so the error feed's entry only shows one when the failure never made a
 * thread row at all (a send refused before any turn started, a host move). A trailing period is
 * presentation, not identity.
 */
export function failureHasRow(entries: readonly { kind: string; error?: string }[], message: string): boolean {
  const clean = (t: string) => t.replace(/\.$/, "");
  return entries.some((e) => e.kind === "assistant" && e.error !== undefined && clean(e.error) === clean(message));
}

/**
 * The one-tap alternative: the first profile in list order
 * whose workers — fallbacks included (`providers` counts them) — never spend the exhausted
 * provider. Never Off (it promises no provider choice) and never the chat's current profile.
 */
export function limitAlternative(info: SubagentProfilesInfo, provider: string) {
  return info.profiles.find(
    (p) => p.id !== "off" && p.id !== info.current.id && p.providers.length > 0 && !p.providers.includes(provider),
  );
}

/** A provider id the way the row says it. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "openai-codex":
      return "OpenAI";
    case "zai":
      return "z.ai";
    case "ollama-cloud":
      return "Ollama";
    case "deepseek":
      return "DeepSeek";
    default:
      return provider;
  }
}
