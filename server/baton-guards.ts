import { BATON_HANDOFF_ENTRY, BATON_OFFER_ENTRY, BATON_SENT_ENTRY } from "../shared/baton";
import type { Person } from "../shared/orgs";

/**
 * Server-side guards on what a baton model may do (§app.baton/hand-off, §app.organizations/wrap-up):
 * checks a cheap model can't talk its way past. Pure: callers pass the branch, roster and names.
 */

type Entry = Record<string, any>;

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
      : "";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` names the person: their full name, or their first name as a word (3+ letters;
    `exactCase`: only as capitalised on the roster, so "I will" never names a Will). */
export function names(text: string, fullName: string, exactCase = false): boolean {
  const full = fullName.trim();
  if (!full) return false;
  const word = (w: string, flags: string) => new RegExp(`(^|[^\\p{L}])${escape(w)}($|[^\\p{L}])`, flags).test(text);
  if (full.includes(" ") && word(full, "iu")) return true;
  const first = full.split(/\s+/)[0]!;
  return first.length >= 3 && word(first, exactCase ? "u" : "iu");
}

/**
 * Whether the holder chose (or confirmed) the person the model hands to: the holder named them in
 * one of their own messages, the goal names them (the operator chose), or the model proposed them
 * in a reply since the last hand-off and the holder has answered since. Otherwise the model picked
 * someone on its own.
 */
export function handoffChosen(branch: readonly Entry[], holder: string, target: string, goal: string): boolean {
  if (names(goal, target)) return true;
  const sentBy = new Map<string, string>();
  for (const e of branch) if (e.type === "custom" && e.customType === BATON_SENT_ENTRY && typeof e.data?.targetId === "string") sentBy.set(e.data.targetId, e.data.by);
  let lastUser: string | undefined;
  for (const e of branch) if (e.type === "message" && e.message?.role === "user") lastUser = e.id;
  let proposed = false;
  for (const e of branch) {
    // A name the model mentioned before this hand-off was never put to this holder.
    if (e.type === "custom" && (e.customType === BATON_HANDOFF_ENTRY || e.customType === BATON_OFFER_ENTRY)) proposed = false;
    if (e.type !== "message") continue;
    const text = textOf(e.message?.content);
    if (e.message?.role === "assistant") {
      if (names(text, target)) proposed = true;
      continue;
    }
    if (e.message?.role !== "user") continue;
    // Its marker lands a microtask after the message: until then, the last message is the holder's.
    const by = sentBy.get(e.id) ?? (e.id === lastUser ? holder : undefined);
    if (by !== holder) continue;
    if (names(text, target) || proposed) return true;
  }
  return false;
}

/**
 * Whether a profile quote is about someone other than its author: it names another person on the
 * roster (or the operator), or talks about a "he"/"she" without any "I". What someone says about a
 * colleague is never a fact about themselves. Returns who it is about, or null.
 */
export function aboutSomeoneElse(quote: string, author: Person, roster: readonly Person[], operator: string): string | null {
  for (const p of roster) if (p.id !== author.id && names(quote, p.name, true) && !names(p.name, author.name, true)) return p.name;
  if (operator && names(quote, operator, true) && !names(operator, author.name, true)) return operator;
  const q = quote.toLowerCase();
  const third = /(^|[^\p{L}])(he|she|his|her|him|él|ella)($|[^\p{L}])/u.test(q);
  const first = /(^|[^\p{L}])(i|i'm|i've|i'd|i'll|my|me|mine|yo|mi|mis|me|je|j'|moi|mon|ma|mes|ich|mein|meine|eu|meu|minha|io|mio|mia)($|[^\p{L}])/u.test(q);
  return third && !first ? "someone else" : null;
}

// ---- language -----------------------------------------------------------------------------------------------

/** Frequent function words: enough to tell the languages people write to an org in apart. */
const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "is", "are", "to", "of", "in", "it", "that", "we", "you", "i", "for", "with", "have", "this", "be", "not", "on", "our", "my", "do", "what", "if", "can", "all", "they", "was", "would", "should"],
  es: ["el", "la", "los", "las", "de", "que", "y", "es", "en", "un", "una", "por", "para", "con", "no", "se", "lo", "del", "al", "yo", "mi", "pero", "más", "todo", "son", "está", "hay", "tengo", "como", "nosotros"],
  pt: ["o", "a", "os", "as", "de", "que", "e", "é", "em", "um", "uma", "para", "com", "não", "se", "do", "da", "no", "na", "eu", "meu", "mas", "mais", "tudo", "são", "está", "tenho", "como", "nós", "você"],
  fr: ["le", "la", "les", "de", "des", "que", "et", "est", "en", "un", "une", "pour", "avec", "pas", "ne", "se", "du", "au", "je", "mon", "mais", "plus", "tout", "sont", "nous", "vous", "il", "elle", "sur", "ce"],
  de: ["der", "die", "das", "und", "ist", "zu", "den", "ein", "eine", "nicht", "mit", "ich", "wir", "sie", "es", "für", "auf", "von", "dem", "des", "aber", "auch", "sind", "haben", "wie", "mein", "oder", "wenn", "kann", "bitte"],
  it: ["il", "la", "le", "di", "che", "e", "è", "in", "un", "una", "per", "con", "non", "si", "del", "della", "io", "mio", "ma", "più", "tutto", "sono", "noi", "lo", "gli", "al", "anche", "come", "ho", "questo"],
  nl: ["de", "het", "een", "en", "is", "van", "dat", "niet", "ik", "wij", "we", "je", "met", "voor", "op", "te", "zijn", "maar", "ook", "als", "er", "aan", "bij", "mijn", "hebben", "wat", "kan", "dit", "om", "naar"],
};

/**
 * The language a person writes in, as a BCP-47 primary tag, from their own messages; null when
 * there is too little text or no clear winner (two languages close, or too few known words). Pure.
 */
export function detectLanguage(texts: readonly string[]): string | null {
  const words = texts
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  if (words.length < 6) return null;
  const scores = Object.entries(STOPWORDS).map(([tag, list]) => {
    const set = new Set(list);
    return [tag, words.filter((w) => set.has(w)).length] as const;
  });
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (!best || best[1] < 3 || best[1] < words.length * 0.15) return null;
  return best[1] >= 2 * (second?.[1] ?? 0) ? best[0] : null;
}
