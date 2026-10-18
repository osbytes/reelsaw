import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { Services } from "../services.js";
import { requester, type Requester } from "../auth.js";
import type { Logger } from "../log.js";
import type { Context as HonoContext } from "hono";
import { resolveRequestId, type AppEnv } from "../request-log.js";

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
    const who = await requester(svc.auth, svc.database.db, req.headers);
    const requestId = c?.get("requestId") ?? resolveRequestId(req.headers.get("x-request-id"));
    if (who) c?.set("userId", who.user.id);
    const base = c?.get("log") ?? svc.log.child({ module: "http", requestId });
    return { svc, who, req, requestId, log: who ? base.child({ userId: who.user.id }) : base };
  };
}

const t = initTRPC.context<Context>().create({
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 30_000 } },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Any signed-in account, including ones waiting for approval or suspended (for `me`, sign-out helpers). */
export const signedInProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.who) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, who: ctx.who, user: ctx.who.user } });
});

/** An approved, not suspended account: everything that touches user data. */
export const protectedProcedure = signedInProcedure.use(({ ctx, next }) => {
  if (ctx.who.blocked) throw new TRPCError({ code: "FORBIDDEN", message: ctx.who.blocked.reason });
  return next({ ctx });
});

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
  return next({ ctx });
});
