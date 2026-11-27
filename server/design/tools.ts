// The tools Sova serves for the Lookbook. The main chat's: `lookbook` (put up a Setup card, read the
// coordinator's card or one page, pass words on); its guide is vis's (`vis_guide {kind:"lookbook"}`). A design
// session's: `design_stream` (the page, whole, in parts or as edits), `design_page` (its draft read back) and
// `design_hand_in` (it is done: the page is checked here).
import type { HEntry, ToolResult, ToolSpec } from "../../shared/harness";
import { DESIGN_ASK_ABOVE, DESIGN_BATCH_MAX, DESIGN_TOOL, designDirectionLine, isDesignLabel, type DesignNote } from "../../shared/design";
import { coordinatorCard, skillsChanged, tellCoordinator } from "./coordinator";
import { createRun } from "./setup";
import { editSetup, leftOutWords, SetupRefused, setupSummary, type EditDeps, type SetupDelta } from "./setup-change";
import { ownImages } from "./asset-routes";
import { imagePlacesLine } from "./own-images";
import { chatHandle } from "../chat-handle";
import { sharedFolderOf } from "../../pi-config/extensions/sandbox/shared-folder.ts";
import { designSectionName } from "../../shared/design-models";
import type { DesignRun } from "../../shared/design";
import { assertTakesPages, DESIGN_HAND_IN_TOOL, draftNow, streamCalled, editBase, handIn, landingProblem, readingSkill, refusedPage, savePage, takeLook, type DesignParent } from "./batch";
import { listSkillFiles, readSkillFile, runSkills, SKILL_LIMITS, SkillReadRefused, skillNamesOf } from "./skills";
import { livePage, streamCallTurnedAway } from "./live";
import { lookAtDesign } from "./look";
import type { TourSize } from "../../shared/tour";
import { changeDesigns, designOf, pendingPage, readPage, viewOf } from "./store";
import { DESIGN_PAGE_END, DESIGN_PAGE_START } from "../../pi-config/extensions/mode/design-guide.ts";
import { applyEdits, type Edit } from "./edits";
import { pageSize, pickVersions, versionCount, versionHeading } from "./versions";
import { chatTmpDir, pagePathFor, type PageReader } from "./page-paths";
import { lookAtDesignPage, recheckViews, viewsLineFor } from "./views";

export { applyEdits };

export const DESIGN_STREAM_TOOL = "design_stream";
export { DESIGN_HAND_IN_TOOL };
export const DESIGN_PAGE_TOOL = "design_page";
export const DESIGN_LOOK_TOOL = "design_look";
/** The main chat's tools: active whenever vis is on, as the tour tools are. */
export const DESIGN_TOOLS: ReadonlySet<string> = new Set([DESIGN_TOOL]);

const say = (text: string, details: unknown = {}): ToolResult => ({ content: [{ type: "text", text }], details });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const list = (description: string) => ({ type: "array", items: { type: "string" }, description });

/** The main chat's Lookbook tool. Nothing they do starts a turn or writes to its context beyond their own results. */
export function mainDesignTools(parent: () => DesignParent, cwd: () => string): ToolSpec[] {
  return [
    {
      name: "lookbook",
      label: "lookbook",
      description: `The Lookbook: one page designed by several models side by side. op "start" puts a Lookbook Setup card in the chat (the user finishes it there, up to ${DESIGN_BATCH_MAX} designs), only when the user asked for a Lookbook. op "edit" changes the open Setup card when the user asks for a change after it is up: send only what they asked to change (it never opens a second card and never starts anything); until Start Creative Director anything on it, then until Start on the brief only designers, efforts, styles, layouts, Pair Up/Every Mix and skills (the request's words and images then go to the Creative Director with tell; a skills change Sova tells it itself, so never pass that on). After Start on the brief nothing on it changes, its skills included. It answers with what the card now holds and anything that couldn't change, and why. op "read" without label: while the newest card is still in Setup, what it holds; else the Creative Director's card (the coordinator) and each design's version count. With label, where a design's page is: its latest version, unless label names one ("A11"); several at once with commas ("A11, A16"). Each comes as a header naming the version returned, when it was made and the versions that exist, its size, its views (the screens the page names: tabs, other pages, menus, dialogs), and the path of its saved file; the page itself isn't in the reply, so read the file (with offset and limit, or grep it). op "look" returns one picture of one design: label (and version, or "A11"), view (one of its views by name; none: its first screen) and size ("desktop" or "phone"). op "tell" passes text word for word to the Creative Director. images: paths of pictures to add (a screenshot, a logo), each a PNG, JPEG, WebP or GIF up to 8 MB, from one of three places: directly in /tmp (yours, sandbox or not), Sova's attachments folder, or your own shared folder (any folder below it); a picture elsewhere is refused, so copy it into your shared folder first. On start and edit they join the run itself; on tell they go to the Creative Director. Call vis_guide with kind "lookbook" first.`,
      parameters: {
        type: "object",
        properties: {
          op: str("What to do.", { enum: ["start", "edit", "read", "look", "tell"] }),
          run: str("edit: the run whose card to change; none: this chat's newest."),
          brief: str("start: what to design, in the user's words. edit: the request's new words, whole (only before Start Creative Director)."),
          models: list("start: particular models the user named, as provider/modelId. edit: designers to add."),
          removeModels: list("edit: designers to take off, as provider/modelId or the name on the card."),
          modelGroups: list('start: whole groups the user named, one picker section each: "claude", "gpt", "glm" (Z.ai), "deepseek", "ollama-cloud" (Ollama Cloud) or "ollama" (Ollama on this computer only). edit: groups to add.'),
          removeModelGroups: list("edit: groups to take off."),
          efforts: { type: "object", additionalProperties: { type: "string" }, description: 'start or edit: the thinking level the user named per designer, by model ("anthropic/claude-opus-5-5": "high"); "all" for every ticked designer. Only levels they named; none: each designs at low.' },
          directions: list("start: style names the user named. edit: styles to tick."),
          removeDirections: list("edit: styles to untick."),
          layouts: list('start: layout names the user named ("a compact and a bento version"); none unless they named some. edit: layouts to tick.'),
          removeLayouts: list("edit: layouts to untick."),
          combine: str("edit: how styles and layouts mix: pair (Pair Up) or every (Every Mix).", { enum: ["pair", "every"] }),
          coordinator: str("start or edit: the model id for the Creative Director (the coordinator), only when the user named one. edit: only before Start Creative Director."),
          skills: list("start: design skills the user named for this Lookbook, each a skill's name (this project's skills are found by name) or a folder holding SKILL.md (an absolute or ~ path). None loads by itself: with none named, pass none. edit: skills to add, until Start on the brief; after Start Creative Director one not found is only named in the result."),
          removeSkills: list("edit: skills to take off, by name, until Start on the brief."),
          images: list("start, edit or tell: the paths of pictures to add (see the allowed places above)."),
          removeImages: list("edit: images to take off this run, by their names (img-1); they stay in the chat's images."),
          label: str('read: the page to locate: a design\'s label ("A") for its latest version, a label with a version number ("A11") for that version, or several separated by commas ("A11, A16"). You get each page\'s file path and size, not its text. look: one design\'s label ("A"), or with a version number ("A11").'),
          version: { type: "integer", description: "look: the version to picture, when label doesn't name one; none: the latest." },
          view: str("look: one of the page's views, by the name a read lists (\"Deploy\"); none: the screen it opens on."),
          size: str("look: the width to picture it at.", { enum: ["desktop", "phone"] }),
          text: str("tell: the words to pass on, exactly as the user said them."),
        },
        required: ["op"],
      },
      async execute(toolCallId, params: LookbookParams, _signal, _update, ctx) {
        const p = parent();
        const shared = sharedFolderFor(p.sessionId);
        const places = imagePlacesLine(shared);
        // A /tmp path is read where this chat's own tools wrote it: its sandbox's tmp when it has one.
        const pictures = { shared, chatTmp: await chatTmpDir(p.sessionId) };
        if (params?.op === "start") {
          const run = await createRun(p, cwd(), { ...params, skills: skillNamesOf(params.skills) });
          // The user's attached images join this run's own images: Setup shows them, and the Creative Director sees them first.
          const paths = pathsOf(params.images);
          // Never fails the call: the card is already up, and a retry would open a second one.
          let added: { names: string[]; refused: string[] } | null = null;
          let failed = "";
          if (paths.length) {
            try {
              added = await ownImages(p, paths, pictures);
              // On the run itself, so one the chat already had belongs to it too, and Setup has them from its first frame.
              if (added.names.length) changeDesigns(p.sessionId, (s) => void (s.runs.find((r) => r.id === run.id)!.images = added!.names));
            } catch (err) {
              failed = ` The card is up, but the attached images couldn't be added (${err instanceof Error ? err.message : String(err)}): ask the user to paste them into the Creative Director's box. Don't start another card.`;
            }
          }
          // Efforts the user named: through the same change every later edit makes.
          let effortNotes: string[] = [];
          const efforts = effortsOf(params.efforts);
          if (efforts) {
            try {
              effortNotes = editNotes((await editSetup(p.sessionId, run.id, { efforts }, editDeps(p, pictures, cwd()))).text);
            } catch (err) {
              effortNotes = [err instanceof Error ? err.message : String(err)];
            }
          }
          const picked = run.setup.models.filter((m) => m.design).length;
          const skills = run.skills?.length ? ` Design skills: ${run.skills.map((k) => k.name).join(", ")}.` : "";
          const missing = run.skillsMissing?.length ? ` Not found: ${run.skillsMissing.map((m) => m.asked).join(", ")}; the Creative Director asks the user about ${run.skillsMissing.length === 1 ? "it" : "them"} on the brief.` : "";
          const imagesLine = added ? (added.names.length ? ` Images: ${added.names.join(", ")} joined the run.` : "") + (added.refused.length ? ` ${added.refused.join(" ")} ${places}` : "") : "";
          const left = leftOutLine(run);
          const effortLine = effortNotes.length ? ` Effort not set: ${effortNotes.join(" ")}` : "";
          return say(`The Setup card is on screen (run ${run.id}${picked ? `, ${picked} models ticked` : ""}).${skills}${missing}${imagesLine}${effortLine}${left}${failed} The user finishes it there and starts the run; above ${DESIGN_ASK_ABOVE} designs Sova asks them first. If they ask you for a change while it is up, make it with op edit; otherwise nothing more is needed from you.`, { designCard: { runId: run.id } });
        }
        if (params?.op === "edit") {
          const delta = deltaOf(params);
          if (!Object.keys(delta).length) throw new Error("edit needs what to change: only what the user asked to change.");
          let out;
          try {
            out = await editSetup(p.sessionId, typeof params.run === "string" && params.run ? params.run : undefined, delta, editDeps(p, pictures, cwd()));
          } catch (err) {
            if (err instanceof SetupRefused) throw new Error(err.message);
            throw err;
          }
          const refusedImages = out.text.includes("wasn't added:") ? `\n\n${places}` : "";
          // Its result names the card, so the card moves down to this call, under the chat's change.
          return say(`${out.text}${refusedImages}`, { designCard: { runId: out.run.id } });
        }
        if (params?.op === "read") {
          if (params.label) return say(await readDesignPages(p.sessionId, params.label, ctx ? { sessionId: ctx.sessionId } : undefined, p));
          const newest = viewOf(p.sessionId).runs.at(-1);
          if (newest?.phase === "setup") return say(setupSummary(p.sessionId, newest));
          const card = coordinatorCard(p.sessionId);
          const lines = viewOf(p.sessionId).designs.map((d) => `${d.label} · ${designDirectionLine(d)} · ${d.model} · ${d.status}${d.removed ? " (removed)" : ""} · ${versionCount(d)}`);
          return say([card?.card || "The Creative Director has no card yet.", lines.length ? `Designs:\n${lines.join("\n")}` : ""].filter(Boolean).join("\n\n"));
        }
        if (params?.op === "look") return lookAtOne(p, params);
        if (params?.op === "tell") {
          const paths = pathsOf(params.images);
          if (!params.text?.trim() && !paths.length) throw new Error("tell needs the text to pass on, or images.");
          // By reference: the pictures go straight into the chat's set, and only their names reach anyone's memory.
          const added = paths.length ? await ownImages(p, paths, pictures) : { line: "", names: [], refused: [] };
          await tellCoordinator(p, [params.text?.trim(), added.line].filter(Boolean).join("\n\n"), `tell:${toolCallId}`, added.names);
          return say(added.line ? `Passed on. ${added.line}${added.refused.length ? `\n${places}` : ""}` : "Passed on.");
        }
        throw new Error('op must be "start", "edit", "read", "look" or "tell".');
      },
    },
  ];
}

type LookbookParams = { op?: string; run?: unknown; brief?: string; models?: string[]; removeModels?: unknown; modelGroups?: string[]; removeModelGroups?: unknown; efforts?: unknown; directions?: string[]; removeDirections?: unknown; layouts?: string[]; removeLayouts?: unknown; combine?: unknown; coordinator?: string; skills?: unknown; removeSkills?: unknown; images?: unknown; removeImages?: unknown; label?: string; version?: unknown; view?: unknown; size?: unknown; text?: string };

const pathsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : []);
const namesOf = (v: unknown): string[] | undefined => {
  const out = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim() && x.length <= 300).slice(0, 40) : [];
  return out.length ? out : undefined;
};
const effortsOf = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1].trim()).slice(0, 40));
  return Object.keys(out).length ? out : undefined;
};

/** The edit's delta from the call: only the fields it sent. */
function deltaOf(params: LookbookParams): SetupDelta & { images?: string[]; skills?: string[] } {
  const d: SetupDelta & { images?: string[]; skills?: string[] } = {};
  if (typeof params.brief === "string") d.brief = params.brief;
  const lists = { models: params.models, removeModels: params.removeModels, modelGroups: params.modelGroups, removeModelGroups: params.removeModelGroups, directions: params.directions, removeDirections: params.removeDirections, layouts: params.layouts, removeLayouts: params.removeLayouts, removeImages: params.removeImages, removeSkills: params.removeSkills } as const;
  for (const [k, v] of Object.entries(lists)) {
    const names = namesOf(v);
    if (names) (d as Record<string, unknown>)[k] = names;
  }
  const efforts = effortsOf(params.efforts);
  if (efforts) d.efforts = efforts;
  if (typeof params.coordinator === "string" && params.coordinator.trim()) d.coordinator = params.coordinator;
  if (params.combine === "pair" || params.combine === "every") d.combine = params.combine;
  const images = pathsOf(params.images);
  if (images.length) d.images = images;
  const skills = skillNamesOf(params.skills);
  if (skills.length) d.skills = skills;
  return d;
}

/** The chat's own shared folder: a third place its pictures are taken from. */
function sharedFolderFor(sessionId: string): string | undefined {
  try {
    return sharedFolderOf({ sessionId });
  } catch {
    return undefined;
  }
}

function editDeps(p: DesignParent, pictures: { shared?: string | undefined; chatTmp: string | null }, cwd: string): EditDeps {
  const chatModel = chatHandle(p.path)?.mirror.model?.ref;
  return {
    addImages: (paths) => ownImages(p, paths, pictures),
    findSkills: (names) => runSkills(cwd, names),
    runs: () => viewOf(p.sessionId).runs,
    skillsChanged: (runId, change) => skillsChanged(p, runId, change),
    ...(chatModel ? { chatModel } : {}),
  };
}

/** The lines of an edit's "Not changed" list. */
const editNotes = (text: string): string[] => {
  const at = text.indexOf("Not changed:\n");
  return at < 0 ? [] : text.slice(at + "Not changed:\n".length).split("\n").map((l) => l.replace(/^- /, "")).filter(Boolean);
};

/** What the card leaves out, for the chat to say if the user asks: providers that can't run, sections the user hid. */
function leftOutLine(run: DesignRun): string {
  const out = (run.leftOut ?? []).map((l) => `${l.name} isn't on the card: ${leftOutWords(l.why)}${l.models?.length ? ` (you asked for ${l.models.join(", ")})` : ""}.`);
  const hidden = run.hiddenSections?.length ? [`Hidden by the user: ${run.hiddenSections.map((s) => designSectionName(s)).join(", ")}${run.hiddenAsked?.length ? ` (you asked for ${run.hiddenAsked.join(", ")}; they can bring it back with Show)` : ""}.`] : [];
  const all = [...out, ...hidden];
  return all.length ? ` ${all.join(" ")}` : "";
}

/** The pages the main chat's read names (server/design/versions.ts): for each, a header saying which version it is and
    which exist, its size, and the path of its saved file, never the page itself, so it enters the chat's context only as
    far as the chat reads the file. The path is one `reader` can open, its sandbox included (server/design/page-paths.ts).
    Throws, naming what there is, for a design or version that isn't there. */
export async function readDesignPages(sessionId: string, asked: string, reader?: PageReader, parent?: DesignParent): Promise<string> {
  const blocks: string[] = [];
  for (const x of pickVersions(viewOf(sessionId).designs, asked)) {
    // Views no browser could check yet (their chat was closed): this read, made from the open chat, has them checked.
    if (parent) recheckViews(parent, x.d.label, x.v);
    const page = readPage(sessionId, x.d.label, x.v.n);
    if (page === null) throw new Error(`Design ${x.d.label}'s version ${x.v.n} couldn't be read.`);
    const at = await pagePathFor(sessionId, x.d.label, x.v.n, reader);
    const views = viewsLineFor(x.v, page);
    blocks.push(`${versionHeading(x)}\nSize: ${pageSize(page)}.${views ? `\n${views}` : ""}\nFile: ${at.path}${at.exposed ? " (a read-only copy where your sandbox can read it)" : ""}`);
  }
  return `${blocks.join("\n\n")}\n\nThe page isn't in this reply: read the file, in parts with offset and limit, or grep it for what you need.`;
}

/** The main chat's look: one picture of one version of one design, on its first screen or one of its views. */
async function lookAtOne(p: DesignParent, params: { label?: string; version?: unknown; view?: unknown; size?: unknown }): Promise<ToolResult> {
  if (!params.label?.trim()) throw new Error('look needs label: a design ("A"), or one of its versions ("A11").');
  if (params.size !== undefined && params.size !== "desktop" && params.size !== "phone") throw new Error('size is "desktop" or "phone".');
  if (params.view !== undefined && typeof params.view !== "string") throw new Error("view is a view's name, as a read lists it.");
  if (params.version !== undefined && !(Number.isInteger(params.version) && (params.version as number) > 0)) throw new Error("version is a version's number.");
  const picked = pickVersions(viewOf(p.sessionId).designs, params.label, params.version as number | undefined);
  if (picked.length > 1) throw new Error("look pictures one design at a time: name one label, such as A or A11.");
  const x = picked[0]!;
  recheckViews(p, x.d.label, x.v);
  const size: TourSize = params.size === "phone" ? "phone" : "desktop";
  const r = await lookAtDesignPage(p, x.d.label, { version: x.v.n, sizes: [size], ...(typeof params.view === "string" && params.view.trim() ? { view: params.view } : {}) });
  const views = viewsLineFor(x.v, readPage(p.sessionId, x.d.label, x.v.n));
  const text = [versionHeading(x), `${r.view ? `The view ${r.view}` : "The screen it opens on"}, at ${size} width.`, views].filter(Boolean).join("\n");
  return { content: [{ type: "text", text }, ...r.shots.map((s) => ({ type: "image" as const, data: Buffer.from(s.png).toString("base64"), mimeType: "image/png" }))], details: { label: x.d.label, version: x.v.n, ...(r.view ? { view: r.view } : {}), size } };
}

const noteOf = (v: unknown): DesignNote | null => {
  const n = v as Partial<Record<keyof DesignNote, unknown>> | null | undefined;
  const ok = (x: unknown): x is string => typeof x === "string" && !!x.trim();
  return n && ok(n.layout) && ok(n.sections) && ok(n.type) && ok(n.color) ? { layout: n.layout, sections: n.sections, type: n.type, color: n.color } : null;
};

/** The page as its session has it now, for it to look at: one saved and not yet handed in (a Refine checks its
    change before handing it in), or on the reply route one written in this turn's reply; else its newest version. */
export function pageNow(parent: DesignParent, label: string, ctx: { branch(): HEntry[] } | undefined): { html?: string } {
  const html = draftNow(parent.sessionId, label, ctx ? ctx.branch() : null);
  return html === null ? {} : { html };
}

/** A design session's tools, bound to the design it was started for. A model that can't stream tool arguments
    writes its page in its reply, which is how the user watches it being written: its `design_stream` takes only
    edits, a page sent whole or in parts that way would arrive only at the end. */
export function sessionDesignTools(parent: DesignParent, label: string): ToolSpec[] {
  const d = designOf(parent.sessionId, label);
  return [...allSessionTools(parent, label, d?.route === "reply"), ...(d?.skills?.length ? [skillTool(parent, label)] : [])];
}

/** The most lines one read-back of the draft returns, besides its byte cap (a skill read's). */
export const DESIGN_PAGE_READ_LINES = 2_000;

/** The draft, or part of it, with its line numbers: from line `from` (1-based), at most `lines` lines and at most a
    skill read's bytes. Says where it stopped, so the next read can go on from there. */
export function draftLines(html: string, from = 1, lines = DESIGN_PAGE_READ_LINES): string {
  const all = html.split("\n");
  const first = Math.max(1, Math.floor(from));
  if (first > all.length) return `The page has ${all.length} lines; there is no line ${first}.`;
  const want = Math.max(1, Math.min(Math.floor(lines), DESIGN_PAGE_READ_LINES));
  const out: string[] = [];
  let bytes = 0;
  let n = first;
  for (; n <= all.length && n < first + want; n++) {
    const line = `${n}\t${all[n - 1]}`;
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > SKILL_LIMITS.readBytes && out.length) break;
    out.push(line);
  }
  const last = n - 1;
  const more = last < all.length ? `\n(lines ${first}-${last} of ${all.length}; read on with from ${last + 1})` : "";
  return `${out.join("\n")}${more}`;
}

/** A design's skill reader: read only, inside the skill folders its own record names (never pi's file tools). */
function skillTool(parent: DesignParent, label: string): ToolSpec {
  return {
    name: "design_skill",
    label: "design skill",
    description: `Read one of your design skills, the house rules for this project's pages. skill alone lists its files; with file (a path inside the skill, such as SKILL.md) it returns that file's text. Text files only (md, css, html, json, svg, txt), up to ${SKILL_LIMITS.readBytes / 1000} KB a read.`,
    parameters: { type: "object", properties: { skill: str("The skill's name, as your first message lists it."), file: str("A file's path inside the skill; omit to list its files.") }, required: ["skill"], additionalProperties: false },
    async execute(_id, params: { skill?: string; file?: string }) {
      // Its roots from its own record at each call: what it may read never comes from the model.
      const roots = designOf(parent.sessionId, label)?.skills ?? [];
      const skill = typeof params?.skill === "string" ? params.skill : "";
      try {
        if (typeof params?.file === "string" && params.file.trim()) {
          const f = readSkillFile(roots, skill, params.file);
          readingSkill(parent, label);
          return say(f.text, { skill: f.skill, file: f.path });
        }
        const l = listSkillFiles(roots, skill);
        readingSkill(parent, label);
        const lines = l.files.map((f) => `${f.path} (${f.bytes} bytes${f.text ? "" : ", not text: can't be read"})`);
        return say([`The files of ${l.skill}:`, ...lines, ...(l.more ? ["(more files than are listed)"] : [])].join("\n"), { skill: l.skill });
      } catch (err) {
        if (err instanceof SkillReadRefused) throw new Error(err.message);
        throw err;
      }
    },
  };
}

/** What a design_stream call says back: what it kept, and once the draft is a whole document, what a hand-in would
    object to in it, as advice (nothing is spent: the hand-in checks). */
function savedText(sid: string, html: string, what: string, reply: boolean): string {
  const size = `${what} (${html.length} characters).`;
  if (!/<\/html>\s*$/i.test(html)) return reply ? `${size} It doesn't end with </html>, so it isn't a whole page yet.` : `${size} It isn't a whole page yet: go on with append, then call ${DESIGN_HAND_IN_TOOL} when it is complete.`;
  const problem = landingProblem(sid, html);
  if (problem) return `${size} Your page is whole, but ${DESIGN_HAND_IN_TOOL} would refuse it as it is: ${problem}\nFix that first, with edits or as suits you.`;
  return `${size} Your page is whole: call ${DESIGN_HAND_IN_TOOL} when you are done with it, then stop.`;
}

function allSessionTools(parent: DesignParent, label: string, reply = false): ToolSpec[] {
  const own = (asked: unknown): void => {
    if (asked !== label) throw new Error(`You are design ${label}; label must be ${label}.`);
    assertTakesPages(parent.sessionId, label);
  };
  return [
    {
      name: DESIGN_LOOK_TOOL,
      label: "design look",
      description: "Open your finished page in a real browser at a width and see it: 1440 for desktop, 390 for phone.",
      parameters: { type: "object", properties: { label: str("Your label."), width: { type: "number", description: "The viewport width: 1440 or 390." } }, required: ["label", "width"] },
      async execute(_id, params: { label?: string; width?: number }, _signal, _update, ctx) {
        own(params?.label);
        const size: TourSize = (params.width ?? 1440) < 768 ? "phone" : "desktop";
        takeLook(parent.sessionId, label);
        const d = designOf(parent.sessionId, label);
        const look = await lookAtDesign(parent, label, { sizes: [size], ...pageNow(parent, label, ctx) });
        const images = d?.vision ? look.shots.map((s) => ({ type: "image" as const, data: Buffer.from(s.png).toString("base64"), mimeType: "image/png" })) : [];
        return { content: [...images, { type: "text", text: d?.vision ? `Your page at ${size} width.` : `An outline of your page at ${size} width (this model can't read images):\n${look.outline}` }], details: {} };
      },
    },
    {
      name: DESIGN_STREAM_TOOL,
      label: "design stream",
      description: reply
        ? `Change your page with edits: a list of exact find-and-replace pairs, on the page your reply wrote between the marker lines (else your newest version). Your page itself is written in your reply, between the markers, never here.`
        : `Write your page in one go or in parts, whichever suits you; each call is one of these. html: the whole document, or its first part (from <!DOCTYPE html>); it starts your draft, or replaces it. append: text added to the end of your draft, to write the page in parts. edits: exact find-and-replace pairs on your draft (else on your newest version). Nothing is checked until ${DESIGN_HAND_IN_TOOL}; ${DESIGN_PAGE_TOOL} reads your draft back.`,
      parameters: {
        type: "object",
        properties: {
          label: str("Your label."),
          ...(reply ? {} : { html: str("The whole HTML document, or its first part: starts your draft, or replaces it."), append: str("Text added to the end of your draft: the page's next part.") }),
          edits: { type: "array", items: { type: "object", properties: { find: { type: "string" }, replace: { type: "string" } }, required: ["find", "replace"] }, description: reply ? "Find-and-replace pairs, each matching exactly once." : "Find-and-replace pairs on your draft, each matching exactly once, instead of html or append." },
        },
        required: reply ? ["label", "edits"] : ["label"],
      },
      async execute(_id, params: { label?: string; html?: unknown; append?: unknown; edits?: Edit[] }, _signal, _update, ctx) {
        own(params?.label);
        streamCalled(parent.sessionId, label);
        try {
          const sent = (["html", "append", "edits"] as const).filter((k) => params[k] !== undefined);
          if (reply && (params.html !== undefined || params.append !== undefined))
            throw new Error(`Your page is written in your reply, between the line ${DESIGN_PAGE_START} and the line ${DESIGN_PAGE_END}; design_stream takes only edits.`);
          if (sent.length !== 1) throw new Error(sent.length ? `Send one of html, append or edits per call, not ${sent.join(" and ")}.` : "Send html, append or edits.");
          let html: string;
          let what: string;
          if (params.html !== undefined) {
            if (typeof params.html !== "string" || !params.html.trim()) throw new Error("html is the page's text.");
            html = params.html;
            what = "Saved as your draft";
          } else if (params.append !== undefined) {
            if (typeof params.append !== "string" || !params.append) throw new Error("append is the text to add.");
            const draft = pendingPage(parent.sessionId, label);
            if (draft === null) throw new Error("You have no draft to add to yet: start the page with html (its first part, or all of it).");
            html = draft + params.append;
            what = "Added to your draft";
          } else {
            if (!Array.isArray(params.edits) || !params.edits.length) throw new Error("edits is a list of find-and-replace pairs.");
            const current = editBase(parent.sessionId, label, ctx ? ctx.branch() : null);
            if (current === null) throw new Error(reply ? "You have no page to edit yet: write it in your reply, between the marker lines." : "You have no page to edit yet; send html.");
            const out = applyEdits(current, params.edits);
            if ("error" in out) throw new Error(`${out.error} Nothing was changed.`);
            html = out.html;
            what = "Edits applied to your draft";
          }
          savePage(parent, label, html);
          return say(savedText(parent.sessionId, html, what, reply), { label, chars: html.length });
        } catch (err) {
          // Its page, if it streamed one whole, is no page a later part goes on from.
          streamCallTurnedAway(parent.sessionId, label);
          throw err;
        }
      },
    },
    {
      name: DESIGN_PAGE_TOOL,
      label: "design page",
      description: `Read your draft back, with line numbers: the page as you have it now (else your newest version). from: the first line (1 by default); lines: how many (at most ${DESIGN_PAGE_READ_LINES}).`,
      parameters: { type: "object", properties: { label: str("Your label."), from: { type: "integer", description: "The first line to read, from 1." }, lines: { type: "integer", description: "How many lines." } }, required: ["label"] },
      async execute(_id, params: { label?: string; from?: unknown; lines?: unknown }, _signal, _update, ctx) {
        own(params?.label);
        const draft = draftNow(parent.sessionId, label, ctx ? ctx.branch() : null);
        const html = draft ?? readPage(parent.sessionId, label);
        if (html === null) throw new Error(reply ? "You have no page yet: write it in your reply, between the marker lines." : "You have no draft yet: start it with design_stream html.");
        const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? v : dflt);
        const head = draft === null ? `You have no draft; this is your newest version (${html.length} characters).` : `Your draft (${html.length} characters):`;
        return say(`${head}\n${draftLines(html, num(params.from, 1), num(params.lines, DESIGN_PAGE_READ_LINES))}`, { label, chars: html.length });
      },
    },
    {
      name: "design_hand_in",
      label: "design hand in",
      description: "Finish your page. note says what you made, for the people choosing between designs. Your last tool call for this page.",
      parameters: {
        type: "object",
        properties: {
          label: str("Your label."),
          note: {
            type: "object",
            properties: { layout: { type: "string" }, sections: { type: "string" }, type: { type: "string", description: "The typography." }, color: { type: "string" } },
            required: ["layout", "sections", "type", "color"],
          },
        },
        required: ["label", "note"],
      },
      async execute(_id, params: { label?: string; note?: unknown }, _signal, _update, ctx) {
        own(params?.label);
        const note = noteOf(params.note);
        if (!note) throw new Error("note needs layout, sections, type and color.");
        // Its draft; on the reply route a page written between its markers in a reply of this turn since, not always this call's.
        let html = draftNow(parent.sessionId, label, ctx ? ctx.branch() : null);
        // On the reply route the page may stand only in what its reply streamed; on the tool route only the draft counts:
        // a live page there is a design_stream call that was turned away.
        if (html === null && reply) html = livePage(parent.sessionId, label)?.text ?? null;
        if (html === null) refusedPage(parent, label, "You have no page to hand in yet.");
        // The checks run here: a refused page stays the draft, so the fix can be a small edit.
        const problem = landingProblem(parent.sessionId, html);
        if (problem) refusedPage(parent, label, problem, html);
        const v = handIn(parent, label, html, note);
        return say(`Handed in as version ${v.n}. Stop now.`, { label, version: v.n });
      },
    },
  ];
}

/** The label a design worker's id names, when it is one. */
export const designLabelOf = (workerId: string | undefined): string | null => /^design-([A-Z]{1,4})$/.exec(workerId ?? "")?.[1] ?? null;
