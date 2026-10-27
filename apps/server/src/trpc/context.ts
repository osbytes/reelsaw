import { initTRPC, TRPCError } from "@trpc/server";
import { QuotaError } from "../quota.js";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { Services } from "../services.js";
import { ADMIN_REFUSED_MESSAGE, cannotUseApp, requester, type Requester } from "../auth.js";
import type { Logger } from "../log.js";
import type { Context as HonoContext } from "hono";
import { resolveRequestId, type AppEnv } from "../request-log.js";
import { asUserRequest } from "../uow.js";
import { checkRequestRate } from "../abuse.js";

export type Context = {
  svc: Services;
  /** null = anonymous. From the browser session cookie or an API key (bearer). */
  who: Requester | null;
  req: Request;
  /** request id (x-request-id), also on the response and in the http access line */
  requestId: string;
  /** child logger carrying requestId and, once known, userId */
  log: Logger;
};

export function contextFactory(svc: Services) {
  return async ({ req }: FetchCreateContextFnOptions, c?: HonoContext<AppEnv>): Promise<Context> => {
    const who = await requester(svc.auth, svc.database.db, req.headers, svc.log.child({ module: "auth" }));
    const requestId = c?.get("requestId") ?? resolveRequestId(req.headers.get("x-request-id"));
    if (who) c?.set("userId", who.user.id);
    const base = c?.get("log") ?? svc.log.child({ module: "http", requestId });
    return { svc, who, req, requestId, log: who ? base.child({ userId: who.user.id }) : base };
  };
}

const t = initTRPC.context<Context>().create({
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 30_000 } },
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(error instanceof QuotaError && error.quota ? { quota: error.quota } : {}),
      },
    };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;

/** Any signed-in account, including ones waiting for approval or suspended (for `me`, sign-out helpers). */
export const signedInProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.who) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to continue (or send a valid API key)." });
  return next({ ctx: { ...ctx, who: ctx.who, user: ctx.who.user } });
});

/** An approved, not suspended account: everything that touches user data. */
export const protectedProcedure = signedInProcedure.use(async ({ ctx, next, type }) => {
  const why = cannotUseApp(ctx.user, ctx.who.via);
  if (why) throw new TRPCError({ code: "FORBIDDEN", message: why });
  // changes are rate-limited per account (abuse.ts; off unless MAX_REQUESTS_PER_* is set); reads are not
  if (type === "mutation") {
    try {
      await checkRequestRate(ctx.svc.database.db, ctx.svc.settings.get(), ctx.who.user.id, ctx.svc.entitlements);
    } catch (err) {
      ctx.log.warn({ reason: (err as Error).message }, "request rate limit reached");
      throw err;
    }
  }
  // jobs this call enqueues for the user's own projects are their requests: fair-share limits apply (uow.ts)
  return asUserRequest(ctx.who.user.id, () => next({ ctx }));
});

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
  // an API key or OAuth connector acts as its admin only when it was allowed to (auth.ts, README "MCP")
  if (!ctx.who.canAdminister) throw new TRPCError({ code: "FORBIDDEN", message: ADMIN_REFUSED_MESSAGE });
  return next({ ctx });
});
