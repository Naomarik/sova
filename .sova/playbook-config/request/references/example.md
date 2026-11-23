# Example

Title: `Merge queue: show the host's checks on the card`

```markdown
## Why
A request's card said nothing while GitHub's own checks ran, so you opened GitHub to find out.

## What changes
- The card reads "Checks running on GitHub", then "Host checks failed" or "Checks passed".
- A request with no checks reads "Not reported", never "Passed".

## Checks
- Unit tests: passed
- Integration tests: passed

Opened by Sova
```
