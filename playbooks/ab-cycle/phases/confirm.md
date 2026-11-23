# Confirm on the sealed cases

The winner and master run on the sealed cases no consultant has seen: `node scripts/runner.mjs <campaign> --round <n> --cases sealed` with a round whose `arms.json` holds master and the winner, then score and chart it as usual. No prediction is compared on the sealed cases, and this round adds no attempt to the record: its pass rates go into the campaign's closing line (`phases/decide.md`).

Also run the winner twice more on a small sample (the noise check, `references/noise.md`). A gain that shrinks on the sealed cases or between copies is reported as such.
