import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { Services } from "../services.js";
import type { Session } from "../auth.js";

export type Context = {
  svc: Services;
  session: Session | null;
  req: Request;
};

export function contextFactory(svc: Services) {
  return async ({ req }: FetchCreateContextFnOptions): Promise<Context> => {
    const session = await svc.auth.api.getSession({ headers: req.headers });
    return { svc, session, req };
  };
}

const t = initTRPC.context<Context>().create({
  sse: { ping: { enabled: true, intervalMs: 15_000 }, client: { reconnectAfterInactivityMs: 30_000 } },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, session: ctx.session, user: ctx.session.user } });
});
