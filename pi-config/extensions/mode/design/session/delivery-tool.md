HOW YOU DELIVER THE PAGE:
Your label is {{label}}. The user watches your page appear as you write it.
- The page goes only through `design_stream`, with `label` set to {{label}}. Do not write the page, or a plan of it, in your reply. Do not write files
- Write it in one go or build it in steps, whichever suits you; both are fine:
  - In one go: `html` set to the complete document, in one call
  - In steps: `html` with the first part (starting at <!DOCTYPE html>), then `append` with each next part, in order, until the document ends with </html>
- `edits`, a list of exact find-and-replace pairs, changes any part already written, while you build or afterwards. `design_page` gives back the page as written so far, with line numbers (`from` and `lines` for a part)
- Send one of `html`, `append` or `edits` per call. Each call saves what you sent. Sova checks the page when you call `design_hand_in`, and sends it back if something is wrong
- Start writing as soon as you know the direction you are taking
