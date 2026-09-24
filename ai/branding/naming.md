# Naming

> Part of [Sova branding](overview.md). The name is decided: **Sova**. This page is the decision
> record — the expansion and the chosen mark.

## The decision

**Sova.** *Sessions, Orchestration, Viewing & Agents.* Four letters, said in most languages,
and it names what the product mostly does: watch a set of sessions, in parallel, from one window.
A short made-up word that also reads as a plain noun. The earlier note reached for an owl (the
word is "owl" in several Slavic languages) because watching was the through-line; the expansion
keeps the same through-line without hanging the brand on a mascot.

The rejected candidate was **TAVI**, a made-up word with no meaning to carry. It read as a name
rather than a noun, and the branch/ligature metaphors on the table were good — but it needed a
mark and a sentence next to it for a year, and Sova's own letters could carry a monogram without
one. TAVI stays in the exploration sheets as history, not as a live option.

**The mark is Astra's Fold**, drawn in round 2: one stroked path, a V and an A sharing a stem,
with the A's crossbar as the only added move. The source is
[`logos/round-2/astra/sova-fold.svg`](logos/round-2/astra/sova-fold.svg); the shipped copy is
`public/icons/sova-mark.svg` and is byte-identical. It survives 16px, which is the test it was
drawn to pass. The selected lockup is rendered at
[`logos/selected/sova-fold.html`](logos/selected/sova-fold.html).

The wordmark is set **lowercase**, `sova`, in Inter 640 at −0.03em, and that is what the app's
brand element renders (`src/components/Sidebar.tsx`). Running prose capitalizes the name: **Sova**.

## What holds

- The wordmark is `sova` in Inter 640 at the tracking in `--ls-wordmark`, per the design skill's
  Logo section and [`.sova/spec/claims/design/deviations.md`](../../.sova/spec/claims/design/deviations.md). No other face.
- The mark is `currentColor`, one color, drawn on the system's grid, legible at 16px. It takes
  the accent in the sidebar head; the word never does. Clear space is one panel width; minimum
  size 16px for the mark.
- The product is still "a local web app for pi", and the README's first sentence still says so.
- "pi" stays lowercase and is never part of the name. The agent belongs to someone else.

## The exploration history

Twelve candidate marks were drawn in round 1 (four each by Astra, Fable and K3) and twelve more in
round 2, half for Sova and half for the rejected TAVI. They stay as drawn, under `logos/`, because
they record how the Fold was chosen and what was rejected. Compare them side by side before
reopening the decision; don't average them.
