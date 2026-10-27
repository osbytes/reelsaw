---
"@reelsaw/server": patch
---
A plan's free first video now goes to your first video whose length is known, not to one that was still downloading or failed early. Uploads that became a project are no longer counted twice against storage, and the storage limit is enforced on every upload path, including library imports and parallel uploads. Links longer than your allowance are refused before they are downloaded, and are not retried. Re-analyze and refine runs now count toward the hourly re-render limit. An unknown Stripe price is reported to admins, and an account with an existing Stripe subscription is sent to the Billing Portal instead of a second Checkout.
