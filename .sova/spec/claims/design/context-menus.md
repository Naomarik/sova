# §design/context-menus — Right-click and hold menus
> Part of the Sova design spec · [overview](overview.md)

Some things on screen have a menu of their own, opened from the thing itself instead of from a
button: a right-click with a mouse, a hold with a finger or a pen. Every such menu in Sova works
the same way, whatever it belongs to. A place's own entry says where its menu is, what heads it
and which rows it holds; everything here holds for it without being said again.

- **Both ways, always.** Every right-click menu also opens with a hold, and every hold menu also
  opens with a right-click. No place has one without the other.
- **The same menu on every screen.** A desktop and a phone get the same menu with the same rows:
  no row is there only for a mouse or only for a finger, and none is left out because of the
  screen. Only its shape follows the width (below).
- **Never the only way.** A menu like this is a shortcut and nothing more. Each of its rows is an
  action Sova already offers somewhere else, and it does exactly what that action does, with the
  same messages. Nothing is reachable only through one of these menus, so a keyboard reaches
  every action they hold through its other doors.
- **With a mouse.** A right-click opens the menu at the pointer once the button is released,
  never on the press, so the release that ends the click can't close it again. Its corner sits at
  the pointer; near the window's right or bottom edge it opens to the pointer's other side, and
  it always stays at least 8px inside the window. The right-click does nothing else: it never
  opens or selects the thing it was made on.
- **With a finger or a pen.** Hold the thing for about half a second, then let go without
  moving: the menu opens. Sova times the hold itself, so it works on phones that never turn a
  long press into a right-click. A touch that moves does what it would anyway (it
  scrolls, or drags what can be dragged), and a tap does what a tap does there. The phone's own
  long-press menu and text selection don't show over the thing.
- **The browser's menu stays reachable.** Shift + right-click, the Menu key and Shift+F10 keep
  the browser's own menu, for copying a link and the like. No key opens Sova's menu.
- **Its shape.** From 768px a menu by the pointer; under 768px a bottom sheet the window's width,
  as Sova's other menus are.
- **One at a time.** Opening one closes any other menu that is open, another place's included. A
  right-click on a second thing while a menu is open closes that one and opens the second's.
- **Closing.** Escape, or a click or tap anywhere else, closes it and nothing happens. Focus goes
  back to the thing it was opened on. A menu closes by itself when what it belongs to
  leaves the screen.
- **Its rows** are the system's menu rows (§design/menu-rows). Enter or Space runs the focused
  one. A row that can't run is disabled and says why on its second line.
- **Where they are.** Today only on the sidebar's session rows (§app.session-list/row-menu).
  Giving another place such a menu is a decision of its own, written in that place's entry and
  added to this list; `src/lib/context-menu-rule.test.ts` fails when a menu like this appears
  anywhere not on its list, or is wired with a right-click and no hold. Extensions add nothing to
  these menus.
