# UI gotchas

Two classes of bug that look like a broken component and are not. Overlay stacking (a Select
inside a Dialog that paints but ignores clicks) is first. The mobile viewport (`100vh` vs the
visible phone screen) is second. Encode the fix in the primitive or the shell; do not patch one
screen.

## Overlay, portal and stacking

Radix Dialog, Select, Popover and DropdownMenu (the shadcn pattern we wrap in
`apps/web/src/components/ui.tsx`) each portal to `document.body` and take over pointer events.
Those two facts fight. A dropdown inside a dialog that "does nothing" is almost always this, not
a missing `onChange`. Encode the fix in the primitive (`ui.tsx`); do not patch one screen.

## Layer scale

One scale, used everywhere. Inventing `z-[9999]` loses to a parent stacking context and fights
the next overlay.

| Layer | z | What |
| --- | --- | --- |
| Page menus | `z-50` (`.menu`) | Dropdowns and popovers on the page |
| Dialogs | `z-[70]` overlay, `z-[71]` content | `Modal`, bumper picker, other confirms |
| Toasts | `z-[75]` | Upload progress (`uploads.tsx`) |
| Menus over a dialog | `z-[80]` | Select, Combobox, and any `.menu` portaled while a dialog is open |
| Command palette | `z-[85]` / `z-[86]` | Above confirms; it closes before a confirm opens |

## Rules we encode in `ui.tsx`

1. **Three mutually exclusive choices is `Segmented`, not `Select`.** Instance settings already
   does this for enums of length ≤ 3. A Select inside `Modal` is the Radix trap below; Follow /
   Always / Never never needed a dropdown.
2. **Portaled menus that can open over a dialog use `z-[80]`.** `.menu` is only `z-50`. Combobox
   already overrode it; Select must too, or the list paints *behind* the overlay and looks frozen.
3. **`position="popper"` on Select.** The Radix default `item-aligned` mis-stacks inside
   `overflow-hidden` / `overflow-auto` ancestors (our `Modal` content and `ScrollArea`).
4. **A click on a portaled `.menu` is not a dialog dismiss.** Select/Combobox content lives
   outside `Dialog.Content`. `Modal` calls `preventDefault` on `onPointerDownOutside` /
   `onFocusOutside` when the target is inside `.menu`.
5. **Portal out of clip, not out of the stacking problem.** `overflow-hidden` on `Dialog.Content`
   clips in-tree menus, which is why we portal; the portal then needs the z-index and the
   outside-click exception above. Do not remove the portal to "fix" stacking.
6. **`transform`, `opacity-<100`, `filter` and `overflow-*` create stacking / clip contexts.**
   A child `z-50` cannot climb out. Portal to `body` (or raise z on that portaled node). Do not
   fight with a bigger number on the clipped child.
7. **Native `<select>` / `<input type="date">` are not used** where a themed primitive exists
   (PRINCIPLES.md). They bring their own OS chrome and sit in a different layer.

## What we hit (Oct 2026)

Users → Limits had a watermark Select. Opening it did nothing: `.menu` is `z-50`, the dialog is
`z-[70]`/`z-[71]`, and a click on the portaled list counted as outside the dialog. The control is
now Segmented (Follow / Always / Never). Select/Combobox inside `Modal` keep working because of
rules 2–4.

## Sources to re-read when adding an overlay

These stay open or keep getting duplicates. Skim them before nesting a menu in a dialog, or when
a dropdown is visible but not clickable.

| Issue | What it is |
| --- | --- |
| [radix-ui/primitives#2122](https://github.com/radix-ui/primitives/issues/2122) | Modal `DialogContent` sets `pointer-events: none` on the rest of the document. Portaled third-party / nested menus need `pointer-events: auto` on their root, or they paint above the overlay and ignore clicks. |
| [radix-ui/primitives#1985](https://github.com/radix-ui/primitives/discussions/1985) | z-index on Dialog vs Select/Dropdown. Portals to `body` stack by mount order unless Content sets z-index; that value is lifted onto the popper wrapper. |
| [shadcn-ui/ui#1647](https://github.com/shadcn-ui/ui/issues/1647) | Select inside Dialog/Sheet: hover and clicks fail. Workarounds people keep rediscovering: higher z-index, drop the Select portal (then overflow clips), or pin dismissable-layer versions. |
| [shadcn-ui/ui#6779](https://github.com/shadcn-ui/ui/issues/6779) | Combobox/Command/Select inside Dialog unclickable. `pointer-events-auto` on the portaled content. |
| [shadcn-ui/ui#9712](https://github.com/shadcn-ui/ui/issues/9712) | Combobox items unclickable in a dialog because the portal is outside the focus trap. |
| [shadcn-ui/ui#9589](https://github.com/shadcn-ui/ui/issues/9589) | Select `position="item-aligned"` (Radix default) stacks wrong inside `overflow-hidden` / `overflow-auto`. Use `popper`. |
| [radix-ui/primitives#2028](https://github.com/radix-ui/primitives/issues/2028) | Popover inside Dialog: the popover's own overflow/scroll stops working. |
| [MDN stacking context](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_positioned_layout/Understanding_z-index/Stacking_context) | Why `z-[9999]` loses to a parent `transform` / `opacity`. |

Radix's own note in #1985: if everything portals to `body`, tree order is enough *until* one
layer sets an explicit z-index (our dialogs do, at 70). Then every nested portal must set one
too.

## Adding a new overlay

1. Use `Modal`, `Select`, `Combobox`, `Segmented` from `ui.tsx`. Do not add a second Dialog
   wrapper with a new z-index.
2. If it must sit above a dialog, give the portaled content `z-[80]` (and `.menu` if it is a
   menu). If it must sit above the command palette, that is a new layer: add a row to the table
   above in the same change.
3. If a menu is visible but dead, check z-index against the table, then pointer-events
   (#2122), then whether the dialog treated the click as outside.
4. Append the upstream issue you used to the sources table.

## The mobile viewport (`100vh` is taller than the screen)

A full-height, non-scrolling app (`overflow-hidden` on `html` / `body` / `#root` so pages own
scrolling via `ScrollArea`) must be sized to the *visible* viewport. `100vh` / Tailwind
`h-screen` is not that number on a phone.

### The units

| Unit | Tailwind | What it is |
| --- | --- | --- |
| `100vh` | `h-screen` | The **large** viewport: the layout size with mobile browser chrome *hidden*. Stable, and too tall while the URL bar is showing. |
| `100svh` | `h-svh` | The **small** viewport: chrome always showing. Bottom chrome stays visible, but the shell leaves a gap when the URL bar hides. |
| `100dvh` | `h-dvh` | The **dynamic** viewport: follows the visible height as chrome shows and hides. This is the one the shell uses. Shrinking with the URL bar is the intended fit, not layout shift. |

`html, body, #root` are `height: 100%; height: 100dvh` (`apps/web/src/index.css`). Shells
(`App.tsx` `Shell` / `Protected` bare / `AppSkeleton`) and full-page `ScrollArea`s (login,
consent, pending) are `h-dvh`. Do not add a new `h-screen`. Viewport-relative max-heights
(`max-h-[90vh]`, `max-h-[70vh]`) use `dvh` the same way, so a dialog cannot outgrow the
visible screen.

`env(safe-area-inset-bottom)` is a different gap (home indicator / notch). It does not fix a
shell that is already taller than the screen.

### Why desktop cannot reproduce it

Chrome DevTools device mode, a 390 px iframe, and resizing the window all set **one** viewport
height. `100vh` and the visible height are the same number, so the bottom of the layout is on
screen. A real mobile browser has two: the large viewport (`100vh`) and the visual viewport
(what you see under the URL bar). The gap is on the order of the toolbar, tens of pixels, so
Firefox can show a sliver of a bottom bar while Chrome and Brave hide it entirely. That is the
same bug. Confirm bottom-anchored UI on a real phone.

A bottom bar that is missing only on a phone, while desktop device mode looks fine, is this —
not a `z-index`, not `overflow` on the `ScrollArea`, not the sticky class.

### What we hit (Oct 2026)

The clips selection bar (`BatchBar`) is `sticky bottom-0` inside the clips `ScrollArea`. The
app shell was `h-screen`. On a Pixel 9a the URL bar ate the bottom of that shell; the sticky
edge sat below the fold. Chrome and Brave hid the bar; Firefox showed a sliver of its top.
Desktop device mode did not reproduce it. The shell is `h-dvh`; the bar stayed sticky.

### Adding a full-height or bottom-anchored surface

1. Size the shell and `html` / `body` / `#root` with `h-dvh` / `100dvh`. Never `h-screen` /
   `100vh` / `min-h-screen` for something that must fit on screen.
2. Keep bottom actions inside that shell (`sticky bottom-0` in the pane's `ScrollArea`, or a
   flex child of the `h-dvh` column). Do not pin them to `100vh`.
3. Caps that mean "must fit on screen" (`max-h-[90vh]`, a preview `max-h-[70vh]`) use `dvh`.
4. Width at 390 px is not a height check. If you cannot use a real phone, say so; do not treat
   device-toolbar Chrome as coverage for this class.

### Sources

| Source | What it is |
| --- | --- |
| [MDN viewport-percentage lengths](https://developer.mozilla.org/en-US/docs/Web/CSS/length#relative_length_units_based_on_viewport) | `vh` vs `svh` / `lvh` / `dvh`. `vh` is the large viewport. |
| [CSS values: large, small and dynamic viewport](https://drafts.csswg.org/css-values/#viewport-relative-lengths) | The spec: UA chrome changes the *visual* viewport; `vh` does not follow it. |
| [The large, small and dynamic viewports (Bramus)](https://www.bram.us/2021/07/08/the-large-small-and-dynamic-viewports/) | Why `100vh` overflowed mobile browsers for a decade, and what the new units are for. |
