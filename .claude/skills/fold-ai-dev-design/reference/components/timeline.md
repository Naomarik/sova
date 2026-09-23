# Run timeline

## Purpose

A stepped record of what a worker actually did. Every step states what happened; a failure states where it stopped and what it did *not* touch — which is the sentence that tells a user whether to panic.

Rendered: `site/components/timeline.html#anatomy`

## Styles

| Class | Role | Notes |
|---|---|---|
| `.timeline` | Stepped column | Connector drawn per step |
| `.timeline-step` | One step | Grid: marker + content |
| `.timeline-marker` | 18px status marker | Colored by state class |
| `.timeline-title` | What happened | 14.5px medium |
| `.timeline-meta` | Time and counts | Mono |
| `.timeline-body` | Consequence | Only when there is one |
| `.timeline-done|running|waiting|failed` | State | `running` carries the one live pulse |

## Tokens used

- `--status-success|warn|error` — Marker colors.
- `--color-accent` — Running marker and pulse.
- `--color-border` — Connector line.

## Variants & states

### Failed step

```html
<div class="timeline-step timeline-failed">
  <div class="timeline-marker">×</div>
  <div>
    <p class="timeline-title">Failed at step 4 and stopped</p>
    <p class="timeline-meta">14:14</p>
    <p class="timeline-body">Nothing was merged. The branch is untouched.</p>
  </div>
</div>
```


## DO / DON'T

- **DO** Say what a failure did not touch — it is the difference between a scare and a fact.
- **DO** Show a count while work is running — "38 of 214" is worth more than any spinner.
- **DO** Keep step titles in past tense for finished work — the timeline is a record, not a plan.
- **DON'T** Animate more than the running marker — the timeline is read, not watched.
- **DON'T** Hide completed steps — the record is the point.
- **DON'T** Use the timeline for chat — tool calls belong in the thread.
