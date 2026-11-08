# §site/landing — The landing page

The site's front page (`/`) introduces Sova to someone who has not installed it. It shows the
product through real captures of the app (the screens manifest, and the live captures beside it)
rather than drawings, except one illustration of a team built from the site's own mock-up styles
(§site.landing/teams), and it
works at every width from a small phone to a wide desktop without sideways scrolling. The landing
page, its mock-ups, screenshots and brand artwork are excluded from the spec's code boundary on
purpose, except the claims below that name their files: the spec otherwise covers the site's docs
only (§site/docs).

## §site.landing/fold-device — The foldable in "Off the desk"

The "Off the desk" section holds one foldable phone the visitor opens and closes like a book.
Closed, it is a single portrait slab whose outside shows the folded phone's cover-screen capture.
Opening, the cover swings away about a vertical hinge on its left edge, like a book's front cover,
and its inside carries the left half of the unfolded-screen capture; the right half lies on the
panel beneath, so fully open the two halves form the whole inner screen side by side, with the
cover screen facing away. No crease, hinge line or centre line shows on the device in either state:
the halves meet without a visible seam. The device stays centred while it opens and closes, and closing plays
the opening in reverse. One toggle, labelled "Unfold" when closed and "Fold" when open, switches
it by click, tap or keyboard, with a visible focus ring; clicking the device itself does the same.
Pressing the toggle or the device never scrolls the page, wherever it is scrolled; when the
keyboard reaches the toggle, the page brings the whole device and its toggle into view. Without
scripts it still switches, as a plain toggle.
With reduced motion the state swaps at once, without the 3D turn. The open device scales down to
fit narrow phones, and neither state ever makes the page scroll sideways. Each capture keeps its
alt text from the screens manifest.

## §site.landing/teams — The "Teams" section

After the features and before "Merge queue and releases", a section labelled "Teams", reached from a
Teams link in the home page's top bar (before Merge Queue, hidden on narrow screens with it), and
headed "Ask for a team. It works things out between its members." says that telling the agent to
have a team build it starts one with a shared objective, one role per member and who owns which
files. One feature follows, laid out as the features above: **Team inbox**, saying a message to a
busy teammate waits in its inbox instead of failing, an urgent one reaches it at its next step and
an idle one wakes it within seconds, that members close what they handle, and that the side pane
shows each member's inbox beside its transcript; its limit says every team gets a coordinator and a monitor, on the
models the subagent profile's Teams section names or else the chat's own, which is 2 more workers
than the chat names, and that file ownership
is a plan, not a lock; it links to the Teams and Delegate docs. Its visual is an illustration, not
a capture: a frame built from the site's mock-up styles with a team's roster (a coordinator, three
members each owning a folder, a monitor) beside messages between them (a question and its answer
between two members, a checker and a builder going back and forth, the monitor's urgent wrap-up
notice to the coordinator, the coordinator's milestone to the user's chat), described in words for
assistive tech. Three points close the section: members message each other by role without going
through the user's chat; a coordinator that builds nothing, sees every assignment, steers by role,
answers the team's questions and is the only member that talks to the user's chat; and a monitor
on a timer that tells a member near its context limit to wrap up and hand over to a successor, and
pauses the team at a usage limit and resumes it after the reset. The top bar's links never wrap;
the links hidden on narrow screens hide below 1180px wide.

## §site.landing/landing-and-releases — The "Merge queue and releases" section

After the features, a section labelled "Merge queue and releases", reached from a Merge Queue link
in the home page's top bar (hidden on narrow screens with Mesh and Organizations), and headed "Branches land one at a time, as they were tested." says each
project gets a merge queue: nothing reaches its main branch until the user says so, and what lands
is exactly the commit that passed. Four numbered steps follow, in the queue's order: the user
approves it (Land, or "land it" typed in the branch's own chat, only their own word counting); it is
merged onto the newest main branch in a copy beside the project; the project's checks run there,
with any the merge thread picks; the main branch moves to exactly the commit that passed, then is
pushed. Two features follow, laid out as the features above, each with its limit and links to its
docs and its settings page: the **Merge queue** (the project's Merge Queue tab, a red check counted
against the branch only once it passed on the main branch alone, and the merge thread that notes,
picks tests and judges conflicts but never moves the main branch; a project joins once its checks
are set up from Initialize, and can land by pull or merge request instead), and **Releases** (Start
Release's chat following the project's release playbook, the queue holding other branches, the
release checks, a held step waiting for Continue, and Publish doing tag, channel and push in one
step or nothing; off until Set Up Releases, a numbered tag never moved, Withdraw moving only the
channel). Each feature shows a capture of its tab by shot id (`merge-queue-tab`, and `release-in-progress`, a release mid-way with a held step, a failed one,
Publish waiting and Abandon Release), from the screens manifest or the live captures beside it, a
tall one cropped to a 4:3 window that keeps the tab in view;
until that capture exists, a dashed placeholder of the frame's shape says "Screenshot pending" with
the shot's id and what it will show, and the build warns but never fails.

## §site.landing/usage — The "Usage and costs" section

A section labelled "Usage and costs", reached from a Usage link in the home page's top bar (hidden
on narrow screens with Mesh and Organizations), headed "See what your agents spend.", says Sova
records every model call on this computer once and prices it at each provider's API prices, and
shows each subscription's limits beside it. Two features follow, laid out as the features above,
each with its limit and a link to the Usage and costs docs page (§site.docs/usage): **Costs** (the
Agents page's Costs tab: the total split into main sessions, workers and one-shots, each with its
cache hit rate, the cost per day, and tables by provider, model, kind and project, with the
costliest sessions, over 7 days, 30 days or all time and filtered by provider and model; a
project's Cost tab and a session's Usage tab for one project or chat; limit: API prices, not the
bill, and this computer only), and **Subscription limits** (the Usage page: each provider's windows
with how much is used and when they reset, the pace per day, when the window runs out at that pace
and last week for comparison, every Claude login of an account together; a glance at the foot of
the session list; limit: the figures are the provider's own, read on this computer). Each feature
shows a live capture by shot id (`usage-costs`, `usage-limits`), with the user's real figures,
from the live captures; until one exists, the dashed placeholder says "Screenshot pending".
