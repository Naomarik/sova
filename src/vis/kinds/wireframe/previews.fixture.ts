/**
 * A `vis wireframe` fence a model wrote in a real session (2026-09-30), verbatim: list items whose
 * trailing blocks are a `row` of badges and buttons. Its title column once collapsed to a few pixels
 * beside them. Shared by parse.test.ts and layout.test.ts.
 */
export const PREVIEWS = `title: Project page, Previews card
caption: Each preview shows its coding session, branch, what it serves, who made it and when it expires.
screen "Desktop" desktop
header "Project name"
card "Previews" "A coding session's running app, shown to people outside"
  list
    item "Purpose of preview" "Coding session · branch · static files" "Expires in N days"
      row
        badge "Made by the overseer" info
        badge "Serving" ok
        button "Copy Link"
        button "Turn Off" error
    item "Older preview" "Matched by the app's folder · port N" "Expires in N days"
      row
        badge "Made by you" muted
        button "Turn Off" error
screen "Phone" phone
header "Project name"
card "Previews"
  list
    item "Purpose of preview" "Coding session · static files"
      row
        button "Copy Link"
        button "Turn Off" error
mark "Older preview" "Fatoom's preview is matched this way; its record isn't changed"
mark "Copy Link" "Only if the link is kept (q1)"`;

/**
 * The row words (§chat.markdown/vis-wireframe, Rows) in the screens they were made for: a dialog's buttons, a
 * toolbar, a form beside its summary, a three-pane mail, a field and its button lined up at the bottom, a link at a
 * card's right edge and a thumbnail beside text. Shared by parse.test.ts and layout.test.ts; their rendered
 * heights are layout.test.ts's.
 */
export const ROWS = {
  dialog: `title: A dialog's buttons at its end
screen "Phone" phone
header "Project name"
  icon "back"
text "Sessions, previews and files of this project."
modal "Archive project?"
  text "Its sessions stay readable; nothing new can start in it."
  row right
    button "Cancel"
    button "Archive" error
screen "Desktop" desktop
header "Project name"
card "Settings"
  input "Name" "Project name"
  row
    button "Delete" error
    spacer
    button "Cancel"
    button "Save" accent`,
  toolbar: `title: A toolbar: the search takes the room, the actions sit at the end
screen "Desktop" desktop
header "Orders"
  avatar "Omar"
row
  search "Search orders" grow
  select "" "All statuses"
  button "Export" right
  button "New order" accent
table "Order, Customer, Total"
  item "Order no." "Name" "AED —"
  item "Order no." "Name" "AED —"
row middle
  text "Page 1 of N"
  row right
    button "Previous"
    button "Next"
screen "Phone" phone
header "Orders"
row
  search "Search orders" grow
  button "Filter" right
list
  item "Order no." "Name" "AED —"
  item "Order no." "Name" "AED —"`,
  checkout: `title: Checkout with its summary beside the form
screen "Shipping" desktop
header "Checkout"
tabs "Cart, *Shipping, Payment"
row 2:1
  col
    input "Full name"
    input "Address"
    row
      input "City"
      select "Country" "Choose"
    row bottom
      input "Discount code" "Code"
      button "Apply"
    row middle
      link "Return to cart"
      button "Continue to payment" accent right -> "Payment"
  card "Order summary"
    item "Product name" "qty 1" "AED —"
    item "Shipping" "Standard" "AED —"
    stat "Total" "AED —"
screen "Payment" desktop
header "Payment"
input "Card number"
button "Pay AED —" accent`,
  mail: `title: Three-pane mail
device: desktop
header "Mail"
  search "Search mail"
  avatar "Me"
row 1:3:2
  col
    button "Compose" accent
    list
      item "Inbox" "12 unread"
      item "Sent"
      item "Drafts"
  list
    item "Sender" "Subject line" "9:41" on
    item "Sender" "Subject line" "Yesterday"
    item "Sender" "Subject line" "Mon"
  col
    heading "Subject line"
      icon "more"
    row middle
      avatar "Sender"
      text "Sender · to me"
    text
    row right
      button "Reply"
      button "Forward"`,
  apply: `title: A field and its button
screen "Bottom" phone
row bottom
  input "Discount code" "Code"
  button "Apply"
row bottom
  input "Email" "you@example" "We never share it."
  button "Subscribe" accent
row
  input "Discount code" "Code"
  button "Apply"
screen "Desktop" desktop
row bottom
  input "Discount code" "Code"
  button "Apply"
row middle
  input "Email" "you@example" "We never share it."
  button "Subscribe" accent`,
  signin: `title: A link at a card's right edge, a thumbnail beside text
screen "Sign in" phone
header "Sign in"
card
  input "Email"
  input "Password"
  link "Forgot password?" right
  button "Sign in" accent
row
  image "Product photo"
  col grow
    heading "Product name"
    text "Short description of the product, over two lines or so."`,
} as const;
