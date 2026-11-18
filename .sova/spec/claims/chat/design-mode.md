# §chat/design-mode — Lookbook
> Part of the Sova design spec · [overview](../design/overview.md)

A **Lookbook** is one page designed by several models side by side. It is part of vis: when you ask
for one, the main chat sends labelled one-page prototypes out to hidden design sessions on several
models, Sova draws each page live in the chat and in the session pane, and you change a design by
talking to it, stop or set one aside, and make new designs from others through one Creative Director,
the run's hidden lead session (§chat.design-mode/creative-director). A run uses only the skills you
name (§chat.design-mode/skills).

The chat holds one **Lookbook card** per run. The card goes through states, each in its title:
**Lookbook · Setup**, **Lookbook · Brief**, then the designs being made (**Lookbook · 6 designs**).
Each single page in it is a design, with a stable letter,
and each letter has its own hidden session on its own model. The pages never enter the main chat
unless it asks to read one.

Owns: how a Lookbook rides vis, when the main chat opens one, its guide, the Lookbook card and its
states, the model picker, design sessions, how a page streams and how its frame is sealed, the
Gallery's prototypes, labels, storage, the Creative Director, its name and its card, the skills a run
uses, how the main chat and the Creative Director read a version and look at its views, what each
design was told, research, the brief and Start, links and images, the limits on a launch, what the
Creative Director may do across projects and sites, changing a design, stopping, removing and
restoring one, and new designs made from others.

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
- Tells the designer to mark the control that opens each of the page's views, when it has more than
  one screen (§chat.design-mode/views).

The guide tells the main chat how a read hands over a page's saved file, never the page, and how to
look at one view (§chat.design-mode/main-chat, §chat.design-mode/version-reads).

The guide and the `lookbook` tool's own description also tell the main chat:

- **Change the card itself.** When you ask for a change after the Setup card is up, the chat makes
  it with `lookbook {op:"edit"}`, changing only what you asked for, instead of sending you to the
  card; after Start Creative Director only the designers, efforts, styles, layouts and how they
  combine, the rest passed on with `tell` (§chat.design-mode/setup-card). It says in its reply what
  it changed.
- **Where pictures may come from.** The three places a picture may be handed over from, and the
  reasons one is refused, so it puts a screenshot in the right place before it tries
  (§chat.design-mode/own-images).
- **Efforts.** That each designer may get an effort, Low unless named
  (§chat.design-mode/model-picker).

## §chat.design-mode/setup-card — Setup comes first, on a card

A run starts on the Lookbook card's Setup state (**Lookbook · Setup**), never in the main chat's
head, and only when you asked for a Lookbook (§chat.design-mode/asking). As the user decided: "a
card pops up first, like an alignment card. If I say all Ollama models and all Claude models, I see
the card with all of them selected, and I can freely change it. I can also edit whatever the main
chat filled in, which keeps the main chat's context clean."

- **The main chat fills in what it was asked.** `lookbook {op:"start", brief?, models?, modelGroups?,
  directions?, layouts?, coordinator?}` (styles in `directions`, layouts you named in `layouts`, none
  unless you named some), with an effort for any designer you named one for (§chat.design-mode/model-picker),
  creates the card and returns at once with the card's id and nothing
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
- **The request shows two lines and opens an editor.** As the user decided, the card shows the first
  two lines of What Do You Want to Design with an **Edit** button beside it, never a box that
  scrolls inside the card. Pressing the text or Edit opens an editor holding the whole request: a
  dialog on a desktop and a sheet rising from the bottom on a phone (a window 480 pixels wide or
  less), with **Cancel** and **Save**. Nothing on the card changes until Save; Cancel, Escape and a
  tap outside it drop what was typed and nothing else, and Save with the text unchanged sends
  nothing. The link rows and the Design skills line stay on the card under the preview; the hint on
  using a link is in the editor.
- **Images show on the card.** An **Images · {n}** row of small pictures shows whenever the run
  has images, whether they came with the card or the main chat added them later
  (§chat.design-mode/own-images), and none shows while it has none. You only look at them on Setup:
  the row has no control.
- **The main chat can change the open card.** As the user decided, while a run is on Setup and you ask the
  main chat for a change ("drop the Ollama ones and put Opus on High"), it changes the card
  itself with `lookbook {op:"edit"}`, naming only what changes: the text, images to add or take off
  (§chat.design-mode/own-images), designers to add or take off, by model or by group as at start,
  each designer's effort, the Creative Director, styles, layouts, Pair Up or Every Mix, and skills
  (§chat.design-mode/skills). Everything it doesn't name stays as it was. It changes the chat's
  newest run on Setup unless it names another, never opens a second card, never presses Start
  Creative Director, and changes only what you asked for. Its answer is short: what the card now
  holds (the count line, the designers with their efforts, the images by name) and each part it
  couldn't apply with why (a model the card doesn't offer, an effort a model doesn't take, a picture
  refused, §chat.design-mode/own-images); it never gets the full model list. The card moves down to
  the chat's change as any update moves it (§chat.design-mode/card), and shows no line about the
  change: the chat says what it changed in its reply.
- **The latest change wins the whole card.** As the user decided, your clicks and the chat's
  changes each save the whole card as it then stands, with no merging: your click saves the card as
  you see it, and a chat change that comes after it wins. A chat change that lands while your click
  is still waiting to be saved wins too: the waiting save is dropped and the card shows the chat's
  version. Each save names the version of the card it was made on, and Sova refuses one made on an
  older version than it holds; the card then shows the version Sova holds, so a click never brings
  back a card the chat has since changed. Text you are typing is never replaced
  under your cursor: while the request's editor is open, neither a save nor the chat's change
  touches its text, and its text and cursor stay when the card is drawn again (moving down under a
  chat change). Save sends the whole card as it then stands, with your text; Cancel leaves the card
  as it now is.
- **One path for every change.** A click of yours, a Save in the request's editor and a chat's
  change all go through the same step, so each one alike recounts the plan, works out the estimate
  again (§chat.design-mode/launch-limits) and reads the text's links again for their rows
  (§chat.design-mode/link-modes); while the brief is open, it also renews the brief's plan line and
  estimate (§chat.design-mode/brief).
- **After Start Creative Director.** As the user decided, until Start on the brief the main chat may
  still change the designers, their efforts, the styles, the layouts and Pair Up or Every Mix, which
  is what Change on the brief lets you change (§chat.design-mode/brief). Text, images and skills then
  go to the Creative Director in your words with `tell`, as before (§chat.design-mode/main-chat).
  Once Start has launched the designs, nothing on the card changes.
- **Clicks stay on the card.** No edit goes back into the transcript or wakes the main chat: each
  click is saved in the chat's design store (§chat.design-mode/storage), with nothing written to the
  chat's session per click, and a reload shows it as left. Start Creative Director records what was chosen
  (what you want, the designing models, the Creative Director, the styles and layouts and how they
  combine, and the skills it uses, §chat.design-mode/skills) in the session once.
- **Start Creative Director** hands the setup to the chat's hidden Creative Director
  (§chat.design-mode/coordinator). It is a click on the card, never a main-chat turn. It
  starts only the Creative Director's preparing: no design is written until Start on the brief
  (§chat.design-mode/brief-start). The limits on a run are §chat.design-mode/launch-limits.
- **The bottom bar lines up.** The count line and Start Creative Director share one centre line. A
  reason Start can't go yet ("Pick at least 1 model to design.") shows under the count only when
  there is one, and the bar keeps the same height with or without it. On a phone the count sits
  above a full-width Start Creative Director, with the reason's room kept.

## §chat.design-mode/model-picker — The model picker and its Creative Director dropdown

The Setup card has one picker for every choice of model: a Creative Director dropdown and a search box
(**Find a model**) on one row, then one section per provider. The Creative Director's model is chosen in the same picker and
stays separate from designing; as the user decided, "I can deselect that model as a designer and
still choose it explicitly as coordinator". One Creative Director dropdown holds that choice, instead of a
checkbox on every row.

- **Models starts as one closed row.** As the user decided, the whole picker starts closed, as one
  **Models** row: the designers by name, each with its effort ("Opus 5.5 High · glm-5.3 Low"; a
  model with no efforts to pick by name alone), the Creative Director on a second line, and the
  count ("3 models"); a line breaks only between designers, never inside a name. On a phone the row
  keeps the names, on up to three lines, and drops the count. Opened, it holds the Creative Director dropdown and Find a
  model, then the providers' sections. Behind the brief's Change (§chat.design-mode/brief) it starts
  open. Models are named as everywhere else in Sova: Claude models by name (Opus 5.5), others by
  their id.
- **One section per provider, all closed at first.** Each provider has its own section, and Ollama
  on this computer and Ollama Cloud are two separate sections. Every section starts closed, however
  many of its models the main chat ticked. Closed, a section is one row of fixed height: the
  provider's name, how many of its models are designing ("7 of 7"), the designing models on one line,
  each with its effort when that isn't Low ("Opus 5.5 · High, glm-5.3, +5", or "None designing"), an
  **All** checkbox that switches Design on or off for every model in that section, and an arrow
  that opens it. Open, its models show directly below its row, one model to a row at every width,
  then its **Hide {provider}** button (below); closing it takes them away again.
- **Open stays open.** The Models row and each section stay open or closed as you left them while
  the card is up, also when the card moves down the chat or is drawn again
  (§chat.design-mode/card).
- **One row per model.** As the user decided, each model is one full-width row: its Design switch
  on the left (any number of models may design), its name, named as everywhere else, with its
  "text only" mark where it applies, and, while it designs, its effort menu at the right edge, the
  menus of all rows in one aligned column, with a divider between rows. A name is never cut short: a
  long one wraps onto a second line, so two models never read alike. A row that doesn't design keeps
  the menu's place empty, so ticking it never changes how its name wraps or the row's height; on a
  phone the menu is narrower, leaving the names more room.
- **Each designer has an effort.** As the user decided, every designing model has its own effort, **Low**
  unless you or the main chat chose another; a model that takes efforts but has no Low runs at its
  own default, its menu reading **Its Own**. The menu offers only the levels that model takes; one
  it doesn't take is refused with the levels it does. The designs a run launches on that model start
  at that effort, and so does a design the Creative Director adds later on that model without naming
  an effort (§chat.design-mode/new-from-parents). You can change it at any time on the card, and the
  main chat can set it when it opens the card and afterwards (§chat.design-mode/setup-card). The
  estimate counts it (§chat.design-mode/launch-limits).
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
- **Search.** Typing in the search box shows only the models that match, each provider with a
  match open with only its matches, in place of the sections; with no match it says so ("No model
  matches “glx”."). Clearing it brings the sections back, each open or closed as the user left it.
  A hidden provider's models are never shown, in search or in the Creative Director dropdown.
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
- **Only providers that can run now.** As the user decided, a provider is left off the card when
  Sova knows it can't run right now: its sign-in has stopped working, its key is refused, it has no key or
  sign-in, or it is Ollama on this computer and that isn't running (checked when the card's list is
  made, in under a second); a model of Ollama on this computer that isn't downloaded is left off too.
  When Sova can't tell, the provider stays. A sign-in stops working by the same rule the Usage page
  and Settings → Accounts use: refused, or its renewal gone; a token that only timed out renews and
  stays, and a reading of the Codex app's own sign-in says nothing about Sova's. A plan limit or
  credit running out never hides one. A
  provider that starts working while the card is up doesn't join that card.
- **Providers you hide.** As the user decided, each provider's opened section has **Hide
  {provider}**, which takes that provider off the card: its models stop designing, and a Creative Director among them moves, before
  it has started, to the first designing model still shown (else the first shown). The last provider
  shown can't be hidden. Sova remembers it on the server for every later Setup card, including the
  ones the main chat opens, until you bring it back with **Show**, which brings back every provider
  you hid. The main chat can't tick a model
  of a hidden provider: its change names it as hidden, and only your Show brings it back. A save of
  the card never fails over a hidden provider: its models stay as Sova has them, not designing.
- **One quiet line says what was left out.** Under the sections, one quiet line names each provider
  left off for not running, with why ("Ollama on this computer isn't running, so it isn't
  listed."), and the providers you hid ("2 hidden · Show", where Show brings them back). A model the
  main chat asked for from a provider left off is named in that provider's sentence ("so glm-5.3
  isn't listed"), and one from a provider you hid in its own ("glm-5.3 is in a provider you hid."),
  never dropped in silence. With nothing left out the line isn't there.
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
  Creative Director asks for. A design the Creative Director adds after Start may run on any model you may use, ticked
  on the card or not (§chat.design-mode/new-from-parents), and still counts toward these limits.
- **Per launch.** The limits count each launch on its own: Start's batch, and the designs the
  Creative Director makes from others in one turn with `design_new`, which count together. Above 12 in one
  turn the Creative Director's card asks first ("Make more than 12 designs this turn?").
- **It counts designs, not money.** The limit is on how many designs a run makes, whatever each one
  costs, and each design's real spend shows on its tile (§chat.design-mode/card).
- **The estimate counts effort.** As the user decided, the run's estimate prices each design by its
  model and its effort (§chat.design-mode/model-picker): a higher effort counts as costing more, by
  a rough multiplier per level, so the same plan at High estimates more than at Low. It is worked
  out again on every change to the card, yours or the main chat's (§chat.design-mode/setup-card).
- **Efforts hold too.** Start launches each design at the effort its model has on the card, and the
  main chat's changes before Start (§chat.design-mode/setup-card) are held to the same rows the
  card offers and the same limits.

## §chat.design-mode/card — The Lookbook card

One Lookbook card per run, in the chat, moving down the chat as it updates and keeping its live
progress there, as one tour card does (§app.tours/one-card). It never joins a compressed group of
working rows, and "Hide tool calls" never hides it. It is the one card allowed to hold finished work
from other sessions, and the main chat itself never sees the pages.

The card's title names its state: **Lookbook · Setup**, **Lookbook · Brief**, then, once a run is
going, **Lookbook · {n} designs** ("Lookbook · 6 designs"). The pages inside stay designs, each
with its letter (A, B, A2; §chat.design-mode/labels).

Once a run is going, the card shows, top to bottom: the run's title, its size, worded as Setup's
count line ("6 designs · 3 pairs · 2 models", §chat.design-mode/setup-card), and a summary of its
states ("2 ready · 1 writing · 3 queued · 1 stopped"); the **Design Brief** row
(§chat.design-mode/brief); one tile per design; the folded **Removed · n** section
(§chat.design-mode/stop-remove); the Creative Director's section (§chat.design-mode/coordinator-card);
then the card's bottom bar.

- **It grows to fit.** As the user decided, the card takes the height it needs in every state, Setup,
  the brief and the designs, with no scroll box inside it: whatever it holds is shown at full
  length, and the chat's own scroll is the only one. How it holds still while it grows is
  §chat.design-mode/steady-cards.
- **The bottom bar stays in reach.** Its bottom bar (Start Creative Director on Setup, Start on the
  brief; once designs
  run, the Creative Director's status and **Chat with the Creative Director**) stays pinned to the
  bottom of the chat while the card is in view, with a shadow only while it is pinned. The chat's
  Jump to Latest, its wait note and Focus sit above the bar whenever the bar is at the chat's bottom,
  so they never cover it.

Each tile holds the page as it is written (§chat.design-mode/streaming) and:

- its label, style and layout on one line ("A  Bold & Vibrant · Bento", the style alone with no
  layout; §chat.design-mode/labels) and its status: **Queued** (**Starting** once its session has
  started and waits on its model), **Writing**, **Fixing** with its reason
  (§chat.design-mode/failed-designs), **Ready**, **Stopped** (**Not started** for one set aside
  before it began; §chat.design-mode/stop-remove) or **Failed**;
- its model and what it cost, in tokens and in dollars from Sova's own price table, at API prices on
  a subscription too, so an Ollama design shows a cost; while a page is being written the tile shows a
  live estimate;
- three places that never change size: **Open** (or, on a stopped or failed design, **Start Again**
  or **Retry**), **Chat**, and **More** (a menu). Open shows the design full size, as it is written
  while it is being written (§chat.design-mode/chat-with). More holds **Open** when its place is
  taken, **Stop** (disabled, with the reason, when nothing is running) and **Remove**, which says it
  stops a design first when one is running (§chat.design-mode/stop-remove). There is no Refine: you
  change a design in its chat (§chat.design-mode/refine).

On a card 520 pixels wide or less, each tile is a row with its picture on the left.

Everything on the card survives a reload and a Sova restart.

- **It moves down with a change.** The main chat changing the Setup card
  (§chat.design-mode/setup-card) is an update like any other: the card moves down to that change, and
  what you had open on it (the Models row, a provider's section, Style, Layout) stays open there
  (§chat.design-mode/model-picker).

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
  says "Waiting for a free session". Once its session has started and waits only on its model's first
  reply, it reads **Starting** and its tile says "Waiting for its model to answer".
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
  whole Lookbook card and the Gallery, in any state, with the exceptions below. A tile's box is its
  final size before anything loads, and a status, reason or button never moves what's around it:
  every design's box is there from Start, so pages streaming in never change the card's height, at
  desktop or phone width. A preview, finished or still being written, draws no scrollbar of its own.
- **The card grows only when you or the Creative Director change what it holds.** The card grows to
  fit (§chat.design-mode/card), so its height changes only at your own clicks (Setup to the brief to
  the designs), when a design is added (at the end of the grid), on Remove or Restore
  (§chat.design-mode/stop-remove), the designs after it closing or opening the gap, and when the
  Creative Director's notes change length, which sit last so only what is below them moves.
- **Changing state moves nothing above it.** Going from Setup to the brief to Generating never moves
  anything above the card.
- **A card not drawn yet holds its place.** In a long chat a Lookbook card scrolled far away isn't
  drawn, and its place holds the height this browser last drew it at (a default height for one it
  never drew), so it lands near its real height when it is drawn.
- **The pickers grow only below the click.** Opening or closing the Models row or a provider section
  (§chat.design-mode/model-picker), or the Style or Layout row (§chat.design-mode/directions), changes
  the card only below that row. Opening or closing a provider section is the one exception to no
  layout shift: it logs one layout-shift entry, and every source of that entry is below the clicked
  row, while the card's top and every row down to the clicked one stay where they were. Each of these
  rows keeps its height whatever it names, and so does the
  row of pairs, which stays one line with Shuffle in its place whether shown or not. Typing in or clearing the search box changes only what is
  below it, and the Creative Director dropdown opens over the card, pushing nothing.
- **What you open stays where you tapped.** As the user decided, opening the Models row, a provider
  section, Style or Layout, pressing Hide or Show, and typing in Find a model never move the chat,
  even while it follows its newest content, and nor does a list that draws a moment later: the row
  you pressed stays where it was and what opens appears under it
  (§chat.transcript/rendering). If it runs past the bottom of the screen, the chat stops following
  and shows Jump to Latest; new messages are followed again once you are back at the end. A reply
  arriving while the chat still follows is followed as ever.
- **The Setup bar keeps its height.** The Setup card's bottom bar is the same height whether or not
  a reason shows under its count (§chat.design-mode/setup-card).
- **The open view on a phone.** The chat folded to its bar (§chat.design-mode/chat-placement) is
  one fixed height whatever its latest message says, and showing or hiding the chat moves nothing
  above it.
- **The open view holds still too.** Its status chip, version picker and More menu have fixed
  places, the picker there even with one version, so a new version arriving moves nothing beside it.
  Its message box is a fixed three lines tall and scrolls past that, instead of growing as the main
  composer's does.
- **An opened page reloads only for a new version.** A design opened full size reloads its page only
  when the version on show changes: a new version arriving while you follow the latest, or one you
  pick. Another design's progress, and this design's own status, notes and costs, never reload it or
  move your place in it. When the version does change, the page on show stays until the new one has
  drawn, so the open view never goes white; a new page that fails to load leaves the shown one
  alone.

## §chat.design-mode/failed-designs — When a design doesn't land

What happens depends on whether the model can do anything about it.

- **A reason the model can act on** (no page received, a page cut off or broken, or a failed check,
  §chat.design-mode/landing-checks), however the model ended its turn, is sent back to the design's
  own session by Sova itself, up to 2 times. The tile shows **Fixing** and the reason meanwhile.
- **A design tool's refusal spends a try too.** A page `design_stream` or `design_hand_in` turns away
  counts as one of the 2, so a session that keeps handing in a broken page ends in Failed and its turn
  stops.
- **Still not landed after those 2:** **Failed**, with the reason, and **Retry**.
- **Your word gives fresh tries.** A person's Retry, Start Again or message in a design's chat gives
  the design 2 fresh tries.
- **A request that changed nothing says so.** A Refine (§chat.design-mode/refine) that ends with no
  new version says so on the tile and in the open view's head ("That didn't change the page:
  {why}."). A change you stopped before it finished leaves no note: the tile simply shows its last
  version, Ready. A question asked in Chat that needed no change doesn't say so either.
- **Stopped is not Failed.** A design you or the Creative Director stopped reads **Stopped**, never
  Failed, keeps what it had written, and is never sent back or retried by Sova
  (§chat.design-mode/stop-remove). Its button reads **Start Again**, and the card counts it as
  stopped, never failed.
- **A reason the model can't act on** (an unsupported model, a login, the provider down) goes straight
  to Failed, with the reason and Retry, and is never sent back.
- **Nobody else pays for it.** The Creative Director spends no turn on any of this: it gets quiet notes that
  start no turn. The main chat is not woken.

Retry starts that one design again under its label, and the rest of the run carries on.

## §chat.design-mode/stop-remove — Stop, Remove and Restore

As the user decided, you can stop a design or set one aside yourself, from the **More** menu on its
tile or in the open view's head, and the Creative Director can too, but only when you ask it to
(§chat.design-mode/coordinator). Each one you do reaches the Creative Director as a quiet note.

- **Stop.** A design can be stopped while it is queued, starting, being written or fixed, or while its
  session is at work on a message. One with no finished version reads **Stopped** and keeps what it
  had written as a still picture, drawn sealed and inert on its tile ("Stopped before it wrote
  anything" when there was nothing). The still is saved before its session stops, so it survives a
  reload and a Sova restart. One stopped during a change keeps its last finished version and reads
  Ready (§chat.design-mode/failed-designs). The tile says who stopped it ("Stopped by you.", "Stopped
  by the Creative Director.", "Stopped from your chat.") and that **Start Again** writes the page
  afresh.
- **Nothing starts it again by itself.** A stopped design is never queued, sent back or retried by
  Sova, nor revived after a restart, and nothing its ending session still sends (a late page, a
  hand-in, its turn ending) changes it.
- **Start Again** writes the page afresh in a fresh session under the same letter, at the full cost
  of a design.
- **Remove sets it aside.** Nothing is deleted: a design at work is stopped first, and one still
  waiting for its first session never starts, reading **Not started** ("Not started yet", "It waits
  until you or the Creative Director start it.", with **Start**). A removed design moves into the
  folded **Removed · n** section under the designs ("Set aside, not deleted. Restore puts one back."),
  on the card, in the Gallery and in the Creative Director's view, where it shows dimmed with
  **Open**, **Chat** and **Restore**, and can still be opened and its chat read. It counts in none of
  the card's figures (its title, its counts, "Tracking n designs"). The Creative Director's reads mark
  it removed, and it can still be a parent of a new design.
- **Restore** puts it back in its place, as it was, and is never refused. One that hadn't started
  stays waiting until you or the Creative Director start it.
- **Delete a Design** in the command list stays the one way to erase a design for good.

## §chat.design-mode/landing-checks — What a page must pass before it counts as landed

Before a page counts as landed, Sova checks it mechanically:

- it is complete HTML with its tags closed;
- no inline script has a syntax error;
- it doesn't rely on outside content the frame blocks (§chat.design-mode/prototype-frame);
- the marks naming its views are sound (§chat.design-mode/views): no two views with one name, no empty
  or overlong name, no `data-sova-via` naming no view or going round in a loop, no view more than 3
  clicks deep, at most 20 views, and every mark on something that can be clicked and that submits
  no form.

These checks run when a page is saved, when it is handed in, and when a session ends its turn with a
page, each problem naming its line. Real breakage goes back to the session as a precise list, on the same 2 tries as
§chat.design-mode/failed-designs. Style issues never do: no page is sent back for how it looks.

## §chat.design-mode/gallery — The Gallery tab

The session pane's Explain tab is now **Gallery** (§app.subagents-pane/tabs). It holds **Prototypes**
on top, then **Page Assets**, then **Explanations**: the same list of this session's /explain pages
the tab showed before.

Prototypes shows every design in the chat, from every run, with the same tiles, statuses, live
pages and More menu as the Lookbook card, and has **Open Creative Director** at its head. It grows to
fit, with no scroll box of its own, and removed designs sit in the same folded **Removed · n**
section as on the card, with Open, Chat and Restore (§chat.design-mode/stop-remove). This is where design sessions
live, since they are not on the Agents tab. With none it reads "0 prototypes yet. They show up here
once you press Start on the brief.", or in a chat with vis off "0 designs in this chat. Turn on
vis and ask for a Lookbook to make some." The tab keeps its name, Gallery.

**Page Assets · {n}** shows every image the chat holds, captured or yours
(§chat.design-mode/asset-storage), to look through: one opens its details over the section without
moving it, and **Download** gives the original.

The Explanations page (`#/explanations`, §app.insights/explanations-page) is unchanged.

## §chat.design-mode/chat-with — Every design and the Creative Director have their own chat

Pressing **Open** on a design, or **Open Creative Director** (on the card, **Chat with the Creative
Director**), shows the page full size or the Creative Director's work and the session's own chat: its
messages, with a message box and **Send** ("Chat with A", "Message A"; "Chat with the Creative
Director", "Message the Creative Director"). **Chat** on a tile opens the same thing. Open works while
a design is being written: its page grows full size as it is written, and a change asked for here
shows live in the same place, the old version holding until the new one has text. The open view's
head has the design's More menu (§chat.design-mode/stop-remove). This message box exists for these two
kinds of session only (§app.subagents-pane/transcript-view), and the Creative Director's chat is the
one place you write to it: the Lookbook card and the brief have no box for it
(§chat.design-mode/coordinator-card). What is sent goes the way of §chat.design-mode/delivery.

As the user decided, these chats read as they were meant, while what each model receives stays byte
for byte as it was (§chat.design-mode/coordinator, "Whose words are whose"):

- **Your words read as yours.** A message you wrote shows as your words alone, with no marks around
  them, under a small label for where you wrote it: "You · In the Creative Director's box", "On the
  brief", "On the Setup card", "Passed on by the main chat", and in a design's chat "In its chat"
  ("Refine" for one sent through the command list's Refine). Only a message whose label is one Sova
  writes, with a matching pair of its marks, counts as yours.
- **Sova's note folds.** What Sova adds to a message (its notes since the last turn, its instructions
  on how to act on the brief) folds under one quiet **Sova's note** line, closed by default; a message
  that is Sova's alone is that line. A fix Sova asks of a design reads "Sova's note · asked it to fix
  its page".
- **A design's first message reads "The brief".** It is folded, and for a design made from others its
  parents' pages read "Made from A and C", never their code. A message that started a fresh session
  from the saved page says the page went with it, without showing the page.
- **The Creative Director's chat lists what each design was told.** Its prompt items sit among its
  messages in time order (§chat.design-mode/prompt-history).

This reading applies only to the sessions a chat's Lookbook names as its Creative Director and
designs.

Where this view sits is §chat.design-mode/chat-placement; how Back, Forward and the address follow it
is §chat.design-mode/open-history.

## §chat.design-mode/prompt-history — What each design was told

As the user decided, Sova keeps a history of everything a Lookbook's designs were told, each item
labelled by who sent it, and the Creative Director's chat shows it.

- **What is kept.** Each Full Prompt revision, whole, and whether it was the Creative Director's or
  yours; each Start, with the revision it launched and each design's style, layout and model; every
  message a design was given: who sent it (you in its chat or through Refine, the Creative Director,
  your main chat, or Sova asking for a fix), when, the words as sent, whether it started a fresh
  session from the saved page, and the version it led to; each new design, what it was made from and
  its instructions; and each start again, stop (with its still), removal and restore. Never a page's
  code. A message is recorded before its session has it, and one never delivered leaves no item.
- **Kept with the chat.** It lives in the chat's design folder (§chat.design-mode/storage) and is
  deleted with the chat. It keeps up to 400 items and about 2 million characters; past that the
  oldest go first.
- **Older Lookbooks.** A Lookbook from before this was kept shows what can be recovered, its current
  Full Prompt and its Start, marked as rebuilt, and everything recorded from then on.
- **Prompt items in the Creative Director's chat.** They sit in time order among its messages, each
  folded to a line and opening to its full text: "Full Prompt · revision 2 · by the Creative
  Director" (or "yours") with what changed from the previous revision; "Started A, B and C" with each
  one's style, layout and model; "To B · from you" ("your Refine", "from the Creative Director", "from
  Sova", "passed on by the main chat") with the version it led to; "D made from A and C" with its
  instructions; and started again, Stopped, Removed and Restored. The Creative Director's own tool
  steps for these fold into their items, so nothing shows twice.
- **In the command list** as **Read Lookbook History** (§chat.design-mode/commands).

## §chat.design-mode/open-history — Back, Forward and the address follow what you opened

As the user decided, the open view (§chat.design-mode/chat-with) is part of the browser's history and
of the page's address.

- **Each open is one step.** Opening a design, its chat or the Creative Director, from the Lookbook card or
  the Gallery, adds one history step. So does opening a design from inside the Creative Director's view,
  and opening the brief's dialog (§chat.design-mode/brief).
- **Back retraces what you opened.** Back goes to what was open before: from a design opened inside
  the Creative Director, Back returns to the Creative Director, then to the chat. **Forward** goes the other way,
  opening them again in order.
- **Closing leaves no stale step.** Closing the view with its close button or Esc puts you back where
  you were before you opened it, so Back afterwards never reopens what you closed.
- **The address says what is open.** The chat's address names the open design by its label or the
  Creative Director, or the open brief by its run (`#/s/<path>?design=A`, `#/s/<path>?design=coordinator`,
  `#/s/<path>?design=brief.<run>`), so a reload or a copied address reopens the same view over the
  same chat. An address naming a design the chat no longer
  has opens the chat alone.

## §chat.design-mode/chat-placement — Where Chat opens, for now

On a desktop the page and its chat sit **side by side**. **Hide Chat** gives
the page the room, and **Show Chat** brings the chat back, with a message you were typing and your
place in it kept.

**On a phone the chat folds to a bar.** As the user decided, where the screen is narrower than
768 pixels the open view gives the page the screen:

- **It starts folded, every time.** The chat starts as a bar about 56 pixels tall at the bottom,
  with a grip and the latest message on one line, its sender first ("B  Moved the hero up and widened
  the 3 cards."); with no message yet it reads **Message B** (**Message the Creative Director**).
  Every design opened starts this way; nothing is remembered between them.
- **Tap to show it.** The bar is a button that says whether the chat is shown. Pressing it shows
  the chat at its present share of the screen and moves the focus to **Hide Chat** in the chat's
  title row, never into its message box; Hide Chat folds it again and the focus goes back to the
  bar.
- **Nothing is lost while folded.** A message you were typing, your place in the chat and its
  latest line are kept while it is folded.
- **A short header.** As the user decided, from 441 to 767 pixels wide the view's head is one row:
  the title over its cost line, the status, the version, More and Close. At 440 pixels wide or less
  it is two rows, as the approved prototype draws it: the title over its cost line with Close beside
  it, then the status, the version and More. Hide Chat is not in the head on a phone.
- **The Creative Director's view** gets the same bar.

 As the user decided: "Not sure, I need to see it once it's ready. Build your
recommendation (Beside the open design) for now, keep this as a revisit, and ask me about it once the
worktree link has something to show me."

The desktop placement is open to change on the user's look at it. Whatever is decided then
replaces it; nothing else in this document depends on the view being side by side, only on each
design and the Creative Director having a chat of their own.

## §chat.design-mode/labels — Stable labels

Each design has a letter for as long as the chat has it: A, B and so on to Z, then AA. A chat has one
counter, shared by all its runs, and a letter is never reused, so "the header from A" means the same
thing to you, the Creative Director and the main chat whenever you say it. A removed design keeps its
letter, and a restored one comes back under it (§chat.design-mode/stop-remove).

A refined version keeps its letter with a number after it (A, then A2, A3). A design made from others
names its parents ("G, from A and C"). Its style and layout, model, status and cost go with its label
wherever it is drawn.

## §chat.design-mode/storage — Kept as long as the chat, and only inside it

As the user decided: "As long as the chat, only inside it". Designs follow the rule tours follow
(§app.tours/storage).

- **Stored by chat.** A chat's designs are kept on this computer in its design store, with every
  version, and survive a reload and a Sova restart. The card's state and Setup's edits are kept there
  too (§chat.design-mode/setup-card), and so are a stopped design's still
  (§chat.design-mode/stop-remove), what each design was told (§chat.design-mode/prompt-history) and
  the pictures of each version's views (§chat.design-mode/views).
- **Images too.** A chat's images follow this rule (§chat.design-mode/asset-storage).
- **Archiving keeps them.** Only actual deletion of the chat removes them. Cleanup runs after a chat
  is confirmed gone, and uncertainty about whether it is gone never deletes anything.
- **Not outside the chat.** They aren't on share links, and no other chat reads them. A peer computer
  linked over the mesh doesn't get them for now.

## §chat.design-mode/coordinator — One Creative Director per chat

Each chat has one hidden Creative Director session, started when Start Creative Director is pressed. It runs on
the model chosen in the Setup card's Creative Director dropdown (§chat.design-mode/model-picker) and
prepares the brief
(§chat.design-mode/brief); Start launches the team, not the Creative Director. As the user decided: "The coordinator should not know every single token every
design has, only the data about them. That makes running out of room a non-issue. Giving it all the
HTML they generate would be the issue."

- **What it knows.** Each design's label, style, layout, model, parents, status, whether it was
  removed, and its versions, each with its time, the note from `design_hand_in` (whose layout line
  shows whether the layout was followed), its size in KB and the absolute path of its saved file. No
  page's code is put in its context: when it wants a page's code it reads that file itself, in parts
  or with a search, as it reads any file. Its first message names the run's styles, layouts, Pair Up
  or Every Mix, and how many designs that makes. It reads these with `design_status`, which takes a
  design or one version by name ("A", "A11", "A11, B") and refuses one that isn't there by naming
  what is, and each hand-in, and each Stop, Remove or Restore of yours, reaches it as a note that
  doesn't start a turn. Of a page's captured images and of your
  other images it holds the descriptions, never the images (§chat.design-mode/describers). A
  screenshot you paste it sees itself when its model can read pictures
  (§chat.design-mode/own-images).
- **What it can do.** Write the brief's summary, Full Prompt and questions with `design_brief`
  (§chat.design-mode/brief-layers, §chat.design-mode/brief-questions), and there each screenshot's
  kind, its Rebuild This Screen or Just Its Feel choice and its words for designers
  (§chat.design-mode/own-images), add a design, from others or from the brief, on any model you may
  use, with `design_new`, after listing those models with `design_models`
  (§chat.design-mode/new-from-parents), send a design a message with `design_send {label, text}`,
  rewrite its own card with `coordinator_card`, and look at a design or a screen with `design_browse`,
  which returns pictures on demand: of a design, any version by name and any of its views, at desktop
  or phone width, each with the same header a read gives (§chat.design-mode/version-reads,
  §chat.design-mode/views).
- **Stop, Remove, Restore and Start Again only when you ask.** As the user decided, it stops
  (`design_stop`), removes (`design_remove`), restores (`design_restore`) or starts again
  (`design_start_again`) a design only on a turn your own words woke: your message in its box, the
  main chat passing your words on, or your edits, answers or Not This Screen on the brief. On any
  other turn Sova refuses the call and tells it to suggest it on its card instead, so nothing leaves
  your view on its judgement alone (§chat.design-mode/stop-remove). It reads files as an ordinary chat does, with pi's built-in
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
- **What it costs.** A few hundred tokens per design, plus whatever part of a page it chooses to read.
- **It reports nothing to the main chat** (§chat.design-mode/main-chat). It is a worker of Sova's in
  everything else: §app.chat-processes/workers, and §chat.design-mode/delivery for how it is reached.

## §chat.design-mode/coordinator-card — The Creative Director's card

The Creative Director has a card that follows the conversation, like an alignment card: what it has
concluded and made so far, at full length with no scroll box, any yes-or-no question it is waiting on
as buttons (Allow Site, Start Copy and the like), its state ("Tracking 6 designs", counting only
designs not removed) and **Chat with the Creative Director**, which opens its chat
(§chat.design-mode/chat-with). Each update replaces what the card said before. It lives in the
Lookbook card, last before the bottom bar, and in the Creative Director's own view.

As the user decided, the card has no message box, on the designs or on the brief: you talk to the
Creative Director in its chat, whose box also takes pasted images (§chat.design-mode/own-images).
Your main chat can still pass your words on (§chat.design-mode/main-chat).

**While the brief is open** only its status, any yes-or-no question and **Chat with the Creative
Director** show, so the two don't repeat each other. After Start, it reads as above.

**Start is heard before the card changes.** At Start, Sova replaces the card with its own line naming
the designs that started ("The designs started from the brief: A, B."). A card the Creative Director writes
from a turn that hasn't yet heard of the Start is refused, with the news of the Start and which designs
started, so Sova's line stays while the designs run. Once refused it counts as told: its next card
stands, and its next turn isn't told of the Start again.

There is no Mix button: you tell the Creative Director what you want, in its chat. A message sent
there is delivered as §chat.design-mode/delivery says, and stays out of the main chat.

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
- **The main chat may change them on Setup.** When you ask, the main chat adds or takes off a run's
  skills on its Setup card (§chat.design-mode/setup-card), found the same way; after Start Creative
  Director they go to the Creative Director in your words.
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
- **It reads the Setup card.** While its newest run is on Setup, `lookbook {op:"read"}` with no label
  returns what the card holds, only what is ticked: the count line, the designers with their
  efforts, the Creative Director, the styles and layouts, the skills and the images by name. It
  changes the card with `lookbook {op:"edit"}` (§chat.design-mode/setup-card).
- **It reads on demand.** Once the Creative Director has started, `lookbook {op:"read"}` returns the Creative Director's current card and one
  line per design, "A · Bold & Vibrant · Bento · {model} · {status} · 16 versions" (the style alone
  with no layout; "(removed)" after the status of a removed design). With a label,
  `lookbook {op:"read", label}` tells it where that design's page is: its latest version by default,
  any version by name ("A11"), or several at once ("A11, A16"), each as the header of
  §chat.design-mode/version-reads with the saved file's absolute path, and never the page itself. It
  reads the file with its own tools, as far as the request needs, so a page costs only what it reads.
- **It looks on demand.** `lookbook {op:"look", label, view?, size?}` returns one picture of one
  version of one design: its first screen or one of its views by name (§chat.design-mode/views), at
  desktop width or phone width, with the version's header. It looks only when you ask to see a design
  or your request needs its picture.
- **It passes things on word for word.** If you tell the main chat "tell B to go darker", it uses
  `lookbook {op:"tell", text}`, which forwards your words to the Creative Director and returns only an
  acknowledgement. An image attached to your message goes with it by reference
  (§chat.design-mode/own-images).
- **A screenshot you ask with goes in at the start.** A screenshot attached to the message in which
  you ask for a Lookbook is handed to the Lookbook when it starts: the Setup card shows it, and the
  Creative Director sees it on its first turn (§chat.design-mode/own-images).

## §chat.design-mode/version-reads — Reading a version: a header and the saved file

As the user decided, the main chat (§chat.design-mode/main-chat) and the Creative Director
(§chat.design-mode/coordinator) read a design's page the same way: by version, as a header and the
path of its saved file, never with the page put in their context.

- **Latest by default, any by name.** A label alone ("A") is its latest version, "A11" is version 11,
  and several separated by commas ("A11, A16") come in the order named, each once.
- **The header.** Each starts with exactly which version it is and which exist: "Design A · version
  16 of 16 (latest) · made 2026-11-16 10:03 UTC · versions 1–16" (a gap reads "1–3, 5"). When a newer
  version is being written, a second line says so ("Version 17 is being written now; this isn't
  it."). Then its size ("Size: 14.1 KB · 14,393 characters, 312 lines."), its views when the page
  names any (§chat.design-mode/views), and "File:" with the absolute path of that version's saved page.
- **The file, never the page.** The page isn't in the reply, which says to read the file in parts or
  search it. A chat whose sandbox hides the design folder gets a read-only copy of that version in its
  own temporary folder, at the path its tools see, and the reply says so; the page is never put in
  the reply instead.
- **Nothing there, nothing read.** A name that isn't a design, a design with no finished page yet, or
  a version it doesn't have is refused before anything is read, naming what there is ("Design A has
  no version 20. Its versions: 1–16.").
- **The Creative Director's tools.** `design_browse` with a label gives this header, then the
  version's pictures; `design_status` lists each version with its size in KB and its file's path.

## §chat.design-mode/views — A design's views

As the user decided, a page with more than one screen (tabs, another page of the site or app, a
menu, a dialog) names its views, so a read lists them and anyone reading can see any of them.

- **The designer marks the controls.** The brief tells each designer (§chat.design-mode/guide) to put
  `data-sova-view="<name>"` on the control that opens each view (the name a person would say, unique in
  the page, at most 40 characters) and `data-sova-via="<view>"` too on a control that is only on
  screen once another view is open, at most 3 clicks deep, in the HTML itself. Every view opens by
  clicks alone from a fresh load, never by typing or submitting a form, and the first screen needs no
  mark. A design of an app opens signed in, with sample data.
- **Read from the page, with no browser.** Sova reads a page's views from its markup when it is saved
  or handed in, and a page whose marks are wrong is refused as a landing check, naming the line
  (§chat.design-mode/landing-checks). Each version keeps the views its page names.
- **Older and unmarked pages.** A page that marks none falls back to its tabs (its `role="tab"`
  controls), listed as found from its tabs. A version kept before views were read lists the views its
  page names, not yet checked.
- **Clicked once in a hidden browser, as a warning only.** After a version is kept, one hidden
  browser at desktop width loads the page afresh for each view, clicks its way there and takes a
  picture. A view whose control couldn't be clicked is marked unreachable, with why, and one whose
  click left the screen as it was is marked unchanged; when exactly one view on the first screen is
  unchanged, or exactly one is marked as the one showing, it is the first screen and gives it its
  name. These marks never send the page back or cost the design a try. The pictures are kept with
  the version for later looks. The pass runs in the chat's confinement (§app.tours/recording); a
  version whose chat had no running process then stays unchecked, and a read or look of it while the
  chat runs checks it again, at most once every 5 minutes.
- **Reads list them.** A read's header (§chat.design-mode/version-reads) has one line for them:
  "Views: Sessions (the first screen) · Deploy · Billing (via User menu)", with why beside a view
  marked unreachable or unchanged, and "not yet checked in a browser" while none is checked.
- **Any view of any version, at either width.** The main chat (`lookbook {op:"look"}`) and the Creative
  Director (`design_browse` with `view`) can ask for a picture of any view of any version at desktop
  or phone width. A view the version doesn't have is refused, naming the views it has. The Creative
  Director can also walk to a screen the page doesn't name with `actions`.

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
opens on the same Lookbook card (**Lookbook · Brief**), then you press Start, and the brief becomes one row as the designs appear.

- **On the card, and in a dialog.** As the user decided, the card keeps a short preview of the
  summary (four lines), what waits inside the full brief, **Open Brief**, the Creative Director's
  questions (§chat.design-mode/brief-questions, "n of m answered"), the Creative Director's status
  with **Chat with the Creative Director**, and the bottom bar with the plan's line and Start. **Open
  Brief** opens the whole brief full size in a dialog (a sheet on a phone), every text at full length
  and only the dialog's body scrolling, with **Edit Summary** and **Edit Prompt** inside. Opening it is
  a step in the browser's history (§chat.design-mode/open-history). When Start waits on a link's or a
  screenshot's choice, pressing it opens the dialog at that choice; when it waits on a question, it
  scrolls the card to the question.
- **What the brief holds.** The summary and the Full Prompt (§chat.design-mode/brief-layers). Around
  them: the screen found, when there is one
  (§chat.design-mode/research); how each link is used (§chat.design-mode/link-modes); the images
  designers will use or the look in words (§chat.design-mode/brief-images); the Creative Director's open
  questions (§chat.design-mode/brief-questions); and a line saying how many designs on which models,
  styles and layouts, with an estimate priced by each design's model and effort
  (§chat.design-mode/launch-limits); and, when you named skills, a **Design skills: …** line
  naming the ones the designers get (§chat.design-mode/skills).
- **Change.** On that line, **Change** reopens the Setup card's model picker, with its Models row
  open and each designer's effort (§chat.design-mode/model-picker), and direction picker
  (§chat.design-mode/directions) in the card itself, so a
  different plan doesn't mean starting again. Until Start the main chat may change the same things
  when you ask it (§chat.design-mode/setup-card); its change renews the plan line and estimate as
  yours does.
- **After Start.** The brief becomes the **Design Brief** row above the designs, with its facts (how
  many images it used among them) and the summary's first line. Its **Open Brief** opens the same
  dialog read only: what the designs were started from, the Full Prompt included.
- **A newer brief replaces an unstarted one.** A run whose brief a newer run's replaced reads Stopped,
  with the reason ("A newer run's brief replaced this one, so it wasn't started. Use the newer
  card."), and has no Start.
- **It moves nothing.** Going from the brief to the designs never moves anything above the card
  (§chat.design-mode/steady-cards).

## §chat.design-mode/brief-layers — Summary and Full Prompt

The brief has two layers. The **summary** is short enough to read in under a minute: what will be
built, for whom, what it must contain and what is left out. The **Full Prompt** is the much larger
text the Creative Director generates, section by section, and it is what the design sessions actually get.
It names no style and no arrangement, since each design adds its own style and layout: it describes
what the page contains (its sections as content, what each is for), never how they are laid out or in
what columns. One text serves the whole batch, so designs differ by style, layout and model and not
by content. As the user decided: "The Full Prompt can
be read and edited, folded under the summary." On the card the summary shows as a preview; in the
brief's dialog (§chat.design-mode/brief) the Full Prompt follows the summary at full length.

The Creative Director writes the summary and its questions first, and the Full Prompt once the questions
are answered.

You change the brief either way: press **Edit Summary** or **Edit Prompt** in the brief's dialog to
type into that layer, or tell the Creative Director in its chat (§chat.design-mode/chat-with); as the
user decided, the brief has no message box of its own.

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
- **Frozen.** The brief is frozen at Start. Later changes go through a design's chat or the Creative
  Director, and the next run gets a new brief.

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

They need no site approval, and the limit of 8 MB per image applies.

- **Where the main chat may take a picture from.** As the user decided, a picture the main chat
  hands over, when it opens the card, when it changes it (§chat.design-mode/setup-card) or with
  words it passes on, comes from one of three places: this computer's temporary folder, the folder
  where Sova keeps the pictures you attached to a message, or the chat's own shared folder. In the
  shared folder it must be an image file inside it, also once links are followed (a link that leads
  out of it is refused), of at most 8 MB. A sandboxed chat's temporary folder is its own: a picture
  it names there is read from that chat's own temporary folder, by the shared folder's rules, and
  only one not there is looked for in this computer's. When Sova can't tell where a chat's own
  temporary folder is, a picture missing there is refused with the advice to use the shared folder.
  A link in the temporary folder to a file that isn't an image is refused as not an image.
- **A refused picture says why.** Each picture turned away is named as the chat gave it, with its
  reason: not in a place it may add from, not an image, over 8 MB, or missing; and the answer names
  the places pictures may come from. The guide says the same up front (§chat.design-mode/guide).
- **Added and taken off on Setup.** A picture the main chat adds to a run on Setup shows on the
  card's Images row (§chat.design-mode/setup-card) and is described as any other. Taking one off
  removes it from that run only: it stays among the chat's images in Page Assets
  (§chat.design-mode/gallery). Of your images other than
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

## §chat.design-mode/refine — Changing a design: its chat

As the user decided, a design is changed by talking to it: **Chat** on its tile, or the chat beside
it in the open view (§chat.design-mode/chat-with). The tile and the open view have no Refine button
and no Refine box, and there are no quick prompts. A message goes the way of
§chat.design-mode/delivery and stays out of the main chat; one sent to a design whose session has
ended starts a fresh session from its saved page, so nothing is lost. Each change that lands keeps
the earlier page, as a new version of that label (§chat.design-mode/labels).

**Refine a Design** stays in the command list (§chat.design-mode/commands). As the user decided for
it: "Same model, up to 2 look-and-fix passes, desktop and phone". The design session opens its own
page in a real browser with `design_look`, looks at it at desktop and phone widths, and fixes what it
sees, at most twice for one Refine. A model that can't read images gets a text outline of the page
instead. Each pass keeps the earlier page, as a new version of that label.

## §chat.design-mode/delivery — One way to reach a session

A design's chat, the Creative Director's chat, the Creative Director's messages to designs, Refine and
what the main chat passes on all reach a session the same way, and in the order they were sent.

- **Busy.** The message waits, and the tile shows Queued ("Queued for {name}, after its current
  work.").
- **Can't be delivered.** The card says so, and your text stays in the box.
- **Shut down.** A session that has stopped starts again by itself when a message reaches it, with no
  action of yours and no wake of the main chat (§app.worker-restore/resume).
- **Stopped for good.** Its tile still shows the page, and a message starts a fresh session from that
  page.
- **Not to a design set aside.** A message to a stopped design is refused until it is started again,
  and one to a removed design until it is restored (§chat.design-mode/stop-remove).
- **Never a duplicate.** A retry of one message delivers it once.
- **Stays here.** What you do here doesn't wake the main chat. Sova's web app never writes the session
  file itself.

## §chat.design-mode/new-from-parents — New designs made from others

You tell the Creative Director in words: "the header from A with the cards from C". It starts a new labelled
design with `design_new {parents, instructions, model}`, which names its parents ("G, from A and C")
and shows up like any other design. Its style reads **Mixed**, unless the Creative Director names a style
(and, if it wants one, a layout) from the lists (§chat.design-mode/directions). The new design session is the one that gets the parent pages: the
server puts them in its first message, and the Creative Director only writes the instructions. Designs from
earlier runs in the chat count too, removed ones included. `design_new` is refused until its run has
launched, so combining earlier designs while a brief is open waits until after Start.

- **A design from the brief.** With no parents (`parents: []`) it adds a design from the brief its
  designs launched with, plus the Creative Director's instructions ("add one on GPT-6 Astra").
- **On any model you may use.** As the user decided, a new design may run on any model you are
  allowed to use, ticked on the Setup card or not; `design_models` lists them, with whether each reads
  images and the efforts it takes. A model turned off in Settings, barred for workers, one Sova knows
  can only fail, or one it doesn't know stays refused, and the Creative Director says why on its card.
  The new tile names its model like any other.
- **Effort.** As the user decided, it runs at the effort you named ("on high"), else at the effort
  that model has on the run's Setup card when it was ticked there (Low unless you or the main chat
  chose another, §chat.design-mode/model-picker), else at the model's usual default.

## §chat.design-mode/commands — The actions are in the command list

Each action a person takes on designs has an entry in Sova's command list (§app/commands): listing a
chat's designs, reading a page, changing Setup, hiding or showing a provider on Setup
(**Hide a Lookbook Provider**, §chat.design-mode/model-picker), Start Creative Director, a message, a Refine, a Retry
(which also starts a stopped design again), stopping, removing and restoring a design, deleting a
design, a message to the Creative Director, and reading what the designs were told
(§chat.design-mode/prompt-history). Entries about the whole Lookbook carry its name (**Change Lookbook
Setup**, **Start Lookbook Creative Director**, **Message the Lookbook Creative Director**, **Read
Lookbook History**), and entries about one page stay a design's (**List Designs**, **Read Design
Page**, **Message a Design**, **Refine a Design**, **Retry a Design**, **Stop a Design**, **Remove a
Design**, **Restore a Design**, **Delete a Design**). Their ids stay as they were. What only a person's own click may do (the
brief's Start, answers and edits, the Creative Director's questions, bringing in images and an image's own
note) has no entry (§app.access/your-click).
