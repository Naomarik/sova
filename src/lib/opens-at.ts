import type { PublicLinksFile, PublicLinksInfo, PublicLinksPatch } from "../../shared/public-links";

/**
 * "Where links open" (Settings → Public links and every share screen): the setting as sections of
 * options, one host-wide choice. Pure: the panel, the compact line on share screens and their tests
 * read the same words. Cloudflare (Free, Account), Tailscale (Funnel, Through {computer}), Your own
 * web server, and Off (Settings only).
 */

export type OpensAtKey = "free" | "account" | "you-run-it" | "funnel" | "web-server" | "off" | `through:${string}`;
export type OpensAtSectionId = "cloudflare" | "tailscale" | "web-server" | "off";
/** `on`: the saved choice. `ready`: set up, picking it switches. `needs-setup`: greyed but
    selectable; picking it opens its setup help. */
export type OpensAtState = "on" | "ready" | "needs-setup";
/** Which setup help (and Set Up With a Chat brief) an option opens. `through` has no chat. */
export type OpensAtSetupKind = "account" | "web-server" | "funnel" | "through";

export interface OpensAtOption {
  key: OpensAtKey;
  section: OpensAtSectionId;
  label: string;
  hint: string;
  state: OpensAtState;
  /** A line under the option (Through {computer}: who serves its links). */
  note?: string;
  /** `Default`: Free, picked because nothing else was chosen. */
  badge?: string;
  /** The row's state word when it isn't STATE_WORDS[state]: Free picked before Turn On is "Not turned on". */
  stateWord?: string;
  setup?: OpensAtSetupKind;
}

export interface OpensAtSection {
  id: OpensAtSectionId;
  title: string;
  options: OpensAtOption[];
}

export const SECTION_TITLES: Readonly<Record<OpensAtSectionId, string>> = {
  cloudflare: "Cloudflare",
  tailscale: "Tailscale",
  "web-server": "Your own web server",
  off: "Off",
};

/** The line under every list of options: the choice is the computer's, not the link's. */
export const APPLIES_TO_ALL = "Applies to every link from this computer.";

export const throughNote = (computer: string): string => `${computer} serves these with its own web server (Your own domain).`;

/** The option a setting is, read from the file (the effective one GET answers, or a draft's route
    and front). null: nothing to select (the saved setup can't be read). */
export function keyOf(f: Pick<PublicLinksFile, "route" | "gateway">, flags: { broken?: boolean } = {}): OpensAtKey | null {
  if (flags.broken) return null;
  const r = f.route;
  if (typeof r === "object") return `through:${r.via.nodeId}`;
  switch (r) {
    case "quick":
      return "free";
    case "account":
      return "account";
    case "off":
      return "off";
    case "self":
      switch (f.gateway?.front) {
        case "funnel":
          return "funnel";
        case "cloudflared":
          return "you-run-it";
        default:
          return "web-server";
      }
  }
}

const savedFront = (i: PublicLinksInfo) => (i.file.gateway?.publicUrl ? i.file.gateway.front : null);
/** Cloudflare Account can run: an address and a stored token (Sova runs it). */
const accountReady = (i: PublicLinksInfo) => !!i.file.account?.publicUrl && !!i.account?.hasToken;

/** The Through options: one per peer advertising a gateway, and the saved one when it no longer advertises. */
function throughs(i: PublicLinksInfo): { nodeId: string; name: string }[] {
  const out = (i.gateways ?? []).map((g) => ({ nodeId: g.nodeId, name: g.peer }));
  const r = i.file.route;
  if (typeof r === "object" && !out.some((o) => o.nodeId === r.via.nodeId)) out.push({ nodeId: r.via.nodeId, name: i.share.via ?? r.via.nodeId });
  return out;
}

/** The computer a Through option names, or null. */
export function throughName(i: PublicLinksInfo, key: OpensAtKey): string | null {
  if (!key.startsWith("through:")) return null;
  const id = key.slice("through:".length);
  return throughs(i).find((t) => t.nodeId === id)?.name ?? (id || null);
}

/**
 * The sections, each option with its state. `selected`: the option shown as chosen (the saved one,
 * or a draft's in Settings); `withOff`: Off is offered (Settings only).
 */
export function opensAtSections(i: PublicLinksInfo, opts: { selected?: OpensAtKey | null; withOff?: boolean } = {}): OpensAtSection[] {
  const saved = keyOf(i.file, i);
  const selected = opts.selected === undefined ? saved : opts.selected;
  const state = (key: OpensAtKey, ready: boolean): OpensAtState => (key === selected ? "on" : ready ? "ready" : "needs-setup");
  const front = savedFront(i);

  const sections: OpensAtSection[] = [
    {
      id: "cloudflare",
      title: SECTION_TITLES.cloudflare,
      options: [
        {
          key: "free",
          section: "cloudflare",
          label: "Free",
          hint: "No account needed. The address is random and changes when this computer restarts.",
          state: state("free", true),
          ...(i.implicit && saved === "free" ? { badge: "Default" } : {}),
          // Picked but nothing public yet (§mesh.tunnel/turn-on): the row says so, as the panel's chip does.
          ...(selected === "free" && i.consentAt === null ? { stateWord: "Not turned on" } : {}),
        },
        { key: "account", section: "cloudflare", label: "Account", hint: "Your own address, through your Cloudflare account. Sova runs the tunnel.", state: state("account", accountReady(i)), setup: "account" },
        // A tunnel the user runs (a gateway whose front is cloudflared): shown only where one is saved.
        ...(front === "cloudflared" || selected === "you-run-it"
          ? [{ key: "you-run-it" as const, section: "cloudflare" as const, label: "You run it", hint: "A Cloudflare tunnel you run yourself.", state: state("you-run-it", front === "cloudflared") }]
          : []),
      ],
    },
    {
      id: "tailscale",
      title: SECTION_TITLES.tailscale,
      options: [
        { key: "funnel", section: "tailscale", label: "Funnel", hint: "A public address from Tailscale Funnel, for this computer.", state: state("funnel", front === "funnel"), setup: "funnel" },
        ...throughOptions(i, state),
      ],
    },
    {
      id: "web-server",
      title: SECTION_TITLES["web-server"],
      options: [
        {
          key: "web-server",
          section: "web-server",
          label: "Your own web server",
          hint: "Your own domain, served by Caddy or nginx on this computer.",
          state: state("web-server", front === "vhost" || front === "caddy"),
          setup: "web-server",
        },
      ],
    },
  ];
  if (opts.withOff)
    sections.push({
      id: "off",
      title: SECTION_TITLES.off,
      options: [{ key: "off", section: "off", label: "Off", hint: "Sharing is off: no Share buttons, and nothing makes a link.", state: state("off", true) }],
    });
  return sections;
}

function throughOptions(i: PublicLinksInfo, state: (key: OpensAtKey, ready: boolean) => OpensAtState): OpensAtOption[] {
  const list = throughs(i);
  if (!list.length)
    return [
      {
        key: "through:",
        section: "tailscale",
        label: "Through another computer",
        hint: "Links go over Tailscale to another of your computers that has a public address.",
        state: state("through:", false),
        setup: "through",
      },
    ];
  return list.map((t) => ({
    key: `through:${t.nodeId}` as const,
    section: "tailscale" as const,
    label: `Through ${t.name}`,
    hint: `Links go over Tailscale to ${t.name}. ${t.name} must be on for them to open.`,
    note: throughNote(t.name),
    state: state(`through:${t.nodeId}`, true),
  }));
}

/** Every option, in order. */
export const opensAtOptions = (sections: readonly OpensAtSection[]): OpensAtOption[] => sections.flatMap((s) => s.options);

/** An option as a sentence names it: "Cloudflare Free", "Tailscale Funnel", "Through vps", "Your own web server". */
export function optionName(o: Pick<OpensAtOption, "key" | "section" | "label">): string {
  if (o.key === "you-run-it") return "your own Cloudflare tunnel";
  if (o.section === "cloudflare" || o.key === "funnel") return `${SECTION_TITLES[o.section]} ${o.label}`;
  return o.label;
}

/** The saved choice as one line: "Cloudflare Free", "Tailscale Funnel", "Through vps", … */
export function currentLine(i: PublicLinksInfo): string {
  const key = keyOf(i.file, i);
  if (!key) return "Can't read setting";
  if (key === "off") return "Off";
  const o = opensAtOptions(opensAtSections(i, { withOff: true })).find((x) => x.key === key);
  return o ? optionName(o) : "Cloudflare Free";
}

/** The one line a share screen shows. */
export const opensAtLine = (i: PublicLinksInfo): string => `Links open with ${currentLine(i)}.`;

/** An option's state as its row says it (greyed when it needs setup). */
export const STATE_WORDS: Readonly<Record<OpensAtState, string>> = { on: "On", ready: "Ready", "needs-setup": "Needs setup" };

/** What picking a ready option sends (PUT /api/public-links); null when it needs setup first. */
export function patchFor(i: PublicLinksInfo, key: OpensAtKey): PublicLinksPatch | null {
  const o = opensAtOptions(opensAtSections(i, { withOff: true })).find((x) => x.key === key);
  if (!o || o.state === "needs-setup") return null;
  if (key === "free") return { route: "quick" };
  if (key === "off") return { route: "off" };
  if (key === "account") return { route: "account" };
  if (key === "you-run-it" || key === "funnel" || key === "web-server") return { route: "self" };
  return { route: { via: { nodeId: key.slice("through:".length) } } };
}

/** Free is the saved choice and the operator hasn't pressed Turn On yet (q11): no Free tunnel starts. */
export const needsTurnOn = (i: PublicLinksInfo | null | undefined): boolean => !!i && i.file.route === "quick" && i.consentAt === null;

/** Free is the saved choice and cloudflared isn't on this computer: the Download prompt shows. */
export const needsCloudflared = (i: PublicLinksInfo | null | undefined): boolean =>
  !!i && (i.file.route === "quick" || i.file.route === "account") && i.tunnel?.cloudflared.found === false;

/** Sharing is off entirely (q12): every Share button and the home page's share area are hidden. */
export const sharingIsOff = (i: PublicLinksInfo | null | undefined): boolean => !!i?.sharingOff;
