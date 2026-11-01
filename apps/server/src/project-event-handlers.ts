/**
 * Every project event handler, in one place: event type → handler name → handler (event-handlers.ts).
 * The handlers live with their modules; this map is the only list of what follows each event.
 */
import { defineEventHandlers } from "./event-handlers.js";
import { readyEmail } from "./notify/completion.js";

export const projectEventHandlers = defineEventHandlers({
  "project.done": { readyEmail },
});
