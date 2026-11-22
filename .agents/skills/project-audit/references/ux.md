# Product and UX lens

Where users struggle on the journeys in scope. Adapted from Copia's `product-ux-review`
heuristics (2026-11-22). Check against `docs/UI.md` first: a broken rule there is a finding with
a clear fix.

## Core journeys

*project:* the 6 to 10 journeys an `all`-scope run walks, for example:

1. Sign up and reach a first useful result.
2. The core job, start to finish, with real volume.
3. Fix something the app got wrong.
4. Come back after two weeks away and catch up.
5. Settings, the plan, and a connection that needs re-authentication.

For a `since` scope, walk only the journeys the merged changes touch. Seed data with the
scenario command, not by producing states by hand.

## Questions

**Job**
- Does the screen lead with what the user came to do? Is there one primary action?
- How many steps and decisions? Which could the app make with a default?
- After success, does the user know it worked and where the result went?
- Does it hold up with real volume: hundreds of rows, long names, many items?

**Clarity and trust**
- Labels use the user's words, not internal names or enums.
- Every number says what it covers (period, filters), and is the same everywhere it appears.
- Automatic actions are visible, explained in a line, and reversible.
- Errors say what happened and what to do next, without blame.
- Destructive actions say what will be lost; reversible ones offer Undo instead of a confirm.

**Design system**
- A raw colour, hex value or arbitrary z-index instead of a token.
- A list, dialog or menu built without the primitives.
- Dates, amounts and names not routed through the formatting helpers.
- A control that mounts in document flow and pushes content.

**Robustness**
- Empty says why and offers the next step; filtered-empty offers to clear filters.
- Loading skeletons match the final layout; no spinner over a second without context; nothing
  jumps when data lands.
- Error and offline keep what the page has, say what failed, and offer retry.
- Long text, many rows, zero, negative and very large values.
- Drafts survive refresh; unsaved changes ask before closing.
- Disabled controls say why.

**Accessibility** (WCAG 2.2 AA)
- Accessible names on every control; keyboard reachable with visible focus and no traps; focus
  returns after a dialog.
- Contrast 4.5:1 for text and 3:1 for UI parts, in both themes.
- Touch targets 24 px minimum, 44 px for primary actions on phones.
- Meaning not by colour alone; reduced motion honoured.

**Perceived performance**
- Time to first useful content on each core screen.
- Feedback within 100 ms of every action.
- Optimistic updates where actions rarely fail, with a clear rollback.
- Layout shift after load (field CLS from analytics, by page).

## Evidence

UI findings give the page, the width, the theme, and a screenshot or DOM excerpt. Behaviour
findings give the funnel step, rage or dead clicks, or the session count, with the window.
Say "derived from reading" for anything not seen on screen.
