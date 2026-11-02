/**
 * Every event handler, in one place: event type → handler name → handler (event-handlers.ts).
 * Project events (`u.emit`) and account events (`u.emitAccount`) alike. The handlers live with their
 * modules; this map is the only list of what follows each event.
 */
import { defineEventHandlers } from "./event-handlers.js";
import { approvalRequestEmail, approvedEmail, webhookDisabledEmail } from "./notify/account.js";
import { readyEmail } from "./notify/completion.js";

export const eventHandlerMap = defineEventHandlers({
  // project events
  "project.done": { readyEmail },
  // account events
  "user.signed_up": { approvalRequestEmail },
  "user.approved": { approvedEmail },
  "webhook.disabled": { webhookDisabledEmail },
});
