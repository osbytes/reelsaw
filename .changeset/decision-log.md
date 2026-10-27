---
"@reelsaw/server": minor
"@reelsaw/web": minor
---
Decision log: what you accept, reject, cut, correct and edit is recorded (with the words or clip text it was about, the models that proposed it and a fingerprint of the source) and outlives deleted projects, so Reelsaw keeps learning after "Delete forever" (rejected cuts from deleted projects still teach the filler detector). Settings → Learning turns it off or forgets everything; the "Delete forever" dialog can forget one project's decisions. New MCP tools `list_decisions`, `export_decisions`, `forget_decisions`, `set_learning` (and `forgetDecisions` on `purge_project`), CLI `reelsaw decisions` (list, export, forget, backfill of decisions made before this release), `DECISION_RETENTION_DAYS` (default keep). Ingest records the source's sha256, video id and format. Evals: `harvest-decisions.ts` turns an export into disfluency candidates split by project, and the `decisions` suite replays today's detector against users' decisions.
