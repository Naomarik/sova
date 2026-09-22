# Playbook: update the README

> Part of [Sova branding](../overview.md). The README is a product front door, not an
> operational manual. Preserve the reader's time, not the previous document's structure.

## Purpose and shape

A busy developer should understand the payoff and find the install command in seconds.
Aim for **300–400 words**, in this order:

1. Existing logo, benefit-led headline, and a short explanation of what Sova adds to pi.
2. One published installer command, followed by “then `sova`” and the local URL.
3. Around 5 scannable features, written as useful outcomes rather than component names.
4. A brief, honest single-user, authentication, and provider-network note.
5. Links to setup, customization, development, and license details.

Parallel sessions, comparison, branching, and continuity are reasons to try the product.
Lead with those—not the acronym, architecture, defensive qualifications, or a feature audit.
Calm and concrete does not mean reluctant to explain why the tool is useful.

## Before writing

- Record the revision and check the worktree. Verify claims against implementation, not just the
  spec or an older README; use [truth-sources.md](../truth-sources.md). Report what was actually
  checked, distinguishing code inspection from browser testing.
- Check both ends of a capability: backend and UI. Mark extension-dependent functionality as
  optional, and link its setup instructions.
- Read the installer. A command that installs but does not launch must not be described as
  running the app. Keep the published release URL unless a new release has actually shipped.
- Check current names against code. New state uses `sova`; legacy `pi-web` spellings remain for
  compatibility. Do not repeat old migration plans as current facts.

## Editing rules

- Replace weak copy instead of appending explanations. A new feature may replace a weaker bullet;
  it does not automatically earn a section.
- Put login, PATH troubleshooting, protected phone access, runtime settings, and removal in
  [Getting started](../../../docs/getting-started.md).
- Put themes, model policy, and extension setup in
  [Customization](../../../docs/customization.md); put build and test details in
  [Development](../../../CONTRIBUTING.md).
- Keep decisive limits close: terminal watching is read-only; subagents and remote tools need
  extensions. Link detailed prerequisites instead of repeating them in every bullet.
- Do not promise no network traffic, offline agents, or safe public access without authentication.
- Use the existing logo. No invented badges, screenshots, testimonials, or performance claims.
- Keep revision evidence in the change report, not in the product pitch.
- Never edit `CLAUDE.md` or `AGENTS.md`, or add automatic branding instructions there.
  These branding documents remain opt-in guidance.

## Before publishing

Check relative links and anchors, command spelling, installer availability, and copy consistency.
Review the diff for credentials, personal paths, transcript excerpts, and other private data.
Report the README word count and the checks performed. Flag stale statements in separately owned
extension documentation rather than expanding the change into that subtree.

## Example

A theme refresh improvement belongs in the customization guide. Update its existing refresh
sentence after checking the implementation; don't add 3 paragraphs to the README. If themes become
one of the strongest reasons to use Sova, give them a concise benefit-led bullet in place of a
less useful one—not a configuration tutorial above the install command.
