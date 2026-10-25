/**
 * Every module's event handlers, merged (event-handlers.ts). A handler name registered twice on one
 * event is a compile error here. Add a module with another `mergeEventHandlers(…, next)`.
 */
import { defineEventHandlers, mergeEventHandlers } from "./event-handlers.js";
import { readyEmailHandlers } from "./notify/completion.js";

export const projectEventHandlers = mergeEventHandlers(defineEventHandlers({}), readyEmailHandlers);
