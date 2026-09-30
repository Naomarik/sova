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
