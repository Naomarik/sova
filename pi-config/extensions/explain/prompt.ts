/**
 * The child's instructions: the audience/page rules adapted from the Claude Code
 * `/explain` command, plus this extension's store contract.
 *
 * Two deliberate differences from the Claude version: the page goes to a fixed
 * store path instead of a temp file or `--out`, and the child NEVER opens a
 * browser — the page is read in Sova (or by opening the file), and a detached
 * browser from a background worker is exactly the surprise this feature avoids.
 */
import type { KnownMeta } from "./store.ts";

export interface ChildPromptSpec extends KnownMeta {
	/** Store directory (`~/.pi/agent/explanations/<id>`). */
	dir: string;
	indexPath: string;
	metaPath: string;
	/** The child has web search/fetch tools. */
	webSearch: boolean;
	/** The child was started from a copy of the parent conversation. */
	forked: boolean;
}

const AUDIENCE = `## Who you're writing for

15 years of shipping software, no CS degree, and none of the gaps you'd assume
from that — knows systems, knows tradeoffs, has debugged worse than this.

So:

- **No academic register.** No "we formalize", no "consider a set S", no
  citations, no Greek unless the Greek *is* the thing (a \`λ\` in a lambda
  calculus explainer is fine; a \`θ\` standing in for "some number" is not).
- **No 101.** Don't explain what a hash map is, what a race condition is, what
  HTTP does. Assume anything a working dev picks up by osmosis.
- **Do explain the named theory.** The gap is vocabulary and formal names —
  amortized analysis, CRDTs, monads, consensus protocols, type theory. Explain
  those from mechanism, not from definition: what it *does*, why anyone built
  it, what breaks without it. Give the formal name once so it's searchable, then
  never hide behind it again.
- **Anchor in code and systems**, not in math. "It's a retry queue with a
  vector clock" beats "it is a partially ordered set".
- **Say the tradeoff.** Every technique costs something. Name it.

Length follows the topic. A narrow question gets a tight page; a broad one gets
a real walkthrough. Never pad to look thorough.`;

const STRUCTURE = `Build the page out of whichever of these actually carry weight for this topic:

- **A one-paragraph answer up top.** If the reader stops after this, they should
  still be right about the main thing.
- **Diagrams** — inline SVG, hand-authored. Draw the *mechanism*: what flows
  where, what happens in which order, what the states are. A box labeled
  "System" connected to a box labeled "Database" is decoration; delete it. Label
  the arrows.
- **Tables** for anything comparative: option vs option, before vs after, this
  API vs that one, cost vs benefit.
- **Code blocks** where code is the clearest sentence available. Real, runnable,
  commented sparsely.
- **A "why this exists" section** — the problem that forced the invention.
  Usually the part that makes it click.
- **A "when it bites you" section** — failure modes, gotchas, the thing people
  get wrong.

Skip any of these that would be filler. Six thin sections lose to three real
ones.`;

const STYLE = `## Page style

Write the HTML directly — full document, \`<!doctype html>\` through \`</html>\`,
one inline \`<style>\`.

- System font stack, ~17px body, \`max-width: 62rem\`, generously spaced.
- **Light and dark both**, over CSS variables driven by
  \`@media (prefers-color-scheme: dark)\` (see the theme rules below).
- Real typographic hierarchy — headings that are scannable, code in a mono
  stack with a tinted background, tables with quiet rules and no heavy borders.
- SVG must be theme-safe: use \`currentColor\` or CSS variables for strokes and
  fills, never hardcoded \`#000\`. Give every \`<svg>\` a \`viewBox\`,
  \`max-width: 100%\` and \`height: auto\`.
- Wide things (tables, diagrams, long code) scroll inside their own
  \`overflow-x: auto\` box; \`pre\` always has \`overflow-x: auto\`. The body never
  scrolls sideways.
- It is read on a phone as often as on a desktop: real margins, no fixed pixel
  widths, nothing that depends on hover.
- A short table of contents at the top if the page has more than ~4 sections.`;

/**
 * The byline stamped under the page title. Built from literals the parent knows,
 * so the child never guesses its own model id or the date. The date is formatted
 * in UTC, which keeps it stable wherever it is later read.
 */
export function bylineText(model: string, createdAt: string): string {
	const date = new Date(createdAt);
	const when = Number.isNaN(date.getTime())
		? createdAt
		: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
	return `Explained by ${model || "an unnamed model"} · ${when}`;
}

/** The hard part of the contract; repeated verbatim in the README. */
export function storeRules(spec: ChildPromptSpec): string {
	return `## Where the page goes (exact, non-negotiable)

Write exactly two files, both inside \`${spec.dir}\` (it already exists):

**1. \`${spec.indexPath}\`** — the page. One self-contained HTML file with
**zero external requests**: no CDN, no webfonts, no remote images, no analytics.
Everything inline. It must also:

- ship \`<meta name="viewport" content="width=device-width, initial-scale=1">\`
  and \`<meta name="color-scheme" content="dark light">\`, so an embedder that
  declares a colour scheme (Sova's gallery renders the page in an iframe) gets
  matching scrollbars and form controls without any script;
- default to \`prefers-color-scheme\` but honor a \`?theme=dark\` / \`?theme=light\`
  query parameter, applied by a small inline script in \`<head>\` **before first
  paint** (read \`location.search\`, set an attribute such as
  \`data-theme\` on \`<html>\`, and let your CSS variables key off it). No flash of
  the wrong theme, and no script that runs after the body renders;
- **work completely with scripts disabled.** That one theme script is the only
  script on the page, and it may only *override* colours: the page is also
  rendered in a thumbnail \`<iframe sandbox="">\` that runs no JavaScript at all,
  so \`@media (prefers-color-scheme: dark)\` must already produce a correct page
  on its own. Nothing — layout, diagrams, tables, disclosure of content —
  may depend on JavaScript running;
- inline every image: hand-authored \`<svg>\`, or a \`data:\` URI. No remote fonts,
  stylesheets, images or scripts, in any form;
- keep every \`<svg>\` on \`viewBox\` + \`max-width: 100%\` + \`height: auto\`, and every
  \`pre\` on \`overflow-x: auto\`;
- carry this byline **directly under the page's \`<h1>\`**, verbatim:

  \`\`\`text
  ${bylineText(spec.model, spec.createdAt)}
  \`\`\`

  Small, muted, part of the normal text flow right below the title — not a
  footer, not a floating badge, not the end of the page. Keep the title and this
  byline in the **first ~200px of the document**: no tall hero spacing, no cover
  block, no empty band above the \`<h1>\`. Who reads it: someone with the full
  page open, on a desktop or a phone. (The page is also previewed as a
  scaled-down thumbnail where no body text is legible at all — a top-anchored
  title block is the recognition cue there, which is why the spacing rule
  matters even though the byline itself will not be readable.) Theme-safe like
  everything else (a CSS variable or \`opacity\`, never a hardcoded grey).
  Stamp it exactly as given; do not reformat the date or rename the model.

**2. \`${spec.metaPath}\`** — exactly this JSON, with only \`summary\` written by you:

\`\`\`json
{
  "id": ${JSON.stringify(spec.id)},
  "topic": ${JSON.stringify(spec.topic)},
  "summary": "<one paragraph>",
  "parentSessionId": ${JSON.stringify(spec.parentSessionId)},
  "cwd": ${JSON.stringify(spec.cwd)},
  "createdAt": ${JSON.stringify(spec.createdAt)},
  "model": ${JSON.stringify(spec.model)}
}
\`\`\`

\`summary\` is **3–5 sentences: what the page covers and its sharpest takeaway** —
plain prose, no markdown, no bullets, no heading. It renders clamped to three
lines in the gallery card, so length past that is thrown away rather than read.
Say what the page actually concluded, including the parts that are uncertain. It
is what someone reads in a list to decide whether to open the page; do not sell
the page, describe it.

Copy the other six values through unchanged. **Write \`meta.json\` last**, only
after \`index.html\` is complete on disk — never the other way round. A
\`meta.json\` with no finished page next to it is treated as a failed run and
thrown away.`;
}

/** The whole child prompt: one message, sent as the worker's task. */
export function buildChildPrompt(spec: ChildPromptSpec): string {
	const research = spec.webSearch
		? `Research first if the topic needs it — read the code here (grep/find/read) when the question is about this
codebase, and search the web when it is about something external and you are not certain.`
		: `Research first if the topic needs it — read the code here (grep/find/read) when the question is about this
codebase. You have no web access, so for anything external write only what you actually know and mark the rest.`;
	return [
		`Explain this: **${spec.topic}**`,
		"",
		spec.forked
			? "You have this conversation's full history above. If the topic refers to something discussed here (a file, a bug, a design), explain *that*, not the generic version of it."
			: "You are starting fresh, with no prior conversation. Work from the topic and from the code in your working directory.",
		"",
		AUDIENCE,
		"",
		"## What to produce",
		"",
		research,
		`Don't guess at specifics; mark genuine uncertainty inline as *not sure — verify*.`,
		"",
		"Then write **one self-contained HTML file** as described below.",
		"",
		STRUCTURE,
		"",
		STYLE,
		"",
		storeRules(spec),
		"",
		"## Rules for this run",
		"",
		"- **Never open a browser** and never run an opener script (`open`, `xdg-open`, `open-html.sh`). The page is read in Sova; opening a window from a background worker is wrong here.",
		"- Write only inside the store directory above. Do not edit the repository, do not commit, do not touch anything else on disk.",
		"- The page is the deliverable. Your final message is one or two sentences: the file path and the shortest honest version of the answer. Do not re-explain in chat.",
	].join("\n");
}
