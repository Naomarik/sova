/**
 * The home-card place (§app.extensions/card-status): the lines under an extension's card on the
 * landing page. The reply place's pattern (src/lib/reply-place.ts) for a card. Two lanes, always in
 * this order: Sova's own built-in lines (trusted, drawn as before), then the one status line the
 * extension adds about itself: data Sova draws (plain text and a tone), never markup.
 *
 * The extension lane costs nothing until a running extension's offers name `card`: no request, no
 * state. Each one that does is asked once per drawing of the Extensions section, GET
 * /ext/<id>/api/screens/card through the proxy, never again on a later poll of the list. Its answer
 * is validated, capped and timed out like a reply slot's, with its own off switch and auto-mute.
 */
import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { ExtensionInfo } from "../../shared/protocol";
import { offersPlace, screenPath } from "../../shared/extension-offers";
import { CHIP_TONES, OFF_KEY, createSlotPolicy, readCappedJson, SLOT_TIMEOUT_MS, type ChipTone, type SlotPolicy, type SlotStorage } from "./reply-slot";

/** A status line's text past this many characters is refused whole. */
export const CARD_TEXT_MAX = 60;
/** An answer past this many bytes is dropped whole. */
export const CARD_ANSWER_MAX_BYTES = 64 * 1024;

/** One line on a card. `down` is Sova's own reason line (its `reason`, drawn in the sentence `text`
    says); `status` is a status line with a tone. */
export interface CardLine {
  kind: "down" | "status";
  text: string;
  reason?: string;
  tone?: ChipTone;
  /** The extension that added it; absent for Sova's own. */
  extension?: string;
}

/** One of Sova's own contributions to the place: the line it draws on a card, or null. */
export interface CardBuiltIn {
  id: string;
  line(ext: ExtensionInfo): CardLine | null;
}

/** Sova's own lines, in the order they stand. The first is the reason a down card gives. */
export const CARD_BUILT_INS: readonly CardBuiltIn[] = [
  {
    id: "backend-down",
    line: (ext) => {
      if (ext.status !== "down") return null;
      const reason = ext.error ?? "no reason given";
      return { kind: "down", text: `Its backend isn't answering: ${reason}.`, reason };
    },
  },
];

/** Plain text only: never `<`, `>`, quotes, `&`, backticks or controls (the reply chips' rule). */
const PLAIN = /^[\p{L}\p{N} .,:;!?()/+#%_-]+$/u;

/** Sova's own words on a card: an extension's line may not read as one of them. */
export const isSovaCardWords = (text: string): boolean => {
  const t = text.trim().toLowerCase();
  return t === "running" || t === "down" || t.startsWith("its backend");
};

/** An answer `{"status": {"text", "tone"?}}` → the line it may draw, or null and bad. */
export function validateCardAnswer(raw: unknown, extension: string): { line: CardLine | null; bad: boolean } {
  const no = { line: null, bad: true };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return no;
  const st = (raw as Record<string, unknown>).status;
  if (st === undefined || st === null) return { line: null, bad: false };
  if (typeof st !== "object" || Array.isArray(st)) return no;
  const { text, tone } = st as Record<string, unknown>;
  if (typeof text !== "string" || !text || text.trim() !== text || text.length > CARD_TEXT_MAX || !PLAIN.test(text) || isSovaCardWords(text)) return no;
  if (tone !== undefined && !(CHIP_TONES as readonly unknown[]).includes(tone)) return no;
  return { line: { kind: "status", text, tone: (tone as ChipTone | undefined) ?? "muted", extension }, bad: false };
}

/** The running extensions whose offers name the card place. */
export const cardExtensions = (list: readonly ExtensionInfo[] | undefined): string[] =>
  (list ?? []).filter((e) => e.status === "ok" && offersPlace(e.offers, "card")).map((e) => e.id);

/** The off switch's own key, so hiding a card's line never hides what it adds under replies. */
export const CARD_OFF_KEY = "sova.card-place.off";

/** A storage whose off key is the card place's own, so the reply switch is never touched. */
export const cardStorage = (ls: SlotStorage): SlotStorage => {
  const key = (k: string) => (k === OFF_KEY ? CARD_OFF_KEY : k);
  return { getItem: (k) => ls.getItem(key(k)), setItem: (k, v) => ls.setItem(key(k), v) };
};

const storage = (): SlotStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** One switch and one mute record for the card place, shared by the page. */
export const cardPolicy = createSlotPolicy(storage(), CARD_OFF_KEY);
const [cardPolicyVersion, setCardPolicyVersion] = createSignal(0);
cardPolicy.subscribe(() => setCardPolicyVersion((v) => v + 1));
/** The user's switch for one extension's card line, reactive. */
export const cardLineOff = (id: string): boolean => (cardPolicyVersion(), cardPolicy.isOff(id));
/** Sova muted its card line until the page reloads, reactive. */
export const cardLineMuted = (id: string): boolean => (cardPolicyVersion(), cardPolicy.isMuted(id));

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The extension lane for one drawing of the Extensions section. `sync` (called with the list each
 * time it is read) asks each running extension that names `card` the first time it appears, and
 * never again for this drawing. `line(id)` is its status line, or undefined; off or muted hides it.
 */
export function createCardAdditions(opts: { fetch?: Fetch; policy?: SlotPolicy; timeoutMs?: number } = {}) {
  const fetch: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const policy = opts.policy ?? cardPolicy;
  const timeoutMs = opts.timeoutMs ?? SLOT_TIMEOUT_MS;
  const [lines, setLines] = createSignal<ReadonlyMap<string, CardLine> | null>(null);
  const asked = new Set<string>();
  const controllers = new Set<AbortController>();
  let stopped = false;
  const [version, setVersion] = createSignal(0);
  onCleanup(policy.subscribe(() => setVersion((v) => v + 1)));

  const askOne = (id: string) => {
    const ac = new AbortController();
    controllers.add(ac);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const answer = fetch(`/ext/${encodeURIComponent(id)}${screenPath("card")}`, { signal: ac.signal, headers: { accept: "application/json" }, credentials: "same-origin" }).then(
      (res) => readCappedJson(res, CARD_ANSWER_MAX_BYTES),
    );
    // The time limit holds even for an answer that never heeds the abort.
    const late = new Promise<never>((_, fail) => ac.signal.addEventListener("abort", () => fail(new Error("timeout")), { once: true }));
    Promise.race([answer, late])
      .then(
        (raw) => {
          if (stopped) return;
          const v = validateCardAnswer(raw, id);
          policy.note(id, !v.bad);
          if (!v.line) return;
          const next = new Map(lines() ?? []);
          next.set(id, v.line);
          setLines(next);
        },
        () => {
          if (!stopped) policy.note(id, false);
        },
      )
      .finally(() => {
        clearTimeout(timer);
        controllers.delete(ac);
      });
  };

  onCleanup(() => {
    stopped = true;
    for (const ac of controllers) ac.abort();
  });

  return {
    sync(list: readonly ExtensionInfo[] | undefined): void {
      for (const id of cardExtensions(list)) {
        if (asked.has(id)) continue;
        asked.add(id);
        if (policy.isOff(id) || policy.isMuted(id)) continue;
        askOne(id);
      }
    },
    line: (id: string): CardLine | undefined => {
      const l = lines()?.get(id);
      if (!l) return undefined;
      version();
      return policy.isOff(id) || policy.isMuted(id) ? undefined : l;
    },
  };
}

/** Every line a card draws: Sova's built-ins, then the extension's own. */
export function cardLines(ext: ExtensionInfo, added: Accessor<CardLine | undefined>): CardLine[] {
  const out: CardLine[] = [];
  for (const b of CARD_BUILT_INS) {
    const l = b.line(ext);
    if (l) out.push(l);
  }
  // What it said while running stays off a card that is down now.
  const a = ext.status === "ok" ? added() : undefined;
  if (a) out.push(a);
  return out;
}
