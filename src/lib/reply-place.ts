/**
 * The reply place (§app.commands/reply-place): what hangs under a delivered message. One place, two
 * lanes, always in this order: Sova's own built-in contributions (its message actions: trusted,
 * interactive, drawn by MessageActions), then what extensions add (data Sova draws, or a walled-off
 * frame: src/lib/reply-slot.ts, drawn by ReplySlot, under replies only). A new Sova feature under a
 * message is one more built-in here, not a new strip; an extension reaches the same place through
 * its offers, never through markup.
 *
 * The extension lane costs nothing until an installed extension's offers name `reply`: no request,
 * no state, and `added` answers undefined for every entry.
 */
import { createContext, createEffect, createMemo, createSignal, on, onCleanup, useContext, type Accessor } from "solid-js";
import type { ExtensionInfo } from "../../shared/protocol";
import { offersPlace, screenPath } from "../../shared/extension-offers";
import type { MessageActionItem } from "../components/MessageActions";
import { MENU_RUN_TIMEOUT_MS } from "./menu-place";
import type { MessageStrip } from "./message-actions";
import { createReplyAnswers, createSlotPolicy, readCappedJson, type ReplyChip, type SlotExtension, type SlotPolicy, type SlotSource, type SlotState, type SlotStorage } from "./reply-slot";

/** One of Sova's own contributions to the place: the buttons it adds to a message's strip. */
export interface ReplyBuiltIn {
  id: string;
  items(strip: MessageStrip): MessageActionItem[];
}

/** What a view puts in the place. Absent from a transcript (a subagent's): no strip at all. */
export interface ReplyPlace {
  /** Sova's own contributions, in the order their buttons stand. */
  builtIns: readonly ReplyBuiltIn[];
  /** The last refusal for that entry, kept on its row after the announcement. */
  note?(entryId: string): string | null;
  /** What extensions add under that entry, or undefined: nothing to draw. */
  added?(entryId: string): SlotState | undefined;
  /** Run a chip's declared action for that entry; resolves to null, or what went wrong. */
  runChip?(chip: ReplyChip, entryId: string): Promise<string | null>;
}

/** The strip's buttons: every built-in's, in order. */
export const builtInItems = (place: ReplyPlace, strip: MessageStrip): MessageActionItem[] =>
  place.builtIns.length === 1 ? place.builtIns[0]!.items(strip) : place.builtIns.flatMap((b) => b.items(strip));

/** What extensions add under this strip: under a reply only, never under your own message. */
export const addedFor = (place: ReplyPlace, strip: MessageStrip): SlotState | undefined =>
  strip.role === "assistant" ? place.added?.(strip.entryId) : undefined;

// ---- the extensions that add to replies --------------------------------------------------------

/** The installed extensions as the page last read them (App's poll of GET /api/extensions). */
export const ExtensionsContext = createContext<Accessor<ExtensionInfo[] | undefined>>(() => undefined);

/** The running extensions whose offers name the reply place, as the slot knows them. */
export function replyExtensions(list: readonly ExtensionInfo[] | undefined): SlotExtension[] {
  const out: SlotExtension[] = [];
  for (const e of list ?? []) {
    if (e.status !== "ok" || !offersPlace(e.offers, "reply")) continue;
    out.push({ id: e.id, title: e.title, actions: (e.offers?.commands ?? []).map((c) => c.name) });
  }
  return out;
}

/** Same extensions, same titles, same actions: a poll that changes nothing asks nothing. */
export const sameExtensions = (a: readonly SlotExtension[], b: readonly SlotExtension[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.title === b[i]!.title && x.actions.join("\n") === b[i]!.actions.join("\n"));

const storage = (): SlotStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** One switch and one mute record for the whole page, shared by every view. */
export const slotPolicy = createSlotPolicy(storage());
const [policyVersion, setPolicyVersion] = createSignal(0);
slotPolicy.subscribe(() => setPolicyVersion((v) => v + 1));
/** The user's switch for one extension, reactive. */
export const additionsOff = (id: string): boolean => (policyVersion(), slotPolicy.isOff(id));
/** Sova muted it (bad answers, or a frame that navigated) until the page reloads, reactive. */
export const additionsMuted = (id: string): boolean => (policyVersion(), slotPolicy.isMuted(id));

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** GET /ext/<id>/api/screens/reply?session=<id>, through the proxy (which strips Sova's token). */
async function askReply(fetch: Fetch, id: string, session: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`/ext/${encodeURIComponent(id)}${screenPath("reply")}?session=${encodeURIComponent(session)}`, {
    signal,
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  return readCappedJson(res);
}

/**
 * The extension lane for one view's session. Asks each extension that adds to replies once when the
 * view has its session (and again when that set of extensions changes), once more when a run ends
 * (`running` goes from true to false), and after one of its chips' actions ran. Never per reply.
 * A session on another host is never asked about: an extension is this host's.
 */
export function useReplyAdditions(opts: { session: Accessor<string | undefined>; local: Accessor<boolean>; running: Accessor<boolean> }) {
  return createReplyAdditions({ ...opts, extensions: useContext(ExtensionsContext) });
}

/** useReplyAdditions with its extension list (and, for tests, its fetch) handed in. */
export function createReplyAdditions(opts: {
  session: Accessor<string | undefined>;
  local: Accessor<boolean>;
  running: Accessor<boolean>;
  extensions: Accessor<readonly ExtensionInfo[] | undefined>;
  fetch?: Fetch;
  policy?: SlotPolicy;
  /** How long a chip's action may take (tests): MENU_RUN_TIMEOUT_MS, as a menu entry's run. */
  runTimeoutMs?: number;
}) {
  const fetch: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const policy = opts.policy ?? slotPolicy;
  const extensions = opts.extensions;
  const sources = createMemo(() => replyExtensions(extensions()), [], { equals: sameExtensions });
  const [byEntry, setByEntry] = createSignal<ReadonlyMap<string, SlotState> | null>(null);
  let lane: { session: string; answers: ReturnType<typeof createReplyAnswers> } | null = null;

  const close = () => {
    lane?.answers.stop();
    lane = null;
    if (byEntry()) setByEntry(null);
  };
  const ask = () => {
    const session = opts.session();
    const list = sources();
    if (!session || !opts.local() || !list.length) return close();
    if (lane?.session !== session) {
      close();
      lane = { session, answers: createReplyAnswers(policy, (m) => setByEntry(m.size ? m : null)) };
    }
    lane.answers.ask(list.map((ext): SlotSource => ({ ext, ask: (signal) => askReply(fetch, ext.id, session, signal) })));
  };

  createEffect(on([opts.session, opts.local, sources], ask));
  createEffect(on(opts.running, (now, before) => before && !now && ask(), { defer: true }));
  onCleanup(close);

  return {
    added: (entryId: string): SlotState | undefined => byEntry()?.get(entryId),
    /** POST /ext/<id>/api/commands/<action> with {session, entry}, then ask again. */
    async runChip(chip: ReplyChip, entryId: string): Promise<string | null> {
      const session = opts.session();
      if (!chip.action || !session) return "Nothing to run.";
      try {
        const res = await fetch(`/ext/${encodeURIComponent(chip.extension)}/api/commands/${encodeURIComponent(chip.action)}`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ session, entry: entryId }),
          // Bounded, as a menu entry's run: one hung backend never holds every chip under the reply.
          signal: AbortSignal.timeout(opts.runTimeoutMs ?? MENU_RUN_TIMEOUT_MS),
        });
        await res.body?.cancel();
        if (!res.ok) return `${chip.extensionTitle} answered HTTP ${res.status}.`;
        return null;
      } catch {
        return `${chip.extensionTitle} isn't answering.`;
      } finally {
        ask();
      }
    },
  };
}
