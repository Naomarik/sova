import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { LinkCreate, LinkError, LinkMemberView, MeshLinkView } from "../shared/mesh-links";
import type { ToolCall } from "./overseer-idea-tools";

/**
 * The Overseer's link tools (§app.overseer/links-tools): `sova_link` and `sova_unlink` make and end
 * links between sessions on different mesh hosts (acts: audited, refused in a turn the user did not
 * start, no confirm card, since a link changes no session and sends nothing), and `sova_links` lists
 * every link this host knows (a read). All three call this host's link store (server/mesh/links.ts
 * `meshLinks`) in-process, the same code the `/api/mesh/links` routes run, so the refusals (a
 * TUI-live, archived, worker, Overseer, baton or project-overseer member, a host that is down or
 * skewed, two members on one host) are its own, worded by it and naming the member, and every peer
 * hop is its too: the Overseer never talks to a peer here.
 * The Overseer is never a member, and never sends into a link.
 */

type Out = { content: { type: "text"; text: string }[]; details: unknown };
type Tool = ToolDefinition<any, any>;

export interface LinkToolDeps {
  act(name: string, run: (params: any, toolCallId: string, call: ToolCall) => Promise<Out>): Tool["execute"];
  read(run: (params: any, call: ToolCall & { toolCallId: string }) => Promise<Out>): Tool["execute"];
  /** This host's links (server/mesh/links.ts `meshLinks`). A refusal throws an error with a
      `body: LinkError` (`LinkActError`). */
  links: LinksApi;
  /** One link made, or the cap's refusal sentence (nothing taken then). */
  take(): string | null;
  /** A refusal the model relays (logged "refused"). */
  refusal(message: string): Error;
  obj(properties: Record<string, unknown>, required?: string[]): any;
  str(description: string, extra?: Record<string, unknown>): unknown;
}

/** The part of `meshLinks` the tools use. */
export interface LinksApi {
  list(opts?: { sessionId?: string }): Promise<MeshLinkView[]>;
  create(req: LinkCreate): Promise<MeshLinkView>;
  end(linkId: string): Promise<MeshLinkView>;
}

const text = (t: string) => [{ type: "text" as const, text: t }];

function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** A member in one line: `<host> <session id> "<title>" · <state> · active 3m ago`. A local
    member's session is a link; a peer's is not (sova:// opens this host's sessions only). */
export function memberRow(m: LinkMemberView, now = Date.now()): string {
  const host = m.self ? "this host" : m.hostId ? `${m.hostLabel} (${m.hostId})` : `${m.hostLabel} (not in this host's peers)`;
  const title = (m.title ?? "untitled").replace(/[[\]]/g, "");
  const who = m.self ? `[${title}](sova://s/${m.sessionId})` : `${m.sessionId} "${title}"`;
  const state = m.reach === "down" ? "host offline" : m.reach === "unknown-host" ? "unreachable" : m.state;
  const parts = [host, who, state];
  if (m.model) parts.push(m.model);
  if (m.lastActivity) parts.push(`active ${ago(m.lastActivity, now)}`);
  if (m.archived) parts.push("archived");
  return parts.join(" · ");
}

/** One link: its id, when made, ended or not, then a line per member. */
export function linkBlock(v: MeshLinkView, now = Date.now()): string {
  const head = `- ${v.link.id} · made ${ago(v.link.createdAt, now)}${v.link.endedAt ? ` · ENDED ${ago(v.link.endedAt, now)}` : ""}`;
  return [head, ...v.members.map((m) => `  - ${memberRow(m, now)}`)].join("\n");
}

const isView = (v: unknown): v is MeshLinkView => !!v && typeof v === "object" && typeof (v as MeshLinkView).link?.id === "string" && Array.isArray((v as MeshLinkView).members);

export function linkTools(d: LinkToolDeps): Tool[] {
  const { obj, str } = d;
  /** The store's refusal, verbatim (it names the member); anything else is an error as it is. */
  const refused = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      const body = (err as { body?: LinkError } | null)?.body;
      if (typeof body?.error === "string") throw d.refusal(body.error);
      throw err;
    }
  };

  return [
    {
      name: "sova_link",
      label: "Link sessions",
      description:
        "Link two or more sessions on different mesh hosts, so their agents can message each other (link_send, link_inbox, link_members in those sessions). Each member is a session id and its host (a peer id from the Mesh page; leave host out for this host), one member per host. Refused for a terminal-owned, archived, subagent, baton or project-overseer session, your own, a host that is down or on another protocol, and two sessions on one host. Linking changes no session and sends nothing. Counts against the per-turn link cap. You are never a member, and you never send into a link: to tell a local member something, sova_send it.",
      promptSnippet: "link sessions on different mesh hosts (one per host) so their agents can message each other",
      parameters: obj(
        {
          members: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            description: "The sessions to link, one per host.",
            items: obj({ host: str("A peer id; omit for this host."), session: str("Session id on that host.") }, ["session"]),
          },
        },
        ["members"],
      ),
      execute: d.act("sova_link", async (p) => {
        const raw: unknown[] = Array.isArray(p.members) ? p.members : [];
        const members = raw.map((m: any) => ({
          ...(typeof m?.host === "string" && m.host.trim() ? { host: m.host.trim() } : {}),
          session: typeof m?.session === "string" ? m.session.trim().replace(/^sova:\/\/s\//, "") : "",
        }));
        if (members.length < 2) throw d.refusal("A link needs at least two members, each a session on its own host.");
        const blank = members.findIndex((m) => !m.session);
        if (blank >= 0) throw d.refusal(`Member ${blank + 1} has no session id.`);
        const hosts = members.map((m) => m.host ?? "");
        const twice = hosts.findIndex((h, i) => hosts.indexOf(h) !== i);
        if (twice >= 0)
          throw d.refusal(`Members ${hosts.indexOf(hosts[twice]!) + 1} and ${twice + 1} are both on ${hosts[twice] ? `host ${hosts[twice]}` : "this host"}; a link joins one session per host.`);
        const over = d.take();
        if (over) throw d.refusal(over);
        const v = await refused(() => d.links.create({ members }));
        return { content: text(`Linked ${v.members.length} sessions as ${v.link.id}:\n${v.members.map((m) => `- ${memberRow(m)}`).join("\n")}`), details: v };
      }),
    },
    {
      name: "sova_unlink",
      label: "End link",
      description:
        "End a link on every member host. Its members stay as they are; the link stays listed as ended, and its tools refuse to use it. A host that is down gets the end when it next comes up.",
      promptSnippet: "end a link on every member host",
      parameters: obj({ link: str("The link id (lk_…, from sova_links).") }, ["link"]),
      execute: d.act("sova_unlink", async (p) => {
        const id = typeof p.link === "string" ? p.link.trim() : "";
        if (!/^lk_[0-9a-f]{16}$/.test(id)) throw d.refusal("Name the link by its id (lk_ and 16 hex digits, from sova_links).");
        const v = await refused(() => d.links.end(id));
        return { content: text(`Ended ${id}:\n${v.members.map((m) => `- ${memberRow(m)}`).join("\n")}`), details: v };
      }),
    },
    {
      name: "sova_links",
      label: "Links",
      description:
        "Every link this host knows, newest first: each member's host, session, state (working, idle, host offline) and last activity. Ended links are included and marked ENDED.",
      promptSnippet: "list the links between sessions across hosts, with each member's state",
      parameters: obj({}),
      execute: d.read(async () => {
        const links = (await refused(() => d.links.list())).filter(isView).sort((a, b) => b.link.createdAt - a.link.createdAt);
        const now = Date.now();
        const live = links.filter((v) => !v.link.endedAt).length;
        const head = `${live} live link${live === 1 ? "" : "s"}, ${links.length - live} ended.`;
        return { content: text(links.length ? [head, ...links.map((v) => linkBlock(v, now))].join("\n") : "No links."), details: { count: links.length, ids: links.map((v) => v.link.id) } };
      }),
    },
  ];
}
