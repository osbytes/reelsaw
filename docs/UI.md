# Overlay, portal and stacking gotchas

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
