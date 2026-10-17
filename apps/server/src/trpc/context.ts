import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { Services } from "../services.js";
import { requester, type Requester } from "../auth.js";

export type Context = {
  svc: Services;
  /** null = anonymous. From the browser session cookie or an API key (bearer). */
  who: Requester | null;
  req: Request;
};

export function contextFactory(svc: Services) {
  return async ({ req }: FetchCreateContextFnOptions): Promise<Context> => ({ svc, who: await requester(svc.auth, svc.database.db, req.headers), req });
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
