---
"@reelsaw/server": minor
---

Cancelling a plan is clearer about what happens next. The Billing page shows the day the plan ends, also when the cancellation was set for a date in Stripe rather than the end of the period, and lists the Free limits the account will be over then (storage, projects, this month's minutes) with what each will refuse. The same list is in `get_billing` (`afterCancel`) and in a "your plan ends on …" mail sent when the cancellation is scheduled; a second mail says when the account has moved to Free. The `billing.canceled` event now fires once, when the subscription ends; scheduling a cancellation is `billing.cancel_scheduled`, and taking it back is `billing.cancel_undone`.

Counts, sizes and dates read the same everywhere: the CLI, MCP answers and the app say "1 clip" and "3 clips" instead of "clip(s)", and sizes use one format (binary units, so a model download shows 4.4 GB where it used to show 4.7 GB).
