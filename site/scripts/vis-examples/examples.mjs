// The Vis page's examples: one `vis` block per kind, in the order the page's table lists them.
// Each `source` is the block's body as the agent would write it after the fence's info string
// (`vis <kind>`); render.tsx parses it with Sova's own parser and refuses to draw one that
// doesn't parse cleanly. Write only syntax the kind's guide teaches.

export const EXAMPLES = [
  {
    kind: "flow",
    source: `title: How a reply reaches your browser
caption: The server owns the session; the browser only streams what it sends.
web "Browser tab" -> srv "Sova server" "prompt over WebSocket" -> agent "Agent session" -> model "Model provider" "request"
model --> agent "streamed tokens"
agent --> srv "events"
srv -> done "Run settled?" decision
done -> web "yes"
group "One process" srv agent
mark agent "one writer per session file"`,
  },
  {
    kind: "state",
    source: `title: A worker's life
caption: A worker that fails is retried once, then reported to its parent.
node s0 start
node queued "Queued"
node running "Running"
node blocked "Needs you"
node failed "Failed"
node done end
s0 -> queued
queued -> running "slot free"
running -> blocked "asks a question"
blocked -> running "answered"
running -> failed "error"
failed -> running "retry once"
running -> done "settled"
mark blocked warn "shows in Needs you"`,
  },
  {
    kind: "sequence",
    source: `title: Delegating a fix to a worker
caption: The parent waits on the worker's report, not on its transcript.
actor you "You"
actor parent "Chat"
actor worker "Worker"
you -> parent "Fix the flaky login test"
parent -> worker "brief: reproduce, fix, run the suite"
== Worker runs ==
worker -> worker "runs the test 20 times"
note worker "fails 3 of 20 on a timer race"
worker --> parent "report: fixed, suite green"
parent --> you "summary and the diff"
mark 4 "the worker checks its own fix"`,
  },
  {
    kind: "layers",
    source: `title: Where a chat lives
caption: Everything above the disk can restart without losing a word.
Browser | Chat view, composer, service worker | accent
Sova server | REST API, WebSocket, session registry | one process per checkout
Agent | Tools, model calls, minor modes
Disk | Session files, settings | muted
mark "Sova server" "holds every live session"`,
  },
  {
    kind: "tree",
    source: `title: What the refactor touched
caption: Two files changed; the tests moved with them.
app/
  auth/
    login.ts "token check moved here"
    session.ts
  routes/
    index.ts
tests/
  auth/
    login.test.ts "new: expired token"
  …
mark login.ts "the only behaviour change"`,
  },
  {
    kind: "chart",
    source: `title: Test suite time by package
caption: The e2e package takes over half the run.
type: bar
unit: s
"e2e" 214 warn
"server" 96
"web" 58
"shared" 12
mark "e2e" "run it last, in its own job"`,
  },
  {
    kind: "timeline",
    source: `title: How the outage was found
caption: 41 minutes from the first error to the fix landing.
== Detection ==
14:02 | First 502 on login | from the edge logs | error
14:09 | Alert fires | error rate over 5%
== Fix ==
14:18 | Cause found | an expired TLS certificate on the auth service | warn
14:31 | Certificate renewed
14:43 | Error rate back to normal | | ok
mark "Cause found" "the renewal job had been off since March"`,
  },
  {
    kind: "steps",
    source: `title: What the login change must handle
caption: One scenario still fails: the token refresh during a request.
== Signed in ==
"Valid token" ok | Request -> "check token" -> "200 OK"
"Expired token" ok | Request -> "check token" -> "401" -> "sign-in page"
"Refresh mid-request" error | Request -> "token expires" -> "refresh" -> "request lost"
== Signed out ==
"No token" ok | Request -> "sign-in page"
mark "Refresh mid-request" "needs a retry after refresh"`,
  },
  {
    kind: "wireframe",
    source: `title: The settings screen, before and after the change
caption: The change moves the default model to the top and drops the Save button.
screen "Before"
header "Settings"
  icon "back"
list
  item "Theme" "follows the system"
  item "Notifications" "when a chat needs you"
    toggle on
  item "Default model" "used by new chats"
button "Save" accent
screen "After"
header "Settings"
  icon "back"
list
  item "Default model" "used by new chats"
  item "Theme" "follows the system"
  item "Notifications" "when a chat needs you"
    toggle on
text "Changes save as you make them"
mark "After" "no Save button: each row saves itself"`,
  },
  {
    kind: "matrix",
    source: `title: Where to run the migration
caption: A worktree keeps your checkout untouched until you merge.
columns: Main checkout, Worktree, Remote machine
Keeps your branch untouched | no | yes | yes
Shares installed packages | yes | partial "after install" | no
Runs the full test suite | yes | yes | slow warn
Easy to throw away | no | yes | yes
mark Worktree "the default for a worker"`,
  },
  {
    kind: "code",
    source: `title: Why the retry never stops
caption: The counter resets on every pass, so the limit is never reached.
lang: ts
start: 41
mark 43 error "attempts is reset inside the loop"
mark 46 "the check that should end it"
---
while (!done) {
  try {
    let attempts = 0;
    done = await send(request);
  } catch (err) {
    if (++attempts > MAX_RETRIES) throw err;
    await sleep(backoff(attempts));
  }
}`,
  },
  {
    kind: "svg",
    source: `title: Context window, before and after compaction
caption: Compaction keeps a summary and the latest turns.
<svg viewBox="0 0 360 120" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif" font-size="12">
  <text x="0" y="14" fill="var(--color-ink-2)">Before</text>
  <rect x="0" y="22" width="360" height="24" rx="6" fill="var(--color-sunken)" stroke="var(--color-border-strong)"/>
  <rect x="0" y="22" width="330" height="24" rx="6" fill="var(--status-warn-bg)" stroke="var(--status-warn)"/>
  <text x="10" y="38" fill="var(--color-ink)">Earlier turns, 92% full</text>
  <text x="0" y="74" fill="var(--color-ink-2)">After</text>
  <rect x="0" y="82" width="360" height="24" rx="6" fill="var(--color-sunken)" stroke="var(--color-border-strong)"/>
  <rect x="0" y="82" width="60" height="24" rx="6" fill="var(--color-accent-tint)" stroke="var(--color-accent)"/>
  <rect x="64" y="82" width="70" height="24" rx="6" fill="var(--status-info-bg)" stroke="var(--status-info)"/>
  <text x="8" y="98" fill="var(--color-ink)">Summary</text>
  <text x="72" y="98" fill="var(--color-ink)">Latest</text>
</svg>`,
  },
  {
    kind: "html",
    source: `title: Binary search, one step at a time
caption: Press Step: each step halves the range still in play.
<style>#r{display:flex;gap:4px;flex-wrap:wrap}#r i{font-style:normal;min-width:32px;padding:4px;text-align:center;border:1.5px solid var(--color-border);border-radius:6px}#r .in{border-color:var(--color-accent)}#r .hit{background:var(--status-success-bg);border-color:var(--status-success)}</style>
<p>Looking for 23</p>
<div id="r"></div><button id="s">Step</button>
<script>
var v=[2,5,8,12,16,23,38,56,72,91],lo=0,hi=v.length-1,found=-1,r=document.getElementById("r");
function draw(){r.innerHTML=v.map(function(x,k){return '<i class="'+(k===found?"hit":k>=lo&&k<=hi?"in":"")+'">'+x+'</i>'}).join("")}
document.getElementById("s").onclick=function(){if(found>=0||lo>hi)return;var m=(lo+hi)>>1;if(v[m]===23)found=m;else if(v[m]<23)lo=m+1;else hi=m-1;draw()};
draw();
</script>`,
  },
];
