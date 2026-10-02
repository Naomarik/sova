import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { OPERATOR } from "../shared/baton";
import type { OrgDetail, Person } from "../shared/orgs";
import type { SovaConfirmItem } from "../shared/protocol";
import { attentionChanged } from "./attention-memo";
import { cardHeader } from "./overseer-tools";
import { createBaton, handoffTo, offerTo, projectAbilities } from "./baton";
import type { OperatorBy } from "./orgs";
import { ABILITIES_PARAM, overseerAbilities } from "./gathering-abilities";
import type { ToolCall } from "./overseer-idea-tools";
import { orgOfProject, readHistory } from "./orgs";
import {
  batonOf,
  displayName,
  orgFull,
  orgsList,
  personView,
  projectView,
  resolveOrg,
  resolvePerson,
  resolveProject,
  ViewRefusal,
} from "./overseer-org-view";

/**
 * The global Overseer's organization tools (§app.overseer/org-tools): three reads and seven acts
 * over this host's organizations. Every act goes through the org, baton, decisions and
 * project-overseer routes in-process with the Overseer's sender mark (so a write is recorded as the
 * operator's, via the Overseer, §app.overseer/org-attribution, and every guard those routes have
 * applies), except starting a gathering session or an offer, and handing one on, which call Sova's
 * in-process start with no link minted (a link URL or token never reaches the model). Every result
 * is built by server/overseer-org-view.ts, never from a route's JSON.
 *
 * Acts that reach people or end something run only in a turn opened by a click on a confirm card
 * whose items list every target (§app.overseer/org-people-facing).
 */

type Out = { content: { type: "text"; text: string }[]; details: unknown };
type Tool = ToolDefinition<any, any>;
type Resp = { status: number; json: any };

export type OrgLimitKind = "org" | "gather" | "create" | "prompt";

export interface OrgToolDeps {
  act(name: string, run: (params: any, toolCallId: string, call: ToolCall) => Promise<Out>): Tool["execute"];
  read(run: (params: any, call: ToolCall & { toolCallId: string }) => Promise<Out>): Tool["execute"];
  refusal(message: string): Error;
  /** An in-process route call carrying the Overseer's sender mark. */
  call(method: string, path: string, body?: unknown): Promise<Resp>;
  /** Take one of a per-turn cap, or its refusal; `give` hands it back when the act then fails. */
  take(kind: OrgLimitKind): string | null;
  give(kind: OrgLimitKind): void;
  /** A running-at-once slot, taken synchronously (as sova_send's): none needed for a session that
      already counts as one the Overseer started; else its refusal, or the slot to release once the
      session counts on its own (or the start failed). */
  slot(path?: string): { refusal: string } | { release(): void };
  /** The session now counts as one the Overseer started (and prompted). */
  started(path: string, prompted?: boolean): void;
  /** The items of the confirm card whose click opened this turn; null: no card click opened it. */
  confirmed(): SovaConfirmItem[] | null;
  /** The Overseer's current conversation (recorded with its in-process acts, as a route's sender mark is). */
  overseerId?(): string;
  /** A session reference in any form the tools print it, reduced to its id. */
  sessionRef(raw: unknown): string;
  obj(properties: Record<string, unknown>, required?: string[]): any;
  str(description: string, extra?: Record<string, unknown>): unknown;
  int(description: string, extra?: Record<string, unknown>): unknown;
  bool(description: string): unknown;
}

const text = (t: string) => [{ type: "text" as const, text: t }];
const cut = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const enc = encodeURIComponent;

/** The refusal of a people-facing act outside a confirmed turn (§app.overseer/org-people-facing). */
export const confirmRefusal = (what: string) =>
  `This reaches people or ends something: ask with sova_card, listing ${what} in its items, and act in the turn the user's click starts.`;
/** What a started gathering session or offer says instead of a link. */
export const noLinkNote = (names: string[]) => `No link was made: Needs you asks you to send ${names.join(", ")} their link.`;

/** What a people-facing act acts on, for the confirm gate. */
interface Targets {
  sessions?: string[];
  people?: { orgId: string; id: string; name: string }[];
  projects?: { orgId: string; id: string; name: string }[];
}

export function orgTools(d: OrgToolDeps): Tool[] {
  const { obj, str, int, bool } = d;
  const refuse = (m: string) => d.refusal(m);
  /** Store and view refusals become the tool's own. */
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof ViewRefusal) throw refuse(err.message);
      const status = (err as { status?: unknown })?.status;
      if (typeof status === "number" && err instanceof Error) throw refuse(err.message);
      throw err;
    }
  };
  /** A route's answer or its own refusal sentence. */
  const ok = (r: Resp, what: string, want = 200): any => {
    if (r.status === want || (want === 200 && r.status === 201)) return r.json;
    throw refuse(typeof r.json?.error === "string" ? r.json.error : `${what} failed (HTTP ${r.status}).`);
  };
  /** Take a cap, run, and hand the cap back when the act fails: a refusal takes nothing. */
  async function counted<T>(kind: OrgLimitKind, run: () => Promise<T>): Promise<T> {
    const over = d.take(kind);
    if (over) throw refuse(over);
    try {
      return await run();
    } catch (err) {
      d.give(kind);
      throw err;
    }
  }
  /** Every target must be on the card whose click opened this turn. */
  function requireConfirm(t: Targets): void {
    const items = d.confirmed();
    const has = (kind: "session" | "person" | "project", orgId: string | null, id: string) =>
      !!items?.some((i) => i.kind === kind && i.id === id && (orgId === null || (i as { orgId?: string }).orgId === orgId));
    const missing: string[] = [];
    for (const p of t.projects ?? []) if (!has("project", p.orgId, p.id)) missing.push(`the project ${p.name} (${p.id})`);
    for (const p of t.people ?? []) if (!has("person", p.orgId, p.id)) missing.push(`${p.name} (${p.id})`);
    for (const s of t.sessions ?? []) if (!has("session", null, s)) missing.push(`the session ${s}`);
    if (!items || missing.length) {
      const all = [
        ...(t.projects ?? []).map((p) => `the project ${p.name} (${p.id})`),
        ...(t.people ?? []).map((p) => `${p.name} (${p.id})`),
        ...(t.sessions ?? []).map((s) => `the session ${s}`),
      ];
      throw refuse(confirmRefusal(all.join(", ")));
    }
  }
  /** The operator's act made through the Overseer, in the turn its confirm card started (the statecharts check the card). */
  const goBy = (): OperatorBy => {
    const items = d.confirmed();
    const overseerId = d.overseerId?.() ?? "";
    return { kind: "operator", via: "overseer", ...(overseerId ? { overseerId } : {}), ...(items ? { card: JSON.parse(cardHeader(items)) } : {}) };
  };
  const orgOf = (ref: unknown) => resolveOrg(ref);
  const base = (orgId: string) => `/api/orgs/${enc(orgId)}`;
  const projectBase = (orgId: string, projectId: string) => `${base(orgId)}/projects/${enc(projectId)}`;
  /** A person, or "operator" for the user themselves. */
  const target = (orgId: string, ref: unknown): { id: string; name: string } => {
    if (typeof ref === "string" && (ref.trim() === OPERATOR || ref.trim().toLowerCase() === "the user")) return { id: OPERATOR, name: displayName(orgId, OPERATOR) };
    const p = resolvePerson(orgId, ref);
    return { id: p.id, name: p.name };
  };
  const personOf = (orgId: string, p: { id: string; name: string }) => ({ orgId, id: p.id, name: p.name });
  const batonSession = (ref: unknown) => {
    const id = d.sessionRef(ref);
    if (!id) throw refuse("Name the gathering session by its id (sova_orgs {org} lists them).");
    return { id, ...batonOf(id) };
  };

  // ---- reads ---------------------------------------------------------------------------------------

  const orgsRead: Tool = {
    name: "sova_orgs",
    label: "Organizations",
    description:
      "This host's organizations (never a mesh peer's). With no org: one block per org (people, projects, open hand-offs, what waits on the user, last activity, the workspace repo, cost at API prices). With org (id or exact name): its projects, roster (never contact), owner, hand-off sessions, recent profile changes and workspace. about: true adds the org's About text and its history: context only, never copied into anything a person sees, a coding session's prompt or a message to a project overseer.",
    promptSnippet: "this host's organizations, or one in full (projects, roster, hand-offs); about: true for its About text",
    parameters: obj({ org: str("Organization id or exact name; omit for every org."), about: bool("With org: add its About text and history.") }),
    execute: d.read(async (p) =>
      guard(async () => {
        if (!p.org) return { content: text(await orgsList()), details: {} };
        const org = orgOf(p.org);
        return { content: text(await orgFull(org.id, p.about === true)), details: { org: org.id } };
      }),
    ),
  };

  const personRead: Tool = {
    name: "sova_org_person",
    label: "Roster person",
    description:
      "One person on an organization's roster, as their page shows them without contact: status, role, language, decision areas, skills, competence, voice, referral, roles, their sessions and how they relate to each, decisions, conflicts routed to them, their links on this host as states only, visits and profile history. Contact and links never reach you: ask the user for a contact, and the user sends every link.",
    promptSnippet: "one roster person's page (no contact, links as states only)",
    parameters: obj({ org: str("Organization id or exact name."), person: str("Person id or exact name.") }, ["org", "person"]),
    execute: d.read(async (p) =>
      guard(async () => {
        const org = orgOf(p.org);
        const person = resolvePerson(org.id, p.person);
        return { content: text(personView(org.id, person.id)), details: { org: org.id, person: person.id } };
      }),
    ),
  };

  // ---- sova_org_project: a read without op, an act with one ------------------------------------------

  const projectRead = d.read(async (p) =>
    guard(async () => {
      const org = orgOf(p.org);
      const project = resolveProject(org.id, p.project);
      return { content: text(await projectView(org.id, project.id, p.items === true)), details: { org: org.id, project: project.id } };
    }),
  );
  const projectAct = d.act("sova_org_project", async (p) =>
    guard(async () => {
      const org = orgOf(p.org);
      switch (p.op) {
        case "add": {
          const r = await counted("org", async () => ok(await d.call("POST", `${base(org.id)}/projects`, { name: p.name, root: p.root }), "Adding the project"));
          const made = (r as OrgDetail).projectList.find((x) => x.name === String(p.name ?? "").trim() && x.root === String(p.root ?? "").trim()) ?? (r as OrgDetail).projectList.at(-1);
          return { content: text(`Added the project ${made?.name} (${made?.id}) to ${org.name}, root ${made?.root}.`), details: { org: org.id, project: made?.id } };
        }
        case "edit": {
          const project = resolveProject(org.id, p.project);
          const body: Record<string, unknown> = {};
          if (p.name !== undefined) body.name = p.name;
          if (p.root !== undefined) body.root = p.root;
          if (p.owner_hidden !== undefined) body.ownerHidden = p.owner_hidden;
          if (p.stakeholder !== undefined) body.stakeholder = p.stakeholder === null || String(p.stakeholder).trim().toLowerCase() === "none" ? null : resolvePerson(org.id, p.stakeholder).id;
          if (!Object.keys(body).length) throw refuse("Nothing to change: give name, root, stakeholder or owner_hidden.");
          await counted("org", async () => ok(await d.call("PATCH", projectBase(org.id, project.id), body), "Changing the project"));
          const done = [
            ...(body.name !== undefined ? [`renamed to "${body.name}"`] : []),
            ...(body.root !== undefined ? [`root ${body.root}`] : []),
            ...(body.stakeholder !== undefined ? [body.stakeholder === null ? "no main stakeholder" : `main stakeholder ${resolvePerson(org.id, body.stakeholder).name}`] : []),
            ...(body.ownerHidden !== undefined ? [body.ownerHidden ? "hidden from the owner's page" : "shown on the owner's page"] : []),
          ];
          return { content: text(`${project.name}: ${done.join(", ")}.`), details: { org: org.id, project: project.id } };
        }
        case "archive": {
          const project = resolveProject(org.id, p.project);
          requireConfirm({ projects: [{ orgId: org.id, id: project.id, name: project.name }] });
          await counted("org", async () => ok(await d.call("POST", `${projectBase(org.id, project.id)}/archive`), "Archiving the project"));
          return { content: text(`${project.name} archived: it left the Projects lists and its overseer is paused. Nothing was deleted; unarchive brings it back.`), details: { org: org.id, project: project.id } };
        }
        case "unarchive": {
          const project = resolveProject(org.id, p.project);
          await counted("org", async () => ok(await d.call("POST", `${projectBase(org.id, project.id)}/unarchive`), "Unarchiving the project"));
          return { content: text(`${project.name} is back, as it was set.`), details: { org: org.id, project: project.id } };
        }
        default:
          throw refuse("op must be add, edit, archive or unarchive (leave op out to read the project).");
      }
    }),
  );
  const projectTool: Tool = {
    name: "sova_org_project",
    label: "Org project",
    description:
      "Without op: read one project of an organization and its project overseer (level chosen and in force, watching, models, coding mode, extra instructions, allowances, held items, last actions), its gathering sessions, decisions and open conflicts, spec status, coding sessions, ideas and to-dos (items: true lists the open to-dos and ideas with ids), the last owner update and its cost. With op (only in a turn the user started): add {name, root}; edit {project, name?, root?, stakeholder? (a person, or none), owner_hidden?}; archive {project} (only in the turn a confirm card's click opened, listing the project; refused while anything in it is open, naming what); unarchive {project}.",
    promptSnippet: "read a project and its overseer; or add, edit, archive, unarchive a project",
    parameters: obj(
      {
        op: str("Omit to read. add | edit | archive | unarchive", { enum: ["add", "edit", "archive", "unarchive"] }),
        org: str("Organization id or exact name."),
        project: str("Project id or exact name (read, edit, archive, unarchive)."),
        items: bool("Read: also list the open to-dos and ideas with their ids."),
        name: str("add, edit: the project's name."),
        root: str("add, edit: its folder, an absolute path on this host."),
        stakeholder: str("edit: the main stakeholder, a person's id or exact name, or none."),
        owner_hidden: bool("edit: hide the project from the owner's page (true) or show it (false)."),
      },
      ["org"],
    ),
    execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) =>
      params?.op === undefined || params?.op === null || params?.op === "" ? projectRead(toolCallId, params, signal, onUpdate, ctx) : projectAct(toolCallId, params, signal, onUpdate, ctx),
  };

  // ---- sova_org --------------------------------------------------------------------------------------

  const orgTool: Tool = {
    name: "sova_org",
    label: "Organization",
    description:
      "Change an organization (only in a turn the user started): create {name} (its workspace repo goes in the default folder), rename {org, name}, about {org, text} (the About text every project overseer of the org reads; blank removes it; at most 4,000 characters), revert_about {org, at} (the About history line's time, from sova_orgs {org, about: true}), commit {org} (Commit Now: commit the workspace repo, and push when it has a remote). Never attach, detach, or set a remote: those are the user's.",
    promptSnippet: "create or rename an org, write or revert its About text, commit its workspace",
    parameters: obj(
      {
        op: str("create | rename | about | revert_about | commit", { enum: ["create", "rename", "about", "revert_about", "commit"] }),
        org: str("Organization id or exact name (all but create)."),
        name: str("create, rename: the name."),
        text: str("about: the whole new About text."),
        at: str("revert_about: the history line's time."),
      },
      ["op"],
    ),
    execute: d.act("sova_org", async (p) =>
      guard(async () => {
        if (p.op === "create") {
          const r = (await counted("org", async () => ok(await d.call("POST", "/api/orgs", { name: p.name }), "Creating the organization"))) as OrgDetail;
          return { content: text(`Created the organization ${r.name} (${r.id}); its workspace repo is ${r.dir}.`), details: { org: r.id } };
        }
        const org = orgOf(p.org);
        switch (p.op) {
          case "rename": {
            const r = (await counted("org", async () => ok(await d.call("PATCH", base(org.id), { name: p.name }), "Renaming"))) as OrgDetail;
            return { content: text(`Renamed ${org.name} to ${r.name}.`), details: { org: org.id } };
          }
          case "about": {
            if (typeof p.text !== "string") throw refuse("text is required: the whole new About text (blank removes it).");
            await counted("org", async () => ok(await d.call("PATCH", base(org.id), { about: p.text }), "Saving the About text"));
            const n = p.text.trim().length;
            return { content: text(n ? `Saved ${org.name}'s About text (${n.toLocaleString("en-US")} characters); its project overseers read it at their next run.` : `Removed ${org.name}'s About text.`), details: { org: org.id, length: n } };
          }
          case "revert_about": {
            if (typeof p.at !== "string") throw refuse("at is required: the history line's time (sova_orgs {org, about: true}).");
            await counted("org", async () => ok(await d.call("POST", `${base(org.id)}/about/revert`, { at: p.at }), "Reverting the About text"));
            return { content: text(`Reverted ${org.name}'s About text to what it was before the change at ${p.at}.`), details: { org: org.id } };
          }
          case "commit": {
            const r = (await counted("org", async () => ok(await d.call("POST", `${base(org.id)}/commit`), "Commit Now"))) as OrgDetail;
            const c = r.commit;
            return {
              content: text(c?.committed ? `Committed ${org.name}'s workspace (${c.sha ?? "?"})${c.pushed ? " and pushed it" : ""}.` : c?.pushed ? `Nothing new to commit; pushed the commits the remote lacked.` : "Nothing new to commit."),
              details: { org: org.id },
            };
          }
          default:
            throw refuse("op must be create, rename, about, revert_about or commit.");
        }
      }),
    ),
  };

  // ---- sova_roster -------------------------------------------------------------------------------------

  const PERSON_FIELDS = ["name", "role", "decides", "skills", "language", "voice", "contact"] as const;
  const contactWord = (c: unknown) => (c && typeof c === "object" && Object.values(c).some((v) => typeof v === "string" && v.trim()) ? "contact set" : "contact cleared");
  const fieldsSaid = (body: Record<string, unknown>) => Object.keys(body).map((k) => (k === "contact" ? contactWord(body.contact) : k));
  const rosterTool: Tool = {
    name: "sova_roster",
    label: "Roster",
    description:
      "Change an organization's roster for the user (only in a turn the user started; recorded as theirs, via the Overseer): add {org, name, role?, decides?, skills?, language?, voice?, contact?} (an active person), edit {org, person, …the same fields} (never status), approve and decline {org, person} (a proposed person), leave {org, person} (status left: every link of theirs stops at once; only in the turn a confirm card's click opened, listing the person), revert {org, person, at} (a profile history line; one that would set left asks first, as leave). contact is write-only: take it only from the user's own words; the result never repeats it.",
    promptSnippet: "add, edit, approve, decline, leave or revert a roster person (contact write-only)",
    parameters: obj(
      {
        op: str("add | edit | approve | decline | leave | revert", { enum: ["add", "edit", "approve", "decline", "leave", "revert"] }),
        org: str("Organization id or exact name."),
        person: str("Person id or exact name (all but add)."),
        name: str("add, edit: full name."),
        role: str("add, edit: their role."),
        decides: { type: "array", items: { type: "string" }, description: "add, edit: the decision areas they decide (words, e.g. website)." },
        skills: { type: "array", items: { type: "string" }, description: "add, edit: skills." },
        language: str("add, edit: a BCP-47 tag such as es-CO."),
        voice: str("add, edit: how to talk to them, at most 300 characters."),
        contact: obj({ email: str("Email"), phone: str("Phone"), whatsapp: str("WhatsApp"), other: str('Any other channel ("Slack: @bob")') }),
        at: str("revert: the history line's time (sova_org_person)."),
      },
      ["op", "org"],
    ),
    execute: d.act("sova_roster", async (p) =>
      guard(async () => {
        const org = orgOf(p.org);
        const body: Record<string, unknown> = {};
        for (const k of PERSON_FIELDS) if (p[k] !== undefined) body[k] = p[k];
        switch (p.op) {
          case "add": {
            if (typeof p.name !== "string" || !p.name.trim()) throw refuse("name is required.");
            const r = (await counted("org", async () => ok(await d.call("POST", `${base(org.id)}/people`, body), "Adding the person"))) as OrgDetail;
            const made = r.roster.find((x) => x.name.toLowerCase() === p.name.trim().toLowerCase() && x.status !== "left") as Person | undefined;
            return { content: text(`Added ${made?.name ?? p.name} (${made?.id ?? "?"}) to ${org.name}'s roster, active: ${fieldsSaid(body).join(", ")}.`), details: { org: org.id, person: made?.id } };
          }
          case "edit": {
            const person = resolvePerson(org.id, p.person);
            if (!Object.keys(body).length) throw refuse(`Nothing to change: give ${PERSON_FIELDS.join(", ")}. Status changes only through approve, decline and leave.`);
            await counted("org", async () => ok(await d.call("PATCH", `${base(org.id)}/people/${enc(person.id)}`, body), "Changing the person"));
            return { content: text(`${person.name}: ${fieldsSaid(body).join(", ")} saved.`), details: { org: org.id, person: person.id } };
          }
          case "approve":
          case "decline": {
            const person = resolvePerson(org.id, p.person);
            await counted("org", async () => ok(await d.call("POST", `${base(org.id)}/people/${enc(person.id)}/${p.op}`), p.op === "approve" ? "Approving" : "Declining"));
            return { content: text(p.op === "approve" ? `${person.name} is approved: active on the roster.` : `${person.name} was declined (status left; the referral is kept).`), details: { org: org.id, person: person.id } };
          }
          case "leave": {
            const person = resolvePerson(org.id, p.person);
            requireConfirm({ people: [personOf(org.id, person)] });
            await counted("org", async () => ok(await d.call("PATCH", `${base(org.id)}/people/${enc(person.id)}`, { status: "left" }), "Marking them as left"));
            return { content: text(`${person.name} has left ${org.name}: every link of theirs stopped working.`), details: { org: org.id, person: person.id } };
          }
          case "revert": {
            const person = resolvePerson(org.id, p.person);
            if (typeof p.at !== "string") throw refuse("at is required: the history line's time (sova_org_person).");
            const line = readHistory(org.id, person.id).find((c) => c.at === p.at);
            if (line?.field === "status" && line.from === "left") requireConfirm({ people: [personOf(org.id, person)] });
            await counted("org", async () => ok(await d.call("POST", `${base(org.id)}/people/${enc(person.id)}/revert`, { at: p.at }), "Reverting"));
            return { content: text(`Reverted ${person.name}'s ${line?.field ?? "change"} at ${p.at}${line?.field === "contact" ? " (contact set back)" : ""}.`), details: { org: org.id, person: person.id } };
          }
          default:
            throw refuse("op must be add, edit, approve, decline, leave or revert.");
        }
      }),
    ),
  };

  // ---- sova_owner ----------------------------------------------------------------------------------------

  const ownerTool: Tool = {
    name: "sova_owner",
    label: "Owner",
    description:
      "Set an organization's owner for the user (only in a turn the user started): op set, person (an active roster person's id or exact name) or null for none. Changing it turns the previous owner's owner link off. You never make, show or turn off an owner link: the user does, on the People tab.",
    promptSnippet: "set or clear an organization's owner",
    parameters: obj({ op: str("set", { enum: ["set"] }), org: str("Organization id or exact name."), person: { type: ["string", "null"], description: "A person's id or exact name; null for none." } }, ["op", "org", "person"]),
    execute: d.act("sova_owner", async (p) =>
      guard(async () => {
        if (p.op !== "set") throw refuse("op must be set.");
        const org = orgOf(p.org);
        const person = p.person === null || String(p.person).trim().toLowerCase() === "none" ? null : resolvePerson(org.id, p.person);
        await counted("org", async () => ok(await d.call("PUT", `${base(org.id)}/owner`, { personId: person?.id ?? null }), "Setting the owner"));
        return { content: text(person ? `${person.name} is ${org.name}'s owner.` : `${org.name} has no owner now.`), details: { org: org.id, person: person?.id ?? null } };
      }),
    ),
  };

  // ---- sova_project_decisions ------------------------------------------------------------------------------

  const decisionsTool: Tool = {
    name: "sova_project_decisions",
    label: "Project decisions",
    description:
      "A project's decisions and spec, for the user (only in a turn the user started): reconcile (find conflicts and draft decisions), promote {ids} (drafted decisions into the project's spec; one outside its author's decision area is refused: only the user promotes one, by id on the project page), resolve {conflict, keep: a|b|both} or {conflict, statement}, route {conflict, to} (a person or operator), freeze {frozen}. One call counts as one organization write.",
    promptSnippet: "reconcile, promote, resolve, route or freeze a project's decisions",
    parameters: obj(
      {
        op: str("reconcile | promote | resolve | route | freeze", { enum: ["reconcile", "promote", "resolve", "route", "freeze"] }),
        org: str("Organization id or exact name."),
        project: str("Project id or exact name."),
        ids: { type: "array", items: { type: "string" }, description: "promote: decision ids (sova_org_project lists them)." },
        conflict: str("resolve, route: the conflict id (cf_…)."),
        keep: str("resolve: a | b | both", { enum: ["a", "b", "both"] }),
        statement: str("resolve: the decision, in words, that replaces both sides."),
        to: str("route: a person's id or exact name, or operator."),
        frozen: bool("freeze: true to freeze the spec, false to unfreeze."),
      },
      ["op", "org", "project"],
    ),
    execute: d.act("sova_project_decisions", async (p) =>
      guard(async () => {
        const org = orgOf(p.org);
        const project = resolveProject(org.id, p.project);
        const at = projectBase(org.id, project.id);
        switch (p.op) {
          case "reconcile": {
            const r = await counted("org", async () => ok(await d.call("POST", `${at}/reconcile`), "Reconciling"));
            const open = (r.conflicts ?? []).filter((c: { state: string }) => c.state === "open").length;
            return { content: text(`Reconciled ${project.name}: ${r.lastRun?.error ? `failed: ${r.lastRun.error}` : `${r.lastRun?.found ?? 0} new conflicts; ${open} open.`}`), details: { org: org.id, project: project.id } };
          }
          case "promote": {
            if (!Array.isArray(p.ids) || !p.ids.length) throw refuse("ids: name the drafted decisions to promote.");
            // Never an out-of-area decision: promoted as a batch, which refuses those (only the user's explicit promotion takes them).
            const r = await counted("org", async () => ok(await d.call("POST", `${at}/promote`, { ids: p.ids, bulk: true }), "Promoting"));
            const refused = (r.refused ?? []) as { id: string; reason: string }[];
            return {
              content: text(
                [`Promoted ${r.promoted?.length ?? 0} decision(s) into ${project.name}'s spec.`, ...refused.map((x) => `- ${x.id} not promoted: ${x.reason}.`), ...(r.commit && "sha" in r.commit ? [`Committed ${r.commit.sha} on ${r.commit.branch}.`] : [])].join("\n"),
              ),
              details: { org: org.id, project: project.id, promoted: r.promoted ?? [], refused: refused.map((x) => x.id) },
            };
          }
          case "resolve": {
            if (typeof p.conflict !== "string") throw refuse("conflict is required (cf_…).");
            const input = typeof p.statement === "string" && p.statement.trim() ? { statement: p.statement } : p.keep ? { keep: p.keep } : null;
            if (!input) throw refuse('Give keep ("a", "b" or "both") or a statement.');
            await counted("org", async () => ok(await d.call("POST", `${at}/conflicts/${enc(p.conflict)}/resolve`, input), "Resolving the conflict"));
            return { content: text(`Resolved ${p.conflict} in ${project.name}${"keep" in input ? ` (kept ${input.keep})` : " with your statement"}.`), details: { org: org.id, project: project.id } };
          }
          case "route": {
            if (typeof p.conflict !== "string") throw refuse("conflict is required (cf_…).");
            const to = target(org.id, p.to);
            await counted("org", async () => ok(await d.call("POST", `${at}/conflicts/${enc(p.conflict)}/route`, { to: to.id }), "Routing the conflict"));
            return { content: text(`Routed ${p.conflict} to ${to.id === OPERATOR ? "you" : to.name}.`), details: { org: org.id, project: project.id } };
          }
          case "freeze": {
            if (typeof p.frozen !== "boolean") throw refuse("frozen must be true or false.");
            await counted("org", async () => ok(await d.call("PATCH", `${at}/spec`, { frozen: p.frozen }), "Freezing the spec"));
            return { content: text(`${project.name}'s spec is ${p.frozen ? "frozen" : "no longer frozen"}.`), details: { org: org.id, project: project.id } };
          }
          default:
            throw refuse("op must be reconcile, promote, resolve, route or freeze.");
        }
      }),
    ),
  };

  // ---- sova_gather (§app.overseer/org-people-facing) ----------------------------------------------------------

  const gatherTool: Tool = {
    name: "sova_gather",
    label: "Gathering sessions",
    description:
      "Gathering sessions (hand-offs) with the people of an organization, for the user. start {org, project, to, public_title, question, goal, why, briefing?, model?, thinking?, messages_max?, abilities?}: to is a person, operator (the user), or a list of two or more people for an offer. offer {session, to, question?, briefing?}, handoff {session, to, question, briefing?}, take {session} (Take Back), close {session}, extend {session, by} (more messages), revoke_link {session, person?}, send_link {session, person?, note?} or {preview, person, note?} (sends the person their gathering link, or their own link to a public preview pv_…, with an optional short note, on WhatsApp; you never see the link or the number). " +
      "start, offer, handoff, take, close, revoke_link and send_link run only in the turn a confirm card's click opened, listing every person, project and session the call acts on; extend needs none. No link is ever shown to you: send_link hands it straight to the person, else the user sends it from Needs you. " +
      "public_title and question are shown to the person as written: plain, specific words for them, never an internal label, an id, a cost, the About text or a note about anyone; goal is what the session must find out, for its model only; why is for the user only.",
    promptSnippet: "start, offer, hand off, take back, close, extend or revoke a gathering session (people-facing: confirm first)",
    parameters: obj(
      {
        op: str("start | offer | handoff | take | close | extend | revoke_link | send_link", { enum: ["start", "offer", "handoff", "take", "close", "extend", "revoke_link", "send_link"] }),
        org: str("start: organization id or exact name."),
        project: str("start: project id or exact name."),
        session: str("All but start: the gathering session's id."),
        to: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "start: a person, operator, or 2+ people (an offer); offer: 2+ people; handoff: one person." },
        public_title: str("start: the session's title, shown to the person."),
        question: str("start, offer, handoff: what to ask them first, shown to them."),
        goal: str("start: what the session must find out (for its model)."),
        why: str("start (required): why you start it, one or two sentences for the user. Shown to the user only, never to the person or the session's model."),
        briefing: str("start, offer, handoff: context for the session's model."),
        model: str('start: model ref "provider/model" (default: the new-session default).'),
        thinking: str("start: thinking level."),
        messages_max: int("start: the session's message limit.", { minimum: 1 }),
        abilities: { ...ABILITIES_PARAM, description: `start: ${ABILITIES_PARAM.description}` },
        by: int("extend: how many more messages.", { minimum: 1 }),
        person: str("revoke_link: only this person's link (id or exact name); omit for the current hand-off's links. send_link: the person (id or exact name); omit for the holder; an open offer needs one invitee."),
        preview: str("send_link: a public preview link's id (pv_…) to send instead of a gathering link."),
        note: str("send_link: a short note for the person (at most 500 characters), shown as written."),
      },
      ["op"],
    ),
    execute: d.act("sova_gather", async (p) =>
      guard(async () => {
        switch (p.op) {
          case "start": {
            const org = orgOf(p.org);
            const project = resolveProject(org.id, p.project);
            const list = Array.isArray(p.to) ? p.to : [p.to];
            if (!list.length || list.some((x: unknown) => typeof x !== "string" || !x.trim())) throw refuse("to is a person, operator, or a list of two or more people.");
            const to = list.map((x: string) => target(org.id, x));
            if (to.length > 1 && to.some((x: { id: string }) => x.id === OPERATOR)) throw refuse("An offer goes to two or more people on the roster, never to operator.");
            const people = to.filter((x: { id: string }) => x.id !== OPERATOR);
            // Within the project's ceiling, as the project overseer's (§app.baton/abilities).
            const abilities = overseerAbilities(p.abilities, projectAbilities(org.id, project.id));
            if ("error" in abilities) throw refuse(abilities.error);
            requireConfirm({ projects: [{ orgId: org.id, id: project.id, name: project.name }], people: people.map((x: { id: string; name: string }) => personOf(org.id, x)) });
            const why = typeof p.why === "string" ? p.why.trim() : "";
            if (!why) throw refuse("Say why you start it (why): one or two sentences for the user, never shown to the person.");
            const made = await counted("gather", async () =>
              // In-process, never POST /api/baton: no link is minted, so no URL or token exists to leak (§app.overseer/org-people-facing).
              createBaton({
                orgId: org.id,
                projectId: project.id,
                to: to.length > 1 ? to.map((x: { id: string }) => x.id) : to[0]!.id,
                publicTitle: p.public_title,
                goal: p.goal,
                question: p.question,
                ...(typeof p.briefing === "string" ? { briefing: p.briefing } : {}),
                ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
                ...(typeof p.thinking === "string" && p.thinking ? { thinking: p.thinking } : {}),
                ...(p.messages_max !== undefined ? { messagesMax: p.messages_max } : {}),
                abilities,
              }, { by: goBy(), mintLink: false, startedVia: "overseer", why }),
            );
            attentionChanged();
            const title = cut(String(p.public_title ?? ""), 80);
            const note = people.length ? ` ${noLinkNote(people.map((x: { name: string }) => x.name))}` : " It waits on your reply.";
            return {
              content: text(`Started ${to.length > 1 ? "an offer" : "a gathering session"} [${title.replace(/[[\]]/g, "")}](sova://s/${made.sessionId}) in ${project.name}, to ${to.map((x: { name: string }) => x.name).join(", ")}.${note}`),
              details: { org: org.id, project: project.id, session: made.sessionId },
            };
          }
          case "offer":
          case "handoff": {
            const s = batonSession(p.session);
            const list = p.op === "offer" ? (Array.isArray(p.to) ? p.to : []) : [p.to];
            if (p.op === "offer" && list.length < 2) throw refuse("An offer goes to two or more people.");
            const to = list.map((x: unknown) => resolvePerson(s.orgId, x));
            requireConfirm({ sessions: [s.id], people: to.map((x: Person) => personOf(s.orgId, x)) });
            if (p.op === "offer") {
              await counted("gather", () => offerTo(s.id, to.map((x: Person) => x.id), typeof p.question === "string" ? p.question : "", typeof p.briefing === "string" ? p.briefing : "", { by: goBy(), mintLink: false }));
            } else {
              const person = to[0]!;
              const question = typeof p.question === "string" ? p.question.trim().slice(0, 1000) : "";
              if (!question) throw refuse("question is required: what to ask them, shown to them.");
              await counted("org", () => handoffTo(s.id, person.id, question, typeof p.briefing === "string" ? p.briefing.trim().slice(0, 4000) : "", goBy(), { mintLink: false }));
            }
            attentionChanged();
            const names = to.map((x: Person) => x.name);
            return { content: text(`${p.op === "offer" ? "Offered" : "Handed"} [${cut(s.row.publicTitle, 80)}](sova://s/${s.id}) to ${names.join(", ")}. ${noLinkNote(names)}`), details: { session: s.id } };
          }
          case "take":
          case "close": {
            const s = batonSession(p.session);
            requireConfirm({ sessions: [s.id] });
            await counted("org", async () => ok(await d.call("POST", `/api/baton/${enc(s.id)}/${p.op}`), p.op === "take" ? "Take Back" : "Closing"));
            return { content: text(p.op === "take" ? `You hold [${cut(s.row.publicTitle, 80)}](sova://s/${s.id}) now; it waits on your reply.` : `Closed [${cut(s.row.publicTitle, 80)}](sova://s/${s.id}); its wrap-up runs.`), details: { session: s.id } };
          }
          case "extend": {
            const s = batonSession(p.session);
            await counted("org", async () => ok(await d.call("POST", `/api/baton/${enc(s.id)}/extend`, { by: p.by }), "Extending"));
            return { content: text(`[${cut(s.row.publicTitle, 80)}](sova://s/${s.id}) may take ${p.by} more messages.`), details: { session: s.id } };
          }
          case "send_link": {
            // §app.outreach/decisions: behind the card; the result names the outcome, never the link or the number.
            const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined;
            if (typeof p.preview === "string" && p.preview.trim()) {
              // A public preview link of a project (pv_…): the person gets their own link to it.
              const { listPreviews } = await import("./preview-links");
              const pv = listPreviews().find((v) => v.id === (p.preview as string).trim());
              if (!pv) throw refuse("No such preview.");
              if (!p.person) throw refuse("person is required with preview.");
              const pvOrg = orgOfProject(pv.projectId);
              if (!pvOrg) throw refuse("That preview's project is in no organization here, so there is no roster to send it to.");
              const who = resolvePerson(pvOrg, p.person);
              requireConfirm({ people: [personOf(pvOrg, who)] });
              const r = await counted("org", async () =>
                ok(await d.call("POST", "/api/outreach/send", { orgId: pvOrg, projectId: pv.projectId, personId: who.id, link: { kind: "preview", preview: pv.id }, ...(note ? { note } : {}) }), "Sending the link"),
              );
              if (r?.outcome === "sent") return { content: text(`Sent ${who.name} the preview link on WhatsApp.`), details: { person: who.id } };
              throw refuse(`Not sent: ${typeof r?.why === "string" ? r.why : "the send failed."}`);
            }
            const s = batonSession(p.session);
            const person = p.person ? resolvePerson(s.orgId, p.person) : null;
            const who = person ?? (s.row.holder && s.row.holder !== OPERATOR ? resolvePerson(s.orgId, s.row.holder) : null);
            requireConfirm({ sessions: [s.id], ...(who ? { people: [personOf(s.orgId, who)] } : {}) });
            const r = await counted("org", async () => ok(await d.call("POST", `/api/baton/${enc(s.id)}/send-link`, { ...(who ? { person: who.id } : {}), ...(note ? { note } : {}) }), "Sending the link"));
            const name = typeof r?.name === "string" ? r.name : (who?.name ?? "They");
            if (r?.outcome === "sent") return { content: text(`Sent ${name} their link on WhatsApp.`), details: { session: s.id, ...(who ? { person: who.id } : {}) } };
            throw refuse(`Not sent: ${typeof r?.why === "string" ? r.why : "the send failed."} Needs you still asks the user to send ${name} their link.`);
          }
          case "revoke_link": {
            const s = batonSession(p.session);
            const person = p.person ? resolvePerson(s.orgId, p.person) : null;
            requireConfirm({ sessions: [s.id], ...(person ? { people: [personOf(s.orgId, person)] } : {}) });
            if (!person) {
              await counted("org", async () => ok(await d.call("POST", `/api/baton/${enc(s.id)}/revoke`), "Turning off the links"));
              return { content: text(`Turned off the current hand-off's links to [${cut(s.row.publicTitle, 80)}](sova://s/${s.id}).`), details: { session: s.id } };
            }
            const { personPage } = await import("./person-page");
            const live = personPage(s.orgId, person.id).links.filter((l) => l.sessionId === s.id && (l.state === "writes" || l.state === "reads"));
            if (!live.length) throw refuse(`${person.name} has no working link to that session.`);
            await counted("org", async () => {
              for (const l of live) ok(await d.call("POST", `${base(s.orgId)}/people/${enc(person.id)}/links/revoke`, { sessionId: s.id, n: l.n }), "Turning off the link");
            });
            return { content: text(`Turned off ${person.name}'s ${live.length === 1 ? "link" : `${live.length} links`} to [${cut(s.row.publicTitle, 80)}](sova://s/${s.id}).`), details: { session: s.id, person: person.id } };
          }
          default:
            throw refuse("op must be start, offer, handoff, take, close, extend, revoke_link or send_link.");
        }
      }),
    ),
  };

  // ---- sova_project_overseer (§app.overseer/org-project-overseers) ----------------------------------------------

  const SETTING_KEYS: Record<string, string> = {
    autonomy: "autonomy",
    model: "model",
    thinking: "thinking",
    coding_model: "codingModel",
    coding_thinking: "codingThinking",
    coding_mode: "codingMode",
    gathering_model: "gatheringModel",
    gathering_thinking: "gatheringThinking",
    watch: "watch",
    watch_gap_min: "watchGapMin",
    soon_look_sec: "soonLookSec",
    caps: "caps",
    extra_instructions: "extraSystemPrompt",
  };
  const poTool: Tool = {
    name: "sova_project_overseer",
    label: "Project overseer",
    description:
      "A project's overseer, for the user (only in a turn the user started). start (create it, as Start Overseer). settings {autonomy?, model?, thinking?, coding_model?, coding_thinking?, coding_mode?, gathering_model?, gathering_thinking?, watch?, watch_gap_min?, soon_look_sec?, caps?, extra_instructions?}: one change, refused whole as the page's is. run_now (Run Now). clear (a new conversation; only in the turn a confirm card's click opened, listing the project). " +
      "idea {action: add|edit, id?, title?, text?, status?} and todo {action: add|edit|tick|untick|remove, id?, text?, idea?}: the project's ideas and to-dos. " +
      "message {text}: send words into the overseer's conversation as the user (idle it starts a turn; mid-turn it waits as a follow-up); it counts as a prompt to another session. Never a /command, never the About text or a cost figure. " +
      "code {prompt?, title?, item?, model?, thinking?}: start a coding session as the project's (its own worktree, the project's coding mode), from an item (a td_ to-do or an § idea) or from prompt and title; it counts as a session created. Talk to a coding session with sova_send.",
    promptSnippet: "start, set up, run, clear, message or give ideas/to-dos to a project's overseer; start a coding session as the project's",
    parameters: obj(
      {
        op: str("start | settings | run_now | clear | idea | todo | message | code", { enum: ["start", "settings", "run_now", "clear", "idea", "todo", "message", "code"] }),
        org: str("Organization id or exact name."),
        project: str("Project id or exact name."),
        autonomy: str("settings: L0 | L1 | L2 | L3."),
        model: str('settings: its model "provider/model", or "" for the default; code: the coding session\'s model.'),
        thinking: str("settings: its thinking level; code: the coding session's."),
        coding_model: str("settings: coding sessions' model, or \"\" for its own."),
        coding_thinking: str("settings: coding sessions' thinking."),
        coding_mode: { type: ["object", "null"], description: 'settings: {mode: "normal"|"delegate", minorModes: [] | ["spec"]}, or null for Automatic.' },
        gathering_model: str("settings: gathering sessions' model, or \"\" for its own."),
        gathering_thinking: str("settings: gathering sessions' thinking."),
        watch: bool("settings: watch the project on its own."),
        watch_gap_min: int("settings: at most one look every this many minutes (1–1440).", { minimum: 1, maximum: 1440 }),
        soon_look_sec: { type: ["integer", "null"], description: "settings: a look this many seconds after something to see soon (30–3600), or null for Off." },
        caps: { type: "object", description: "settings: limits, e.g. {gatherPerTurn: 3, createPerDay: 4} (null: Unlimited)." },
        extra_instructions: str("settings: the extra instructions, added last to its prompt (at most 8,000 characters; blank removes them)."),
        action: str("idea: add | edit; todo: add | edit | tick | untick | remove"),
        id: str("idea: the § id (a new one for add). todo: the td_ id (all but add)."),
        title: str("idea: title. code: the coding session's title (with no item)."),
        text: str("idea: its text. todo: its text. message: the words to send."),
        status: str("idea edit: open | exploring | started | done | dropped"),
        idea: str("todo: the § id of an idea it belongs to."),
        prompt: str("code: the first prompt (default: the item's text)."),
        item: str("code: a to-do (td_…) or idea (§…) of the project to start from, and link it."),
      },
      ["op", "org", "project"],
    ),
    execute: d.act("sova_project_overseer", async (p) =>
      guard(async () => {
        const org = orgOf(p.org);
        const project = resolveProject(org.id, p.project);
        const at = `${projectBase(org.id, project.id)}/overseer`;
        const details = { org: org.id, project: project.id };
        switch (p.op) {
          case "start": {
            const r = await counted("org", async () => ok(await d.call("POST", at), "Starting the overseer"));
            return { content: text(`${project.name}'s overseer is ready: [${project.name} overseer](sova://s/${r.id}).`), details };
          }
          case "settings": {
            const body: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(SETTING_KEYS)) if (p[k] !== undefined) body[v] = p[k];
            if (!Object.keys(body).length) throw refuse(`Nothing to change: give ${Object.keys(SETTING_KEYS).join(", ")}.`);
            await counted("org", async () => ok(await d.call("PATCH", at, body), "Saving its settings"));
            const said = Object.keys(body).map((k) => (k === "extraSystemPrompt" ? (String(body[k]).trim() ? `extra instructions (${String(body[k]).trim().length} characters)` : "extra instructions removed") : k));
            return { content: text(`${project.name}'s overseer: ${said.join(", ")} saved.`), details };
          }
          case "run_now": {
            await counted("org", async () => ok(await d.call("POST", `${at}/run`), "Run Now"));
            return { content: text(`${project.name}'s overseer is looking now.`), details };
          }
          case "clear": {
            requireConfirm({ projects: [{ orgId: org.id, id: project.id, name: project.name }] });
            const r = await counted("org", async () => ok(await d.call("POST", `${at}/clear`), "Clearing"));
            return { content: text(`Cleared ${project.name}'s overseer: a new conversation [${project.name} overseer](sova://s/${r.id}); its settings, notes, ideas and to-dos stay.`), details };
          }
          case "idea": {
            if (p.action === "add") {
              if (typeof p.id !== "string" || !p.id.trim()) throw refuse("id is required: a new § id for the idea, e.g. §gap/invoice-export.");
              await counted("org", async () => ok(await d.call("POST", `${at}/ideas`, { id: p.id, title: p.title, text: p.text ?? "" }), "Adding the idea", 201));
              return { content: text(`Added ${p.id} to ${project.name}'s ideas: ${cut(String(p.title ?? ""), 120)}.`), details };
            }
            if (p.action === "edit") {
              if (typeof p.id !== "string") throw refuse("id is required (the idea's § id).");
              const patch: Record<string, unknown> = {};
              for (const k of ["title", "text", "status"]) if (typeof p[k] === "string") patch[k] = p[k];
              if (!Object.keys(patch).length) throw refuse("Nothing to change: give title, text or status.");
              await counted("org", async () => ok(await d.call("PATCH", `${at}/idea?id=${enc(p.id)}`, patch), "Changing the idea"));
              return { content: text(`${p.id} in ${project.name}: ${Object.keys(patch).join(", ")} saved.`), details };
            }
            throw refuse("idea action must be add or edit.");
          }
          case "todo": {
            switch (p.action) {
              case "add": {
                await counted("org", async () => ok(await d.call("POST", `${at}/todos`, { text: p.text, ...(p.idea ? { ideaId: p.idea } : {}) }), "Adding the to-do", 201));
                return { content: text(`Added a to-do for ${project.name}'s overseer: ${cut(String(p.text ?? ""), 200)}.`), details };
              }
              case "edit":
              case "tick":
              case "untick": {
                if (typeof p.id !== "string") throw refuse("id is required (td_…).");
                const patch = p.action === "edit" ? { ...(typeof p.text === "string" ? { text: p.text } : {}), ...(p.idea !== undefined ? { ideaId: p.idea || null } : {}) } : { done: p.action === "tick" };
                if (!Object.keys(patch).length) throw refuse("Nothing to change: give text or idea.");
                await counted("org", async () => ok(await d.call("PATCH", `${at}/todo?id=${enc(p.id)}`, patch), "Changing the to-do"));
                return { content: text(`${p.id} in ${project.name}: ${p.action === "edit" ? "saved" : p.action === "tick" ? "ticked" : "unticked"}.`), details };
              }
              case "remove": {
                if (typeof p.id !== "string") throw refuse("id is required (td_…).");
                await counted("org", async () => ok(await d.call("DELETE", `${at}/todo?id=${enc(p.id)}`), "Removing the to-do"));
                return { content: text(`Removed ${p.id} from ${project.name}'s to-dos.`), details };
              }
              default:
                throw refuse("todo action must be add, edit, tick, untick or remove.");
            }
          }
          case "message": {
            if (typeof p.text !== "string" || !p.text.trim()) throw refuse("text must not be blank.");
            // One prompt to another session, and a running slot, exactly as sova_send.
            const info = ok(await d.call("GET", at), "Reading the overseer");
            const slot = d.slot(typeof info?.path === "string" ? info.path : undefined);
            if ("refusal" in slot) throw refuse(slot.refusal);
            try {
              const r = await counted("prompt", async () => ok(await d.call("POST", `${at}/message`, { text: p.text }), "Sending"));
              d.started(r.path, true);
              const link = `[${project.name} overseer](sova://s/${r.sessionId})`;
              return {
                content: text(r.queued ? `Queued in ${link} behind its running turn, as a follow-up: it goes in when the turn ends. The user can remove it from that queue until then.` : `Sent to ${link}.`),
                details: { ...details, session: r.sessionId, queued: r.queued },
              };
            } finally {
              slot.release();
            }
          }
          case "code": {
            const item = typeof p.item === "string" && p.item.trim() ? p.item.trim() : "";
            if (!item && (typeof p.prompt !== "string" || !p.prompt.trim() || typeof p.title !== "string" || !p.title.trim())) throw refuse("Give an item (td_… or §…), or both prompt and title.");
            const slot = d.slot();
            if ("refusal" in slot) throw refuse(slot.refusal);
            try {
              const body = {
                ...(item ? (item.startsWith("td_") ? { todoId: item } : { ideaId: item }) : {}),
                ...(typeof p.prompt === "string" && p.prompt.trim() ? { prompt: p.prompt } : {}),
                ...(typeof p.title === "string" && p.title.trim() ? { title: p.title } : {}),
                ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
                ...(typeof p.thinking === "string" && p.thinking ? { thinking: p.thinking } : {}),
              };
              const r = await counted("create", async () => ok(await d.call("POST", `${at}/items/code`, body), "Starting the coding session", 201));
              d.started(r.path, !r.notPrompted);
              const title = cut(typeof p.title === "string" && p.title.trim() ? p.title : item || String(p.prompt ?? ""), 60);
              return {
                content: text(
                  `Started [${title.replace(/[[\]]/g, "")}](sova://s/${r.sessionId}) as ${project.name}'s coding session, ${r.worktree ? `on the branch ${r.worktree.branch} in ${r.worktree.path}` : `in the project root${r.note ? `: ${r.note}` : ""}`}.${r.notPrompted ? ` ${r.notPrompted}` : ""}`,
                ),
                details: { ...details, session: r.sessionId, path: r.path },
              };
            } finally {
              slot.release();
            }
          }
          default:
            throw refuse("op must be start, settings, run_now, clear, idea, todo, message or code.");
        }
      }),
    ),
  };

  return [orgsRead, projectTool, personRead, orgTool, rosterTool, ownerTool, decisionsTool, gatherTool, poTool];
}

/** A confirm card's person and project rows (§app.overseer/confirm): null when nothing on this host matches. */
export const orgConfirmLookup = {
  person(org: string, ref: string): Extract<SovaConfirmItem, { kind: "person" }> | null {
    try {
      const o = resolveOrg(org);
      const p = resolvePerson(o.id, ref);
      return { kind: "person", id: p.id, orgId: o.id, name: p.name, orgName: o.name, status: p.status };
    } catch {
      return null;
    }
  },
  project(org: string, ref: string): Extract<SovaConfirmItem, { kind: "project" }> | null {
    try {
      const o = resolveOrg(org);
      const p = resolveProject(o.id, ref);
      return { kind: "project", id: p.id, orgId: o.id, name: p.name, orgName: o.name };
    } catch {
      return null;
    }
  },
};
