// "How memory works" (§chat.memory/help): the words and drawings of Settings → Memory's help card.
// Static: the drawings are `vis` sources drawn by the chat's own renderer, never a model's. The
// figures are the engine's — memory-help.test.ts pins each one to the server's constant.
import type { MemoryType } from "../../shared/protocol";
import { MEMORY_SIZES, memoryTypeInfo } from "../../shared/memory";

/** A summary line's asked size (server/memory/tree.ts `LIMIT`, bytes), as the card rounds it. */
export const HELP_LINE_CHARS = 500;
/** How long a turn waits for the newest summaries (server/memory/engine.ts `WAIT_MS`). */
export const HELP_WAIT_SECONDS = 20;
/** The summarizer new installs start with (server/memory/settings.ts `DEFAULT_SUMMARIZER`). */
export const HELP_DEFAULT_SUMMARIZER = "Haiku 5.5 at low effort";

export interface HelpDrawing {
  /** The fence's kind word (`vis flow`). */
  kind: string;
  body: string;
}

export interface MemoryHelpTab {
  type: MemoryType;
  label: string;
  /** UniiChat's credit and its design's link; absent for Sova's own type. */
  by?: string;
  link?: string;
  sentences: string[];
  drawings: HelpDrawing[];
}

const uniichat = memoryTypeInfo("uniichat");
const zoomable = memoryTypeInfo("zoomable");
const range = (size: number) => `${size / 2}–${size} KB`;

export const MEMORY_HELP_TABS: readonly MemoryHelpTab[] = [
  {
    type: "uniichat",
    label: uniichat.label,
    by: uniichat.by,
    link: uniichat.link,
    sentences: [
      `One chat that never ends: every message is kept, and a small model sums each one up in a line of about ${HELP_LINE_CHARS} characters.`,
      "Each turn, the model reads its instructions, then summary lines covering the whole chat — 1 line per recent message, coarser lines for older ones — then your new message.",
      `When the lines outgrow the chat's size, older neighbors merge in pairs until they fill about half of it (${range(uniichat.defaultSize)} by default).`,
      "The model can open any line back into the 2 it was made from, down to the original message word for word.",
    ],
    drawings: [
      {
        kind: "layers",
        body: [
          "title: What the model reads each turn",
          "Instructions | How to read the lines and open one",
          'Summary lines | "Old messages, a line per many", "Recent messages, a line each" | the whole chat | accent',
          'New message | "Yours, in full, with the replies so far"',
        ].join("\n"),
      },
      {
        kind: "tree",
        body: [
          "title: Lines merge, and open back up",
          "caption: 2 lines merge into 1 coarser line; opening it goes back down, to the message itself.",
          '"Line for messages 40–43" "what the model sees"',
          '  "Line for messages 40–41"',
          '    "Message 40" "word for word"',
          '    "Message 41"',
          '  "Line for messages 42–43"',
          '    "Message 42"',
          '    "Message 43"',
        ].join("\n"),
      },
    ],
  },
  {
    type: "zoomable",
    label: zoomable.label,
    sentences: [
      "The chat works as it does today: the model sees every message in full.",
      "Meanwhile, a small model sums up each message in a line, in the background.",
      `When the chat would compact, its older part becomes those lines, merged to fit the chat's size (${zoomable.defaultSize} KB by default), instead of a one-off summary; the recent part stays as it is.`,
      "The model can open any line back into the 2 it was made from, down to the original message word for word.",
    ],
    drawings: [
      {
        kind: "flow",
        body: [
          "title: Before and after it compacts",
          "== Before ==",
          'old "Older messages\\nin full" -> new "Recent messages\\nin full"',
          "== After ==",
          'lines "Summary lines\\nthe model can open" accent -> recent "Recent messages\\nin full"',
        ].join("\n"),
      },
      {
        kind: "steps",
        body: [
          "title: What a compaction leaves",
          '"Usual compaction" muted | "Long chat" -> "One-off summary" -> "Details gone"',
          '"Zoomable compaction" ok | "Long chat" -> "Summary lines" -> "Details opened when needed"',
        ].join("\n"),
      },
    ],
  },
];

/** "What the settings change", under the tabs. */
export const MEMORY_HELP_SETTINGS: readonly { term: string; text: string }[] = [
  {
    term: "Summary size",
    text: `Set per chat, in the mode menu's Memory type panel (${MEMORY_SIZES[0]} to ${MEMORY_SIZES[MEMORY_SIZES.length - 1]} KB). Bigger keeps more of the chat in fine detail but costs more each turn; smaller merges sooner and leans on the model opening lines.`,
  },
  {
    term: "Summarizer model and effort",
    text: `Set on this page. They decide how fast lines are written, what they cost, and how good they are; ${HELP_DEFAULT_SUMMARIZER} is the default. A turn waits up to ${HELP_WAIT_SECONDS} seconds for the newest lines, so a slow summarizer can hold up a reply.`,
  },
];

/** The tab the card opens on: the saved default type when Settings knows one, else UniiChat. */
export const initialHelpTab = (saved: MemoryType | undefined): MemoryType => (saved && MEMORY_HELP_TABS.some((t) => t.type === saved) ? saved : "uniichat");
