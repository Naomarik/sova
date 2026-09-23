# Approval bar

## Purpose

The persistent decision affordance — where Approve, Review, and Discard live. It pins to the bottom at folded width, inside the thumb arc, and destructive keeps its distance from primary so one mis-tap never throws away a run.

Rendered: `site/components/approvalbar.html`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.approvalbar` | Sticky bottom bar | Static from 768 **of its `.pane`** |
| `.approvalbar-summary` | What is being decided | Full width at folded |
| `.approvalbar-spacer` | Pushes destructive away | Structural, not decorative |
| `.pane` | The review pane around it | Supplies the box the bar measures |

## Tokens used

- `--shadow-2` — Lift at folded width; removed on desktop.
- `--bp-unfolded` — 768px — where it stops being sticky.
- `--control-md` — 44px actions.

## Variants & states

### Approval bar in its pane

```html
<div class="pane">
  <!-- what is being reviewed -->
  <div class="approvalbar">
    <p class="approvalbar-summary">7 files · +142 −38 · tests passed</p>
    <button class="button button-primary">Approve</button>
    <button class="button">Review Changes</button>
    <span class="approvalbar-spacer"></span>
    <button class="button button-destructive">Discard Run</button>
  </div>
</div>
```


## DO / DON'T

- **DO** Summarize what is being approved — nobody should have to scroll up to remember.
- **DO** Keep the spacer between primary and destructive — the gap is the safety mechanism.
- **DO** Put the bar in a `.pane` — it measures the pane, so a bar in a 600px pane stays pinned inside a wide window.
- **DO** Disable Approve when approval is impossible — and say why in the summary.
- **DON'T** Put Discard next to Approve — they are the two ends of the decision, not neighbors.
- **DON'T** Hide the bar on scroll — the decision is the reason the screen exists.
- **DON'T** Use it for navigation — it decides; it does not move you.
