<!-- owner: structure member. kinds/wireframe: DOM blocks, SVG arrow overlay. Emphasis target: a block's first text (the screen it is written under first), a screen name. -->
# vis wireframe
Low-fi screens: what sits where on a phone or desktop page; several screens show a flow, before/after or states. One block per line: a word, its "text"s, then optional words; indent a block to put it inside the one above.
```vis wireframe
title: Invoices on a phone
caption: Totals first; tapping an invoice opens it.
screen "Invoices"
header "Invoices"
  icon "search"
row
  stat "Unpaid" "AED —" warn
  stat "Paid this month" "AED —"
tabs "All, Unpaid, Paid"
list
  item "Invoice no." "customer · due date" "AED —" -> "Invoice"
  item "Invoice no." "customer · due date" "AED —"
button "New invoice" accent
screen "Invoice"
header "Invoice no."
  icon "back"
card "Amount due" "AED —"
  button "Send reminder" accent
mark "Unpaid" "tap to filter"
```
- Blocks: `header "Title"`, `tabs "A, B, C"` (`*B` selects B), `tabbar "A, B, C"`, `sidebar`, `footer`; `row` (up to 4), `col`, `grid`, `card "Title" ["subtitle"]`, `list` of `item "Title" ["detail"] ["right"]` (its blocks, indented: an avatar or icon before it, badges, buttons or a toggle at its right, wrapping under it when they don't fit), `modal "Title"`, `sheet "Title"`; `heading`, `text`, `image "what it shows"`, `avatar`, `icon "name"`, `badge`, `stat "Label" "value"`, `chart "Label" [bar|line|pie]`, `table "Col, Col"` (its `item`s are rows), `progress "Label" "60%"`; `button`, `link`, `input "Label" ["value"] ["hint"]`, `search`, `select`, `checkbox`, `toggle`, `radio`; `empty "Message"`, `loading`, `alert "Message"`, `toast`.
- Words after the texts: a tone (`accent`: the main action; `error` on an input: its hint is the error), `on` (checked, selected), `wide` (twice the room in a row, two tiles in a grid), `right`, `grow`.
- A row shares its width evenly. In a row, `grow` takes the room the others leave and `right` puts that block and the ones after it at the row's end; the other blocks then keep their own width. `row right`: a compact group at the end (a dialog's buttons). `row 2:1`: each block that share, one number (1–6) per block. `row middle` / `row bottom` line blocks up on their centres or bottoms. Elsewhere `right` puts a block at the right edge.
```vis wireframe
title: A toolbar, a form beside its summary, a dialog's buttons
device: desktop
row
  search "Search orders" grow
  button "Filter"
  button "New order" accent right
row 2:1
  card "Shipping"
    input "Address"
    row bottom
      input "Discount code" "Code"
      button "Apply"
  card "Summary" "AED —"
modal "Discard changes?"
  text "Your edits since the last save are lost."
  row right
    button "Cancel"
    button "Discard" error
```
- `screen "Name" [phone|desktop]` starts a screen (up to 6; `device: desktop` sets the default). `-> "Name"` after a block: the screen a tap opens. `mark` a block by its first text or a screen by its name.
- Only the words and numbers you were given; else a placeholder ("Name", "Order no.", "AED —"). Never make up prices, IDs, dates or times.
