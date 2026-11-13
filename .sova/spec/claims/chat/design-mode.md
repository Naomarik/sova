# §chat/design-mode — Lookbook
> Part of the Sova design spec · [overview](../design/overview.md)

A **Lookbook** is one page designed by several models side by side. It is part of vis: when you ask
for one, the main chat sends labelled one-page prototypes out to hidden design sessions on several
models, Sova draws each page live in the chat and in the session pane, and you refine a design, talk
to it, and make new designs from others through one Creative Director, the run's hidden lead session
(§chat.design-mode/creative-director). A run uses only the skills you name (§chat.design-mode/skills).

The chat holds one **Lookbook card** per run. The card goes through states, each in its title:
**Lookbook · Setup**, **Lookbook · Brief**, then the designs being made (**Lookbook · 6 designs**).
Each single page in it is a design, with a stable letter,
and each letter has its own hidden session on its own model. The pages never enter the main chat
unless it asks to read one.

Owns: how a Lookbook rides vis, when the main chat opens one, its guide, the Lookbook card and its
states, the model picker, design sessions, how a page streams and how its frame is sealed, the
Gallery's prototypes, labels, storage, the Creative Director, its name and its card, the skills a run
uses, how the main chat reads and
passes on, research, the brief and Start, links and images, the limits on a launch, what the Creative Director may do across projects and sites, Refine, and
new designs made from others.

Not here: the mode menu and the vis minor mode itself (§chat/mode-menu, §chat.markdown/visuals),
worker processes in general
(§app.chat-processes/workers), the session pane's tabs (§app.subagents-pane/tabs), the verbs and
their callers (§app.project-services/callers), tours' own recording (§app/tours). There is no Mix
tray and no Mix button, and pointing at a part of a page and sharing prototypes outside the chat are
later work.

## §chat.design-mode/turning-on — A Lookbook rides vis

A Lookbook is no mode of its own: it is an entry in the vis catalogue, tool-backed as tours are
(§app.tours/authoring), and the mode menu has no row for it (§chat/mode-menu). As the user decided,
it is there only with vis on.

- **Its tool comes with vis.** In a Sova chat with the vis minor mode on, the main chat has one
  Lookbook tool, `lookbook`, served by Sova itself, which runs the chat's modes
  (§chat.mode-menu/sova-runs-modes). It enters and leaves the chat's tools with vis, in the same one
  tool-set change as vis's other tools (§chat.mode-menu/minor-toggle-keeps-prompt), so a chat with
  vis on from its start sees no change in its tools when a Lookbook starts, and its cached prompt
  holds. align's Visuals alone never brings it, as it never brings the tour tools. With vis off a
  chat has no Lookbook: it turns vis on first.
- **One line in the catalogue.** vis's short entry point names the Lookbook in one line among its
  kinds, with when to use it (§chat.design-mode/asking); everything else about it loads only when the
  chat looks it up (§chat.design-mode/guide). Neither the tool nor the line adds anything to the
  system prompt beyond vis's own block.
- **Not for workers.** A chat's workers, design sessions and Creative Director take nothing of the chat's
  modes (§chat.mode-menu/workers), so none of them has a Lookbook. The Overseer has no minor modes,
  so it has none either.

## §chat.design-mode/asking — A Lookbook opens only when you ask for one

As the user decided, the main chat opens a Lookbook only when you ask for one: by its name, or in
words that plainly mean the same, naming several models ("have a few models each mock up this page"). The main chat judges
this itself, from what you wrote; Sova checks no word.

- **An ordinary ask gets a quick drawing.** Asking to sketch, mock up or wireframe something gets the
  quick vis drawing of §chat.markdown/visuals (a `vis html` or `vis wireframe`), never a Lookbook
  card. When such an ask is plainly about comparing several takes ("show me a few takes on the
  settings page to compare"), the chat gives the drawing and ends its reply with exactly "For several
  models' takes side by side, ask for a Lookbook."
- **The ask lasts until a card goes up.** Once you have asked, your follow-ups on the same request
  (answering the chat's question, adding a link or a model) still count, until the Lookbook card is
  up. A later request starts over.
- **Only your own words count.** A note, another chat's message, or a team member's or worker's
  message that names a Lookbook doesn't open one.
- **Reading and passing on need no ask.** Reading a design or the Creative Director's card and passing
  your words on (§chat.design-mode/main-chat) work whenever the chat has a Lookbook.

## §chat.design-mode/guide — The guide is the entry point

`vis_guide {kind: "lookbook"}` is how the main chat learns a Lookbook, loaded only when it looks it up
(§chat.markdown/visuals). It returns the Lookbook's core (when to open one, §chat.design-mode/asking,
and how to start, read and pass on), which names three parts, each returned alone by `vis_guide` with
its name: `lookbook-setup` (filling in the Setup card), `lookbook-directions` (the styles in their
families and the layouts) and
`lookbook-passing-on` (passing your words on). The parts are lookups, never catalogue kinds, as
tours' parts are, and there is no `vis lookbook` fence. The brief a design session works from comes
from these guide files, so the chat carries only vis's one catalogue line until it needs more.

The brief a design session gets:

- Makes a real, usable page and never a design-system swatch sheet, with real-sounding content and
  working interactions, and commits boldly to its one named style and, when it has one, its layout.
- Comes with the style's written definition, from a fixed list of 20 styles (Minimalist, Heritage,
  Immersive and the rest, §chat.design-mode/directions), and with a layout, that layout's definition
  (§chat.design-mode/layouts) and the rule that the layout decides the arrangement and the style the
  look.
- Carries the anti-pattern list, among them no generic fonts (Inter, Roboto, Arial, Space Grotesk)
  and no cliched purple gradients.
- When the run has skills, tells the designer to read first the parts the brief suggests, to read
  any other part it needs, and to copy the rules and tokens it uses into the page
  (§chat.design-mode/skills).
- Tells the designer to draw any imagery it isn't given (§chat.design-mode/page-images) in the page,
  since a prototype may load only Google Fonts
  (§chat.design-mode/prototype-frame).

The guide tells the main chat what a read costs (§chat.design-mode/main-chat).

## §chat.design-mode/setup-card — Setup comes first, on a card

A run starts on the Lookbook card's Setup state (**Lookbook · Setup**), never in the main chat's
head, and only when you asked for a Lookbook (§chat.design-mode/asking). As the user decided: "a
card pops up first, like an alignment card. If I say all Ollama models and all Claude models, I see
the card with all of them selected, and I can freely change it. I can also edit whatever the main
chat filled in, which keeps the main chat's context clean."

- **The main chat fills in what it was asked.** `lookbook {op:"start", brief?, models?, modelGroups?,
  directions?, layouts?, coordinator?}` (styles in `directions`, layouts you named in `layouts`, none
  unless you named some) creates the card and returns at once with the card's id and nothing
  else. A group such as `ollama-cloud` or `claude` is resolved by the server into one section of the
  model picker, and a model named by its bare id ticks exactly one model
  (§chat.design-mode/model-picker), so the main chat never reads a model list.
- **The user edits the rest by clicking.** The card holds **What Do You Want to Design**, the model
  picker (§chat.design-mode/model-picker), the direction picker's Style and Layout
  (§chat.design-mode/directions), and a line that counts the run from its plan
  (§chat.design-mode/pairing): "6 designs · 3 pairs · 2 models", "18 designs · 3 styles × 3 layouts · 2
  models", or with no layout "6 designs · 3 styles · 2 models". When the text holds a link, a small row chooses how it is
  used (§chat.design-mode/link-modes). The card shows the skills you named for the run, with nothing
  to set (§chat.design-mode/skills). The name Brief belongs only to the brief
  (§chat.design-mode/brief).
- **Clicks stay on the card.** No edit goes back into the transcript or wakes the main chat: each
  click is saved in the chat's design store (§chat.design-mode/storage), with nothing written to the
  chat's session per click, and a reload shows it as left. Start Creative Director records what was chosen
  (what you want, the designing models, the Creative Director, the styles and layouts and how they
  combine, and the skills it uses, §chat.design-mode/skills) in the session once.
- **Start Creative Director** hands the setup to the chat's hidden Creative Director
  (§chat.design-mode/coordinator). It is a click on the card, never a main-chat turn. It
  starts only the Creative Director's preparing: no design is written until Start on the brief
  (§chat.design-mode/brief-start). The limits on a run are §chat.design-mode/launch-limits.

## §chat.design-mode/model-picker — The model picker and its Creative Director dropdown

The Setup card has one picker for every choice of model: a Creative Director dropdown and a search box on
one row, then one section per provider. The Creative Director's model is chosen in the same picker and
stays separate from designing; as the user decided, "I can deselect that model as a designer and
still choose it explicitly as coordinator". One Creative Director dropdown holds that choice, instead of a
checkbox on every row.

- **One section per provider, all closed at first.** Each provider has its own section, and Ollama
  on this computer and Ollama Cloud are two separate sections. Every section starts closed, however
  many of its models the main chat ticked. Closed, a section is one row of fixed height: the
  provider's name, how many of its models are designing ("7 of 7"), the designing models on one line
  ("glm-5.3, glm-5.2, +5", or "None designing"), an **All** checkbox that switches Design on or off
  for every model in that section, and an arrow that opens it. Open, its models show directly below
  its row, in two columns where the card is wide enough and one on a phone; closing it takes them
  away again.
- **One control on each model's row.** A row holds the model, named as everywhere else, its "text
  only" mark where it applies, and its Design switch (any number of models may design).
- **Best first, and still while you tick.** Within each section the user's favorites come first,
  the same favorites as the composer's model menu (§chat.model-menu/favorites), never a second list.
  Then come the models in the order of a short ranked list Sova keeps for each provider, most
  capable first. A model that list doesn't know yet goes at the bottom of its section, newest
  version first. The order is set when the picker draws and never changes while the user ticks, so
  no row jumps.
- **The Creative Director dropdown.** Exactly one model is the Creative Director. A setup naming two is refused with "Only one model can be the Creative
  Director." The dropdown lists every model
  the picker offers, in the same sections and order, whether it is designing or not: choosing the
  Creative Director never ticks or unticks Design, and unticking Design never changes the Creative Director.
  The main chat's pick is filled in, and on a later run the line under it says what changing the
  Creative Director does (§chat.design-mode/coordinator).
- **Search.** Typing in the search box shows only the models that match, under their providers'
  names, in place of the sections. Clearing it brings the sections back, each open or closed as the
  user left it.
- **The main chat's groups are the sections.** A group the main chat names ticks one section, never
  two: `glm` and `zai` both tick Z.ai; `ollama-cloud` ticks only Ollama Cloud and `ollama` only Ollama
  on this computer, so asking for all the Ollama Cloud models never ticks a small local one. What the
  main chat filled in shows ticked when the card appears, and the user can change all of it.
- **A model's name ticks one model.** A name with its provider (`zai/glm-5.3-flash`) ticks exactly that
  model. A bare id that several providers offer (`glm-5.3-flash`) ticks one of them, never two: the one
  under a provider the same request names (another model given with its provider, or a group), else
  the one under the provider of the model the chat itself runs on, else the first in the picker's
  order. So a chat on Z.ai asking for `glm-5.3-flash` ticks Z.ai's and not Ollama Cloud's. The
  Creative Director's name resolves the same way.
- **What is offered.** Only models that can run, in the sections, the dropdown, search and the main
  chat's groups alike. A model barred for workers in Settings is never offered, and `claude-opus-5`
  is never offered. Ollama models Sova's Ollama Cloud check has found retired, which can only fail,
  are never offered (§app.model-levels/retired). A model the sign-in in use can't run, such as
  `gpt-5.3-codex-spark` on a ChatGPT sign-in, is either left off or says why it can't run.
- **What the picker marks.** A model that can't read images is marked "text only", because it gets a
  written outline where others get a screenshot (§chat.design-mode/refine).

## §chat.design-mode/directions — The direction picker: Style and Layout

A design's direction is its **style** (how the page looks) and, when it has one, its **layout** (how
the page is arranged). As the user decided, Setup offers both, with the styles shown in 5 families.

- **Two closed rows.** Under the Setup card's **Directions** heading sit two rows, **Style** and
  **Layout**, built like the model picker's provider rows (§chat.design-mode/model-picker): each is
  one row of fixed height naming what is ticked on one line and how many ("3 of 20", "3 of 12"), and
  opens in place below itself. Open, Style shows its 5 families, one line each, with its styles as
  small press-to-tick chips; Layout shows its 12 layouts as chips (§chat.design-mode/layouts).
- **The 20 styles in 5 families,** every name as before. **Quiet:** Minimalist, Clean & Modern,
  Balanced, Light & Airy, Subtle & Refined, Elegant. **Bold:** Bold & Vibrant, High Contrast, Dynamic &
  Energetic, Dark & Moody. **Expressive:** Playful, Warm & Inviting, Creative, Artistic. **Business:**
  Professional, Corporate, Technical. **Atmospheric:** Rich & Detailed, Heritage, Immersive. The
  families only group the list; they count for nothing.
- **How they combine.** A fixed one-line row below the two holds **Pair Up** / **Every Mix**, the pairs
  that will be made ("Minimalist + Compact · Bold & Vibrant + Bento · Balanced + Split Screen"), and
  **Shuffle**, which deals the pairs again without changing the count (§chat.design-mode/pairing).
  With no layout ticked it reads "No layout ticked: each designer arranges its own page."
- **What a new card starts with.** As the user decided, no layout is ticked on a new card: the Layout
  row reads **Designer's Choice**, and a run is made exactly as it would be with styles alone. Style
  starts as before, with the styles the main chat was asked for or a set of three. The main chat
  ticks any layouts you name in your request ("try a compact and a bento version") the same way it
  ticks styles (§chat.design-mode/setup-card).
- **Change on the brief** opens these same controls (§chat.design-mode/brief).

## §chat.design-mode/layouts — The 12 layouts

A layout says how a page is arranged. Each has one definition, which a design with that layout gets
word for word in its own standing instructions.

- **Compact:** dense and information-first: tight 4–12px gaps, a smaller type scale, no tall hero, as
  much legible content as fits on the first desktop screen, lists and tables over big cards.
- **Spacious:** generous room: 96px or more between sections, a narrow reading width, few items per
  row, one idea per screen height.
- **Single Column:** one centred column about 720px wide holds everything from top to bottom, with no
  sidebars or side-by-side grids at any width.
- **Split Screen:** two halves side by side on desktop, one staying put (headline, picture or form)
  while the other scrolls the content; on a phone they stack.
- **Sidebar Navigation:** a fixed left sidebar holds the navigation and the list of sections, and the
  content scrolls beside it; on a phone it becomes a menu button.
- **Card Grid:** a grid of equal cards, 3 or 4 across on desktop, each built the same way, with filters
  or tabs above it.
- **Bento:** an uneven grid of tiles in different sizes, one large and several small, fitting together
  into a rectangle, one idea per tile.
- **Dashboard:** an app screen, not a web page: a top bar, a side menu and a main area of panels,
  figures, charts and tables, all on one desktop screen without the page scrolling.
- **Magazine:** an editorial page: a lead story with a large picture, then columns of mixed widths
  holding stories of different sizes, pull quotes and lines between columns.
- **Long-Scroll Story:** one long page told in full-width chapters about a screen tall each, arranged
  differently from one to the next, with a clear story from top to bottom.
- **List and Detail:** a list of items on the left and the chosen item's full detail on the right, on
  one screen; choosing an item updates the detail in place, and on a phone the list opens the detail.
- **Tabbed Panels:** everything on one screen, the content split into tabs or steps that switch in
  place, so the page itself barely scrolls.

Compact and Spacious are about density and the other ten about structure; all twelve stay one list,
so a design has at most one of them. **The layout decides how the page is arranged; the style decides
how it looks** (colour, type, imagery, ornament and mood). Where a style's definition speaks of
arrangement (Professional's "structured grid layouts", Immersive's "sections staged like scenes"), a
design that has a layout follows its layout; one without a layout arranges its own page, as its style
suggests.

## §chat.design-mode/pairing — One style and one layout per design

Each design gets exactly one style and at most one layout. One rule turns the Setup card's models,
styles, layouts and combine choice into the list of designs, and the count line, the pairs line, the
estimate, the limits (§chat.design-mode/launch-limits) and Start all read that one list, so they never
disagree.

- **No layout ticked:** every model makes every ticked style, with no layout: models × styles, as
  before (2 models and 3 styles make 6).
- **Pair Up** (the default, as the user decided): each model makes as many designs as the longer of
  the two lists, styles or layouts, and the shorter list repeats; every model still gets every style
  ticked. 2 models, 3 styles and 3 layouts make 6.
- **The pairs shift per model,** as the user decided: the second model pairs each style with the next
  layout along, and so on, so 6 designs try 6 combinations. With Minimalist, Bold & Vibrant, Balanced
  and Compact, Bento, Split Screen, the first model makes Minimalist + Compact, Bold & Vibrant + Bento
  and Balanced + Split Screen, and the second Minimalist + Bento, Bold & Vibrant + Split Screen and
  Balanced + Compact.
- **Shuffle** deals the pairs again; the count stays, and the pairs the line shows are the ones that
  launch.
- **Every Mix:** every model makes every style in every layout: models × styles × layouts. 2 models, 3
  styles and 3 layouts make 18, so Start asks first.

## §chat.design-mode/launch-limits — How big a run may be, and when it launches

A run is as many designs as its plan makes (§chat.design-mode/pairing). As the user decided: "6 by
default, ask above 12, stop at 24".

- **Up to 12 designs** the run goes at Start, with no further question.
- **Above 12** the brief shows an estimate of what the run will spend and asks at Start, once, when the
  plan is known.
- **Above 24** the run can't start, and the card says why ("Choose fewer models, styles or
  layouts.").
- **The Creative Director can't widen it.** Start launches the run (§chat.design-mode/brief-start), and the
  server holds it to the models, styles, layouts and combine choice saved on the card and to these limits, whatever the
  Creative Director asks for.
- **Per launch.** The limits count each launch on its own: Start's batch, and the designs the
  Creative Director makes from others in one turn with `design_new`, which count together. Above 12 in one
  turn the Creative Director's card asks first ("Make more than 12 designs this turn?").
- **It counts designs, not money.** The limit is on how many designs a run makes, whatever each one
  costs, and each design's real spend shows on its tile (§chat.design-mode/card).

## §chat.design-mode/card — The Lookbook card

One Lookbook card per run, in the chat, moving down the chat as it updates and keeping its live
progress there, as one tour card does (§app.tours/one-card). It never joins a compressed group of
working rows, and "Hide tool calls" never hides it. It is the one card allowed to hold finished work
from other sessions, and the main chat itself never sees the pages.

The card's title names its state: **Lookbook · Setup**, **Lookbook · Brief**, then, once a run is
going, **Lookbook · {n} designs** ("Lookbook · 6 designs"). The pages inside stay designs, each
with its letter (A, B, A2; §chat.design-mode/labels).

Once a run is going, the card shows the run's title, its size, worded as Setup's count line
("6 designs · 3 pairs · 2 models", §chat.design-mode/setup-card),
a summary of its states ("2 ready · 1 writing · 3 queued"), one tile per design, and the Creative Director's
card (§chat.design-mode/coordinator-card).

Each tile holds the page as it is written (§chat.design-mode/streaming) and:

- its label, style and layout on one line ("A  Bold & Vibrant · Bento", the style alone with no
  layout; §chat.design-mode/labels) and its status: **Queued**, **Writing**,
  **Fixing** with its reason (§chat.design-mode/failed-designs), **Ready** or **Failed**;
- its model and what it cost, in tokens and in dollars from Sova's own price table, at API prices on
  a subscription too, so an Ollama design shows a cost; while a page is being written the tile shows a
  live estimate;
- **Open**, **Refine** and **Chat**. A design still being written has Open and Chat but no Refine;
  Open shows it full size as it is written (§chat.design-mode/chat-with).

Everything on the card survives a reload and a Sova restart.

## §chat.design-mode/design-sessions — Each label is a hidden session

Each design label gets one hidden design session on its model: a chat process Sova itself starts,
with no `agent_spawn` and no `agent_steer`. It has what a worker has (its own process, recovery
after a restart, the parent's sandbox, usage counted under the parent, provider limits, stopped when
the parent is archived; §app.chat-processes/workers), and two things a worker doesn't.

- **Their own pool.** As the user decided: "Their own pool". Design sessions take none of the chat's
  24 worker seats, working or idle, so a big batch never blocks coding workers. They aren't on the
  Agents tab or in `agent_list`; the Gallery is their home (§chat.design-mode/gallery).
- **They report nothing to the parent** (§chat.design-mode/main-chat).

A design session has only the tools that make its page: `design_stream {label, html}` (the whole
document, or a find-and-replace list so a refine doesn't rewrite the page; never offered to a model
that writes through its reply, §chat.design-mode/reply-route), `design_hand_in {label,
note}` and `design_look`, and Sova's read-only skill reader, which opens files only inside its run's
skill folders (§chat.design-mode/skills). It has no shell and none of pi's built-in file tools. It
never opens as an ordinary chat, and
the refusal for a worker's session (§app.chat-processes/workers) holds for it.

- **Queued.** A chat writes at most 6 designs at once, each label in one session only: a design whose
  session is still being started counts toward the 6 and is never started a second time. A provider's
  limit applies on top (§app/provider-limits). A design waiting for either reads Queued, and its tile
  says "Waiting for a free session".
- **Handing in.** A session finishes with `design_hand_in`. Its `note` is required and says, briefly,
  the page's layout, sections, type and colour; that note is what the Creative Director knows of the page.
- **Idle sessions go away and the pages don't.** An idle design session's process stops after the
  idle-stop time like any chat's (§app.chat-processes/idle-stop), so keeping designs for the life of
  a chat doesn't keep dozens of sessions running. The page stays, and the session starts again when
  it is next given something (§chat.design-mode/delivery).

## §chat.design-mode/streaming — The page grows in its tile

A page draws while it is being written, in the card and in the Gallery, from a narrow path of its
own: each design session sends only its page, in coalesced batches, and nothing else of a worker's
live typing leaves its process.

- **Nothing runs until it is finished.** While a page is being written, nothing in it runs. Its
  buttons and animations start working once it is finished.
- **One document, never reloaded.** While a design is being written its page is one document in one
  frame that fills in as it arrives and is never reloaded. The model still writes plain HTML; the
  filling in is Sova's.
- **Blank until its styles finish.** A page writes its styles first, and it stays blank until they
  have finished, roughly the first half of its characters. The tile shows progress until then: that
  it is writing and how far along it is, in tokens.
- **No limit on a page's size.** A design has no budget of its own, in characters or in tokens, and
  no token cap is asked of its model. The only stop is the general safety stop of about 1,000,000
  characters, the same whether the page comes through a tool call or through the reply. A page that
  comes out cut off or empty hasn't landed
  (§chat.design-mode/failed-designs).
- **A model that won't stream a tool's content** writes through its reply instead
  (§chat.design-mode/reply-route). A model that streams neither shows Writing with a token estimate,
  and its page draws when it arrives.
- **At most 4 live pages at once.** A browser tab holds at most 4 pages being written at a time, so a
  chat full of writing designs never stalls Sova's own requests. Any other writing tile reads "Waiting
  for a free preview", with how many tokens have been written. A design opened full size gets the
  next free place first, taking it from the tile that has held one longest, and a tile that no longer
  needs its place hands it on.
- **A reload picks up where it was.** Reopening a page being written shows it as far as it has got,
  then carries on.

## §chat.design-mode/reply-route — Models that stream through their reply

Ollama Cloud models deliver a tool's whole content in one piece at the end, after two to five
minutes, but they do stream ordinary reply text. As the user decided: "Stream them through their
reply". Their pages grow live like every other model's.

A design session on a model marked as not streaming tool content (today Ollama Cloud's and Google's)
writes its page between markers in
its reply, and that page reaches the tile the same way a tool's does. It still finishes with
`design_hand_in`. The reply text carrying the page is kept out of what's shown as its transcript.

Such a session is never offered `design_stream`, since a page sent that way would arrive whole at the
end, so every Refine or fix on it rewrites the whole page.

## §chat.design-mode/prototype-frame — How a page is sealed

A page is written by a model, so it is treated as hostile and walled off from Sova, your computer and
the network. As the user decided: "Google Fonts only".

- **While it is being written:** a frame with an empty sandbox that is also inert. No script in a
  half-written page runs, it can't redirect itself, and a click can't follow a link out of it.
- **When it is finished:** a Sova shell frame holding the page's frame, the two-frame `csp` wall of
  §chat.transcript-cards/sealed-box, so the page's own scripts and interactions run on an opaque
  origin of their own: no Sova cookies, storage, token or key, and no reach into the page around it.
- **It can't leave.** No navigation out of the frame (setting `location`, a meta refresh or a link),
  no top navigation, popups or form posts. A content-security header with `sandbox allow-scripts` is
  not enough on its own: measured, a page reached an outside server by setting `location` and by a
  meta refresh, so the shell's policy is what closes it.
- **The network is closed but for fonts.** Stylesheets and font files from Google Fonts load and
  nothing else does: no images, scripts, `fetch`, beacons or sockets from anywhere. Images in the
  page are `data:` or `blob:` images, and a page that relies on an outside one goes back to its session
  (§chat.design-mode/landing-checks).
- **WebRTC is gone** from the page's document before its code runs, because no content policy blocks
  it.
- **Browsers.** A finished page runs only in a browser that supports the frame's `csp` attribute. In
  any other it isn't run, and the place it would be says so.

**Drawn** means a finished page's fonts are in and its opening animations have run, so a page that
fades in never shows as blank; one that never says so counts as drawn shortly after it loads.

A tile draws a page scaled down from 1280 pixels wide, only near the viewport
(§chat.design-mode/steady-cards), and holds its
motion, which runs in the full-size view.

## §chat.design-mode/steady-cards — Cards hold still

A design's preview stays its page in a frame (§chat.design-mode/prototype-frame), and these frames
hold still.

- **One design's change touches one tile.** A finished design's page never reloads because another
  design changed; only the tile that changed updates.
- **Writing never reloads it.** While a design is being written its page fills in place in one frame
  and is never reloaded (§chat.design-mode/streaming), so once its styles have finished a tile never
  shows a blank moment. What has been written stays until the finished page has drawn.
- **Only what's near holds a page.** In a long chat, only tiles within about a screen of view hold a
  page. A tile scrolled away keeps its height.
- **No layout shift.** As the user decided: "no content layout shift at all whatsoever", across the
  whole Lookbook card and the Gallery, in any state, with the one exception below. A tile's box is its
  final size before anything loads, and a status, reason or button never moves what's around it.
- **Changing state moves nothing above it.** Going from Setup to the brief to Generating, and the
  brief's collapse, never move anything above the card.
- **The pickers grow only below the click.** Opening or closing a provider section
  (§chat.design-mode/model-picker), or the Style or Layout row (§chat.design-mode/directions), changes
  the card only below that row. Opening or closing a provider section is the one exception to no
  layout shift: it logs one layout-shift entry, and every source of that entry is below the clicked
  row, while the card's top and every row down to the clicked one stay where they were. Each of these
  rows keeps its height whatever it names, and so does the
  row of pairs, which stays one line with Shuffle in its place whether shown or not. Typing in or clearing the search box changes only what is
  below it, and the Creative Director dropdown opens over the card, pushing nothing.
- **Refine opens over the page.** Pressing Refine opens its box as an overlay, so nothing moves.
- **The open view holds still too.** Its status chip and version picker have fixed places, the picker
  there even with one version, so a new version arriving moves nothing beside it. Its message box is
  a fixed three lines tall and scrolls past that, instead of growing as the main composer's does.

## §chat.design-mode/failed-designs — When a design doesn't land

What happens depends on whether the model can do anything about it.

- **A reason the model can act on** (no page received, a page cut off or broken, or a failed check,
  §chat.design-mode/landing-checks), however the model ended its turn, is sent back to the design's
  own session by Sova itself, up to 2 times. The tile shows **Fixing** and the reason meanwhile.
- **A design tool's refusal spends a try too.** A page `design_stream` or `design_hand_in` turns away
  counts as one of the 2, so a session that keeps handing in a broken page ends in Failed and its turn
  stops.
- **Still not landed after those 2:** **Failed**, with the reason, and **Retry**.
- **Your word gives fresh tries.** A person's Retry, Refine or Chat gives the design 2 fresh tries.
- **A request that changed nothing says so.** A Refine that ends with no new version says so on the
  tile and in the open view's head ("That didn't change the page: {why}."). A question asked in Chat
  that needed no change doesn't.
- **A reason the model can't act on** (an unsupported model, a login, the provider down) goes straight
  to Failed, with the reason and Retry, and is never sent back.
- **Nobody else pays for it.** The Creative Director spends no turn on any of this: it gets quiet notes that
  start no turn. The main chat is not woken.

Retry starts that one design again under its label, and the rest of the run carries on.

## §chat.design-mode/landing-checks — What a page must pass before it counts as landed

Before a page counts as landed, Sova checks it mechanically:

- it is complete HTML with its tags closed;
- no inline script has a syntax error;
- it doesn't rely on outside content the frame blocks (§chat.design-mode/prototype-frame).

Real breakage goes back to the session as a precise list, on the same 2 tries as
§chat.design-mode/failed-designs. Style issues never do: no page is sent back for how it looks.

## §chat.design-mode/gallery — The Gallery tab

The session pane's Explain tab is now **Gallery** (§app.subagents-pane/tabs). It holds **Prototypes**
on top, then **Page Assets**, then **Explanations**: the same list of this session's /explain pages
the tab showed before.

Prototypes shows every design in the chat, from every run, with the same tiles, statuses and live
pages as the Lookbook card, and has **Open Creative Director** at its head. This is where design sessions
live, since they are not on the Agents tab. With none it reads "0 prototypes yet. They show up here
once you press Start on the brief.", or in a chat with vis off "0 designs in this chat. Turn on
vis and ask for a Lookbook to make some." The tab keeps its name, Gallery.

**Page Assets · {n}** shows every image the chat holds, captured or yours
(§chat.design-mode/asset-storage), to look through: one opens its details over the section without
moving it, and **Download** gives the original.

The Explanations page (`#/explanations`, §app.insights/explanations-page) is unchanged.

## §chat.design-mode/chat-with — Every design and the Creative Director have their own chat

Pressing **Open** on a design, or **Open Creative Director**, shows the page full size or the Creative Director's
work and the session's own chat: its messages, with a message box and **Send** ("Chat with A",
"Message A"; "Chat with the Creative Director", "It knows what each design is, not its code", "Message the
Creative Director"). **Chat** on a tile opens the same thing. Open works while a design is being written:
its page grows full size as it is written, and a Refine sent from here shows live in the same place,
the old version holding until the new one has text. This message box exists
for these two kinds of session only (§app.subagents-pane/transcript-view); what is sent goes the way
of §chat.design-mode/delivery.

Where this view sits is §chat.design-mode/chat-placement; how Back, Forward and the address follow it
is §chat.design-mode/open-history.

## §chat.design-mode/open-history — Back, Forward and the address follow what you opened

As the user decided, the open view (§chat.design-mode/chat-with) is part of the browser's history and
of the page's address.

- **Each open is one step.** Opening a design, its chat or the Creative Director, from the Lookbook card or
  the Gallery, adds one history step. So does opening a design from inside the Creative Director's view.
- **Back retraces what you opened.** Back goes to what was open before: from a design opened inside
  the Creative Director, Back returns to the Creative Director, then to the chat. **Forward** goes the other way,
  opening them again in order.
- **Closing leaves no stale step.** Closing the view with its close button or Esc puts you back where
  you were before you opened it, so Back afterwards never reopens what you closed.
- **The address says what is open.** The chat's address names the open design by its label or the
  Creative Director (`#/s/<path>?design=A`, `#/s/<path>?design=coordinator`), so a reload or a copied
  address reopens the same view over the same chat. An address naming a design the chat no longer
  has opens the chat alone.

## §chat.design-mode/chat-placement — Where Chat opens, for now

For now, the page and its chat sit **side by side**, and on a phone they stack. **Hide Chat** gives
the page the room, and **Show Chat** brings the chat back. The user has not
settled this. As the user decided: "Not sure, I need to see it once it's ready. Build your
recommendation (Beside the open design) for now, keep this as a revisit, and ask me about it once the
worktree link has something to show me."

This placement is the first build's and is open to change on the user's look at it. Whatever is
decided then replaces this paragraph; nothing else in this document depends on the view being side
by side, only on each design and the Creative Director having a chat of their own.

## §chat.design-mode/labels — Stable labels

Each design has a letter for as long as the chat has it: A, B and so on to Z, then AA. A chat has one
counter, shared by all its runs, and a letter is never reused, so "the header from A" means the same
thing to you, the Creative Director and the main chat whenever you say it.

A refined version keeps its letter with a number after it (A, then A2, A3). A design made from others
names its parents ("G, from A and C"). Its style and layout, model, status and cost go with its label
wherever it is drawn.

## §chat.design-mode/storage — Kept as long as the chat, and only inside it

As the user decided: "As long as the chat, only inside it". Designs follow the rule tours follow
(§app.tours/storage).

- **Stored by chat.** A chat's designs are kept on this computer in its design store, with every
  version, and survive a reload and a Sova restart. The card's state and Setup's edits are kept there
  too (§chat.design-mode/setup-card).
- **Images too.** A chat's images follow this rule (§chat.design-mode/asset-storage).
- **Archiving keeps them.** Only actual deletion of the chat removes them. Cleanup runs after a chat
  is confirmed gone, and uncertainty about whether it is gone never deletes anything.
- **Not outside the chat.** They aren't on share links, and no other chat reads them. A peer computer
  linked over the mesh doesn't get them for now.

## §chat.design-mode/coordinator — One Creative Director per chat, on metadata only

Each chat has one hidden Creative Director session, started when Start Creative Director is pressed. It runs on
the model chosen in the Setup card's Creative Director dropdown (§chat.design-mode/model-picker) and
prepares the brief
(§chat.design-mode/brief); Start launches the team, not the Creative Director. As the user decided: "The coordinator should not know every single token every
design has, only the data about them. That makes running out of room a non-issue. Giving it all the
HTML they generate would be the issue."

- **What it knows.** Each design's label, style, layout, model, parents, status and the note from
  `design_hand_in` (whose layout line shows whether the layout was followed), and nothing of the
  page's code. Its first message names the run's styles, layouts, Pair Up or Every Mix, and how many
  designs that makes. It reads these with `design_status`, and each
  hand-in reaches it as a note that doesn't start a turn. Of a page's captured images and of your
  other images it holds the descriptions, never the images (§chat.design-mode/describers). A
  screenshot you paste it sees itself when its model can read pictures
  (§chat.design-mode/own-images).
- **What it can do.** Write the brief's summary, Full Prompt and questions with `design_brief`
  (§chat.design-mode/brief-layers, §chat.design-mode/brief-questions), and there each screenshot's
  kind, its Rebuild This Screen or Just Its Feel choice and its words for designers
  (§chat.design-mode/own-images), start a new design
  (§chat.design-mode/new-from-parents), send a design a message with `design_send {label, text}`,
  rewrite its own card with `coordinator_card`, and look at a design or a screen with `design_browse`,
  which returns a screenshot on demand. It reads files as an ordinary chat does, with pi's built-in
  read tool, anywhere on this computer, so you can say "the logo is in my Downloads folder"; it never
  writes, edits or runs a shell. A file it reads that the designers need, such as a logo image,
  reaches them as one of the Lookbook's images (§chat.design-mode/own-images), and the pages stay
  sealed (§chat.design-mode/prototype-frame). Nothing loads for it by itself: no list of skills
  and no `AGENTS.md` or `CLAUDE.md`. It reads the skills you named, chooses which the designers get,
  and suggests what each designer reads first (§chat.design-mode/skills).
- **Whose words are whose.** What you write reaches it under a label Sova writes ("The user wrote in
  your box", or the main chat passing on your words), byte for byte as typed, between marks drawn for
  that one message that the text doesn't contain, so nothing in it can close its fence. Everything a model or a page
  wrote (a design's note or failure, a page's look, an image's description) reaches it fenced as
  data, never as instructions and never as yours, so a note can't pass for your words.
- **A later run's choice of model.** A chat has one Creative Director, on the model the newest run's Setup
  chose. When a later run chooses a different one, a new session on that model takes over, carrying
  only the old one's card and Sova's notes since its last turn, and the old session ends; Setup says
  so before Start Creative Director. The same model keeps the same session.
- **What it costs.** A few hundred tokens per design, not the page.
- **It reports nothing to the main chat** (§chat.design-mode/main-chat). It is a worker of Sova's in
  everything else: §app.chat-processes/workers, and §chat.design-mode/delivery for how it is reached.

## §chat.design-mode/coordinator-card — The Creative Director's card

The Creative Director has a card that follows the conversation, like an alignment card: what it has
concluded and made so far, with a box to prompt it further ("Message the Creative Director", **Send**), and its state ("Tracking 6 designs") and **Open Chat**. Each update
replaces what the card said before. It lives in the Lookbook card and in the Creative Director's own view.

**While the brief is open** only its status, any yes-or-no question and its message box show, so the
two don't repeat each other. After Start, it reads as above. Its box also takes pasted images
(§chat.design-mode/own-images).

**Start is heard before the card changes.** At Start, Sova replaces the card with its own line naming
the designs that started ("The designs started from the brief: A, B."). A card the Creative Director writes
from a turn that hasn't yet heard of the Start is refused, with the news of the Start and which designs
started, so Sova's line stays while the designs run. Once refused it counts as told: its next card
stands, and its next turn isn't told of the Start again.

There is no Mix button: you tell the Creative Director what you want. A message sent here is delivered as
§chat.design-mode/delivery says, and stays out of the main chat.

## §chat.design-mode/skills — A run uses only the skills you name

As the user decided: "for these particular sessions, we do not want to AUTOLOAD _ANY_ skills or
context. we must be explicit about it. that includes the coordinator." Skills reach a Lookbook only
when you name them, with no new control on Setup.

- **Nothing loads by itself.** The Creative Director and the designers load no skills and no project
  context by themselves: no list of skills, no `AGENTS.md` or `CLAUDE.md`, this project's own skills
  included. The Creative Director keeps its read tool (§chat.design-mode/coordinator).
- **Only what you name.** A run's skills are the ones you named in your own words for it: by name
  ("use this project's design skill", "the brand skill"), found among the project's own skills first,
  or by a skill folder's path on this computer. A folder you name counts only if it holds a `SKILL.md`. Name none and the run has none.
- **Never a guess.** A skill you name that can't be found becomes one of the Creative Director's
  questions on the brief (§chat.design-mode/brief-questions) instead of a guess.
- **The Creative Director chooses for the designers.** It reads the skills you named and picks in the
  brief which of them the designers get: all of them unless it leaves one out, and it leaves out a
  skill that isn't about design (such as a testing or browser skill). It suggests in the brief which
  sections each designer should read first. It never restricts them within a skill: a designer may
  read any part of the skills it gets.
- **Shown, never set.** The Setup card shows the skills you named for the run on one line ("Design
  skills: none" when you named none), with any not found (§chat.design-mode/setup-card), and, when you named any, the brief has a **Design skills: …** line
  naming the ones the designers get (§chat.design-mode/brief). Neither has a control for them.
- **Designers read through Sova.** A design session reads a skill with a read-only skill reader Sova
  serves, which opens files only inside the skill folders the Creative Director chose for them, and only
  text files (Markdown, CSS, HTML, JSON, SVG, plain text) up to a size limit. It
  resolves each file's real path, so a link, a `..` or an absolute path that lands outside them is
  refused. Designers still have no shell and none of pi's built-in file tools
  (§chat.design-mode/design-sessions). They copy the rules and tokens they need into the page, since
  the page stays sealed and loads only Google Fonts (§chat.design-mode/prototype-frame). While a
  designer reads a skill before its page starts, its tile says **Reading the design skill**.
- **Each run keeps its own.** A run's skills are stored on the run, and none carries over from an
  earlier run. A Creative Director reused across runs follows the newest run's skills, and a design
  revived after a restart keeps its run's skills.

## §chat.design-mode/creative-director — It is called the Creative Director

As the user decided, the run's lead session is the **Creative Director** everywhere a person or a
model reads its name: Setup (its dropdown and **Start Creative Director**), the brief, the Lookbook
card, the Gallery (**Open Creative Director**), the opened view, the images panel, the command list's
labels (§chat.design-mode/commands), the docs page (§site.docs/design), its own card's text, the main
chat's wording, and the text the Creative Director itself and the designers are given. No visible
"coordinator" is left in the Lookbook.

- **Hidden names stay.** The session's kind and worker id (`design-coordinator`), routes, command ids,
  the `lookbook` tool's `coordinator` parameter and `?design=coordinator` addresses
  (§chat.design-mode/open-history) keep their names and keep working. This document's § ids keep
  theirs too.
- **The old word still works.** The main chat still understands you when you say "coordinator".

## §chat.design-mode/main-chat — The main chat reads when asked

The main chat stays out of the way so its context stays clean for feature work. As the user decided
on what it does as designs land: "No note, it reads when asked".

- **Nothing is pushed into it.** No design finishing, no refine, no message and no Creative Director turn
  sends the main chat a note or wakes it, one design at a time or as a batch.
- **It reads on demand.** `lookbook {op:"read", label?}` returns the Creative Director's current card, or one
  design's page by label, and costs only what it reads. A page is typically 5,000 to 25,000 tokens
  depending on the model, long pages much more, and the guide says so. It knows each design by one
  line, "A · Bold & Vibrant · Bento · {model} · {status}" (the style alone with no layout).
- **It passes things on word for word.** If you tell the main chat "tell B to go darker", it uses
  `lookbook {op:"tell", text}`, which forwards your words to the Creative Director and returns only an
  acknowledgement. An image attached to your message goes with it by reference
  (§chat.design-mode/own-images).
- **A screenshot you ask with goes in at the start.** A screenshot attached to the message in which
  you ask for a Lookbook is handed to the Lookbook when it starts: the Setup card shows it, and the
  Creative Director sees it on its first turn (§chat.design-mode/own-images).

## §chat.design-mode/research — The Creative Director looks first, and the screen goes in the brief

Before the brief opens, the Creative Director can research: see what's running across your projects
(§chat.design-mode/project-reach), start a copy or open an address you give it
(§chat.design-mode/sites), walk to the right screen in a real browser, and take screenshots. It clicks
to navigate and submits nothing but a sign-in.

There is no separate confirm step: the brief is where you see the screen.

- **With a screen,** its picture appears in the brief with **Not This Screen**, which opens the box to
  redirect the Creative Director ("Or tell it which screen or address to use"). **Start** is what says this
  is the right screen (§chat.design-mode/brief-start).
- **With nothing to look at,** the brief opens all the same (§chat.design-mode/brief).

## §chat.design-mode/rebuilds — Rebuilding a screen that exists

When a run redesigns a screen that exists (one the Creative Director found, a link used as a reference, or
a screenshot you pasted set to Rebuild This Screen, §chat.design-mode/own-images),
what each design keeps depends on its layout. As the user decided, a ticked layout rearranges the
screen.

- **With no layout,** the designer keeps the screen's structure (its navigation, content areas,
  sidebars and footers in similar places) and changes how it looks.
- **With a layout,** the designer keeps the screen's content and purpose and arranges them as the
  layout says (§chat.design-mode/layouts), so you see your own screen as a Dashboard, a Split Screen
  and so on.

On Use Its Images, a design model that can't read images gets a written outline of the page instead
of the screenshot (§chat.design-mode/link-modes). Of a pasted screenshot, a design model that can't
read images gets the screenshot's words and no picture (§chat.design-mode/brief-start).

## §chat.design-mode/brief — Every run gets a brief

As the user decided: "Every run gets the brief, including a brand-new idea with no link." Every run
goes the same way: Setup, then Start Creative Director, then the Creative Director prepares, then the brief
opens on the same Lookbook card (**Lookbook · Brief**), then you press Start, and the brief collapses as the designs appear.

- **What the brief holds.** The summary and, folded under it, the Full Prompt
  (§chat.design-mode/brief-layers). Around them: the screen found, when there is one
  (§chat.design-mode/research); how each link is used (§chat.design-mode/link-modes); the images
  designers will use or the look in words (§chat.design-mode/brief-images); the Creative Director's open
  questions (§chat.design-mode/brief-questions); and a line saying how many designs on which models,
  styles and layouts, with an estimate; and, when you named skills, a **Design skills: …** line
  naming the ones the designers get (§chat.design-mode/skills).
- **Change.** On that line, **Change** reopens the Setup card's model picker and direction picker
  (§chat.design-mode/directions), so a
  different plan doesn't mean starting again.
- **After Start.** The brief collapses to one line above the designs, naming how many images it used.
  Expanding it shows what the designs were started from, read only, the Full Prompt included.
- **A newer brief replaces an unstarted one.** A run whose brief a newer run's replaced reads Stopped,
  with the reason ("A newer run's brief replaced this one, so it wasn't started. Use the newer
  card."), and has no Start.
- **It moves nothing.** The brief's collapse never moves anything above the card
  (§chat.design-mode/steady-cards).

## §chat.design-mode/brief-layers — Summary and Full Prompt

The brief has two layers. The **summary** is short enough to read in under a minute: what will be
built, for whom, what it must contain and what is left out. The **Full Prompt** is the much larger
text the Creative Director generates, section by section, and it is what the design sessions actually get.
It names no style and no arrangement, since each design adds its own style and layout: it describes
what the page contains (its sections as content, what each is for), never how they are laid out or in
what columns. One text serves the whole batch, so designs differ by style, layout and model and not
by content. As the user decided: "The Full Prompt can
be read and edited, folded under the summary."

The Creative Director writes the summary and its questions first, and the Full Prompt once the questions
are answered.

You change the brief either way: press **Edit Summary** or **Edit Prompt** to type into that layer,
or tell the Creative Director in the box below it.

- **Edit the summary** and the Creative Director rewrites the Full Prompt to match.
- **Edit the Full Prompt** and your words launch as you left them, while the Creative Director only brings
  the summary in line.
- **Yours stays yours.** The Creative Director can't overwrite what you saved, and your unsaved typing is
  never replaced.
- **Keep My Prompt or Rewrite It.** If you've saved your own Full Prompt and something later would
  change it (you edit the summary, tell the Creative Director something, or answer a question), the brief
  asks **Keep My Prompt** or **Rewrite It**, and Start waits until you pick, so the summary and the
  prompt can never quietly disagree.

## §chat.design-mode/brief-questions — The Creative Director's questions, and your answers

The Creative Director can put questions in the brief, especially when your request is ambiguous, each with
options and a recommendation, looking like an alignment card's. It asks at most a few, only ones that
change what gets built, and never about style, which your styles already cover, nor about
arrangement when layouts are ticked.

**Go With Recommendations** accepts all of them in one click. Or pick for each and press **Send
Answers**. Your answers go straight to the Creative Director and never pass through the main chat.

## §chat.design-mode/brief-start — Start, and what holds it back

**Start** is the only thing that launches a run. No model writes a design before Start, whatever it's
told in the box.

- **What blocks it.** Start is disabled while any question is open, while the Full Prompt is being
  written, while a link's images are still being captured or described, while a screenshot's words
  for designers are still being drafted, while a screenshot has neither Rebuild This Screen nor Just
  Its Feel ("Choose Rebuild or Just Its Feel", §chat.design-mode/own-images), and while the brief waits
  for Keep My Prompt or Rewrite It (§chat.design-mode/brief-layers), and its label says why ("Answer 1
  Question First", "Writing the Full Prompt", "The Creative Director Hasn't Written the Prompt", "Reading the page's images", "Describing the
  images"). A run past the limit can't start either (§chat.design-mode/launch-limits).
- **A stopped Creative Director.** If the Creative Director has stopped, a Full Prompt you wrote or kept can still
  start.
- **It launches with your click.** Start uses exactly the version on the card, with no extra
  Creative Director turn. This is the only spending question, asked once when the plan is known
  (§chat.design-mode/launch-limits).
- **What each design session gets.** As its first message, the Full Prompt word for word, then either
  the kept images' descriptions and short names, added by Sova, or the look in words. A screenshot is
  never among the images a page may show. When screenshots are in use, a **Reference screenshots**
  block follows, with each one's words for designers (its feel and its colours as hex values with
  their roles), fenced as content, in every design's message, whether its model reads pictures or
  not. A designer that gets no picture is never pointed at one it doesn't have, and is told to keep
  the screenshot's real titles, figures and sample data. Its style and
  layout stay in that session's own standing instructions, never in the Full Prompt, so one shared prompt becomes as many different
  designs as were asked for.
- **The screen's picture.** On Use Its Images it also goes to designers that can read images. On Just
  Its Feel it doesn't, so they can't copy the layout.
- **A screenshot's picture.** A designer that can read pictures also gets the picture of each Rebuild
  This Screen screenshot attached to its first message, with no tool to fetch it. A Just Its Feel
  screenshot and an unticked one reach no designer as a picture, and an unticked one not as words
  either. A design gets at most 4 reference pictures: each ticked Rebuild This Screen screenshot
  keeps one of the 4, the found screen's shots fill the rest and come first in order, and a Rebuild
  screenshot past the cap is named in every designer's message as coming in words only. A design
  revived after a restart keeps what it was given.
- **Nothing about a screenshot is cut.** What the Creative Director and the designers receive about a
  pasted screenshot (its feel, its colours' roles, its description) reaches them whole, never
  shortened.
- **Frozen.** The brief is frozen at Start. Later changes go through Refine or the Creative Director, and
  the next run gets a new brief.

## §chat.design-mode/link-modes — No link, Use Its Images, Just Its Feel, or Not a Reference

A link is optional, and each link is used one of three ways.

- **No link.** Designers draw every picture.
- **Use Its Images.** Its images are captured and described (§chat.design-mode/capture,
  §chat.design-mode/describers), shown on the brief, and designers use the ones you keep. Using the
  screen as a reference with every image unticked is this mode too.
- **Just Its Feel.** The page is looked at, no images are downloaded or handed over, and designers get
  a description of the look in words. As the user decided: "On Just Its Feel, the link's look leads
  over a design's direction." Each design's direction still shapes how it interprets that look.
- **Not a Reference.** A link that is part of what's being designed, such as where a button goes, is
  never opened, captured or described. The Creative Director can set it so when your words only point at
  the address.

As the user decided: "Use Its Images vs Just Its Feel is chosen on Setup and on the brief." A small
row appears on Setup when your text holds a link, with all three choices; you can still switch on the
brief or tell the Creative Director, and a click of yours beats the Creative Director's choice. Changing a link's
use on the brief tells the Creative Director, which rewrites the Full Prompt, and Start waits for it. If you say nothing, the Creative Director
goes by your words and asks on the brief when it can't tell. A screenshot you paste has a choice of
its own of the same kind, Rebuild This Screen or Just Its Feel (§chat.design-mode/own-images).

**The look in words.** On Just Its Feel, one quick look by a model that can read pictures describes
the page's colors, type and imagery in words, whichever model is the Creative Director. If none of your
models can read pictures, the brief says the look couldn't be read rather than making one up.

## §chat.design-mode/own-images — Your own images

As the user decided: "i can also paste in my own images too - whatever i want. this would prob be
trivial the way sova works, can be simply passed to coordinator if it was done in main chat - and/or
can do it in Creative Director myself".

Paste any image into the Creative Director's box, or into the main chat, which passes it to the Creative Director
without keeping it in mind beyond that. A screenshot attached in the main chat when you ask for the
Lookbook goes in with its start, so Setup already shows it and the Creative Director sees it on its
first turn (§chat.design-mode/main-chat). Your images join the brief's image grid alongside anything
captured, are described the same way (§chat.design-mode/describers), and are kept or dropped the same
way. A run can use your images with no link at all. An image file you point the Creative Director to
on this computer ("the logo is in my Downloads folder") joins the same way once it has read it
(§chat.design-mode/coordinator).

They need no site approval, and the limit of 8 MB per image applies. Of your images other than
screenshots, the Creative Director holds the description, never the image itself.

**A screenshot is a reference.** As the user decided, a screenshot you paste is shown to the
Creative Director and the designers as a reference, never put into a page. **Screenshot** is a kind
only your own images can have: an image captured from a page is never one. An image's kind is yours
first, then the Creative Director's, then the describing helper's (§chat.design-mode/brief-images).

- **Rebuild This Screen or Just Its Feel.** Each screenshot gets its own choice, as a link does
  (§chat.design-mode/link-modes). **Rebuild This Screen** rebuilds what it shows
  (§chat.design-mode/rebuilds); on **Just Its Feel** nobody gets the picture, only its words. A click
  of yours beats the Creative Director's choice.
- **The Creative Director sees it.** A Creative Director whose model can read pictures gets the
  screenshot itself on the turn it is pasted, and can look at it again later, as after a restart or a
  change of model.
- **Its colours are measured.** A screenshot's colours are measured from its pixels, with no model, as
  hex values. They keep its small strong accents and its main text colour, not only its largest
  areas, and the describing helper names each colour's role by what it colours
  (§chat.design-mode/describers).
- **Words for designers.** Each screenshot has words for the designers: its feel and its theme
  colours with their roles. The Creative Director writes and tunes them itself in the brief, from the
  picture when it can see it, else from the helper's draft and the measured colours; it gets no
  ready-made summary, and the helper's draft is only where it starts. Words you save always win over
  the Creative Director's, and describing again never replaces them. With no model that can read
  pictures at all, the brief shows the measured colours and says the feel couldn't be read.

## §chat.design-mode/capture — Capturing a page's images, with no model

As the user decided: "A capture step with no model, then up to 3 describing helpers." Finding and
downloading images is mechanical and uses no model.

- **Once, on the final screen.** On Use Its Images the capture runs once, on the final screen, as soon
  as the Creative Director has found it, not on every page it passes through. A browser visit at desktop
  width scrolls the page, collects the images and saves them. Describing then begins, and the brief's
  grid fills in as results land.
- **Limits.** At most 30 images a capture, 8 MB each and 40 MB in total. Anything over is listed with
  the reason.
- **Colors and font names as notes.** As the user decided: "Images, plus colors and font names as
  notes". The page's real colors and fonts, read directly, go in the brief where you can edit them.
  Font files and stylesheets are never downloaded, and a font not on Google gets a suggested near
  match.
- **Content, never instructions.** Text found on a page or inside an image is treated as content and
  never as instructions.

## §chat.design-mode/describers — A small team describes the images

Up to 3 hidden helpers, on a cheap model that can read pictures, describe about 10 images each and
return data to the Creative Director: what kind each image is, what it shows, where it sat and how a
redesign should use it. For a screenshot you pasted, the same call also drafts a short feel and names
the role of each measured colour, a starting point for the Creative Director's words for designers
(§chat.design-mode/own-images). The Creative Director judges which images suit the brief from those
words alone, except a screenshot it can see.

- **Not on any board.** Helpers take no design seats, never appear on the Agents tab, and can't be
  opened to chat with.
- **A line of their own.** The card shows their cost as one line, "Assets: 14 described", with its
  cost, apart from the design cards.
- **When one fails.** Its images go to another helper. An image that can't be described stays on the
  grid with the reason.

## §chat.design-mode/brief-images — The images on the brief

Each image on the brief has a thumbnail, its kind and a **Use** checkbox. Open one to read what it
shows, where it sat and how it should be used, change its kind, add a note that overrides the rest,
**Describe Again**, or download the original.

A **Screenshot** (§chat.design-mode/own-images) shows its kind, its colours as swatches with their
hex values, its words for designers with **Edit Words** (and **Drop My Words** once you've saved your
own, which brings back the Creative Director's or the first draft's), and its **Rebuild This Screen**
or **Just Its Feel** choice. A page's captured image can't be set to Screenshot. A kind you pick beats the Creative
Director's and the helper's.

Unticking an image needs no rewrite of the Full Prompt, because Sova adds the image list at Start.
Images keep the same name for the life of the chat, so a page made from them keeps working even if
you later stop using one.

## §chat.design-mode/page-images — How a page shows captured images

A designer writes only an image's short name. Sova puts the real picture in when it shows the page,
inside the page's sealed frame, so the seal of §chat.design-mode/prototype-frame doesn't change, and
a model that can't read pictures uses the real images too. The designer's memory, its edits, the main
chat's reading of a page and the Creative Director never hold the picture's data.

A page naming an image the chat doesn't have is refused, with the valid names. While a page using
captured images is being written, those spots show a plain placeholder, never a broken-image icon.
Real images appear when the page is finished.

## §chat.design-mode/asset-storage — Keeping a chat's images

A chat's captured images and your own are kept in its design folder and follow the rule of
§chat.design-mode/storage: removed only when the chat is deleted, never by archiving. No image is
shared between chats. Limits on what is taken in are §chat.design-mode/capture and
§chat.design-mode/own-images.

## §chat.design-mode/link-reach — How far a link you gave reaches

As the user decided: "Your link covers what that page loads."

Any public host a page you gave it loads from is allowed for that one look, reading only, with no
prompts, and the page's own trackers do get contacted, as in any browser. That permission covers only
what the page loads while it's being looked at. A page sending the browser on to another site still
asks, and nothing it loaded stays approved afterwards. Addresses on this computer or a private network
are refused, and a chat's sandbox still applies (§app.tours/sandbox).

## §chat.design-mode/link-sign-in — Signed-in pages

As the user decided: "Signed-in pages: ask once on the card."

When the page is behind a sign-in, capturing asks one extra question on the Creative Director's card, saying
what will be saved and which model reads it. Hosts other than the link's own are approved one by one
here: §chat.design-mode/link-reach's cover doesn't apply to a signed-in look.

## §chat.design-mode/project-reach — What the Creative Director may do across your projects

As the user decided: "See all, start after you confirm".

It looks at what's running everywhere and uses a running copy freely. Starting a new copy, or stopping
one, asks you on its card first, and your yes runs exactly what the card named. It never touches a
project's main checkout. The rule is its own caller's
(§app.project-services/callers).

## §chat.design-mode/sites — Which sites its browser may open

As the user decided: "Your projects and addresses you give it".

- Running copies of your projects and addresses you gave it open at once: naming an address is your
  say-so. An address counts as given only from your own words in Sova's page (Setup's brief, a message,
  the brief's box), never from a script's or a chat's call.
- Any other site asks you once, on the Creative Director's card, as a tour asks (§app.tours/sites). What a
  page you gave it loads is covered by your link instead (§chat.design-mode/link-reach).
- A sign-in asks for a test account on that card, from the same store as tours'. Capturing a
  signed-in page asks once more (§chat.design-mode/link-sign-in).
- It never submits forms beyond signing in.

## §chat.design-mode/refine — Refine

As the user decided: "Same model, up to 2 look-and-fix passes, desktop and phone".

**Refine** on a tile opens a box as an overlay (§chat.design-mode/steady-cards; "What should it change?") with quick prompts (**Check Phone Width**,
**Tighten Spacing**, **Fix Contrast**, **Make Content Real**), **Cancel** and **Send to Design**. It
goes the way of §chat.design-mode/delivery and stays out of the main chat.

The design session opens its own page in a real browser with `design_look`, looks at it at desktop and
phone widths, and fixes what it sees, at most twice for one Refine. Press Refine again for more. A
model that can't read images gets a text outline of the page instead, and the card says so. Each pass
keeps the earlier page, as a new version of that label (§chat.design-mode/labels).

## §chat.design-mode/delivery — One way to reach a session

Refine, Chat, the Creative Director's card and what the main chat passes on all reach a session the same
way, and in the order they were sent.

- **Busy.** The message waits, and the tile shows Queued ("Queued for {name}, after its current
  work.").
- **Can't be delivered.** The card says so, and your text stays in the box.
- **Shut down.** A session that has stopped starts again by itself when a message reaches it, with no
  action of yours and no wake of the main chat (§app.worker-restore/resume).
- **Stopped for good.** Its tile still shows the page, and Refine starts a fresh session from that page.
- **Never a duplicate.** A retry of one message delivers it once.
- **Stays here.** What you do here doesn't wake the main chat. Sova's web app never writes the session
  file itself.

## §chat.design-mode/new-from-parents — New designs made from others

You tell the Creative Director in words: "the header from A with the cards from C". It starts a new labelled
design with `design_new {parents, instructions, model}`, which names its parents ("G, from A and C")
and shows up like any other design. Its style reads **Mixed**, unless the Creative Director names a style
(and, if it wants one, a layout) from the lists (§chat.design-mode/directions). The new design session is the one that gets the parent pages: the
server puts them in its first message, and the Creative Director only writes the instructions. Designs from
earlier runs in the chat count too. `design_new` is refused until its run has launched, so combining
earlier designs while a brief is open waits until after Start.

## §chat.design-mode/commands — The actions are in the command list

Each action a person takes on designs has an entry in Sova's command list (§app/commands): listing a
chat's designs, reading a page, changing Setup, Start Creative Director, a message, a Refine, a Retry,
deleting a design, and a message to the Creative Director. Entries about the whole Lookbook carry its name
(**Change Lookbook Setup**, **Start Lookbook Creative Director**, **Message the Lookbook Creative Director**), and
entries about one page stay a design's (**List Designs**, **Read Design Page**, **Message a Design**,
**Refine a Design**, **Retry a Design**, **Delete a Design**). Their ids stay as they were. What only a person's own click may do (the
brief's Start, answers and edits, the Creative Director's questions, bringing in images and an image's own
note) has no entry (§app.access/your-click).
