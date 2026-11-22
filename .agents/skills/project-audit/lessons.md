# Lessons

One dated line per lesson the audit learned about itself: a check that was noise, a source that
misled, something missed and found later. A lesson seen twice moves into `SKILL.md` or the run
contract and is deleted here. One older than 6 months that never recurred is deleted.

Lessons inherited from the projects this skill was distilled from (2026-11-22):

- Installing dependencies or deleting `node_modules` inside one lens broke another lens's test
  run mid-audit. Check the toolchain once at the start; lenses never install.
- A zero was reported as good news when the query could not have matched anything. Prove each
  zero against a window or fixture where the problem is known to exist.
