/**
 * Share links and webhooks (docs/specs/media-links.md, webhooks.md): the procedures behind Settings → API keys and MCP,
 * a clip's "Copy share link" and the export dialog. MCP tools call these through the router; `reelsaw media-links` and
 * `reelsaw webhooks` call the same services.
 */
import { z } from "zod";
import { router, protectedProcedure } from "./context.js";
import type { Context } from "./context.js";
import { MEDIA_LINK_KINDS } from "../db/schema.js";
import { getOrCreateLink, LINK_LIST_MAX, listLinks, revokeLinks, revokeMessage, type LinkTarget } from "../media-links/service.js";
import type { MediaLinkSource } from "../db/schema.js";
import {
  createEndpoint,
  deleteEndpoint,
  DELIVERY_LIST_MAX,
  listDeliveries,
  listEndpoints,
  resendDelivery,
  rotateSecret,
  updateEndpoint,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
} from "../webhooks/service.js";
import { testEndpoint } from "../webhooks/deliver.js";

const id = z.string().min(1).max(100);
const ttlDays = z.number().int().min(1).max(3650).nullable().optional().describe("Days the link lasts (capped by the instance); null = never expires");
const label = z.string().trim().max(120).optional();

const sourceOf = (ctx: { surface?: Context["surface"] | undefined }): MediaLinkSource => (ctx.surface === "mcp" ? "mcp" : "ui");

export const mediaLinksRouter = router({
  /** What the instance allows: the longest life and whether "never" is offered. */
  policy: protectedProcedure.query(({ ctx }) => {
    const s = ctx.svc.settings.get();
    return { maxDays: s.MEDIA_LINK_TTL_DAYS, allowNever: s.MEDIA_LINK_ALLOW_NEVER };
  }),
  /** The clip's (or the export's) active link, or a new one; a label or an expiry always makes a new one. */
  get: protectedProcedure
    .input(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.enum(["clip", "thumb", "srt", "vtt"]), clipId: id, ttlDays, label }),
        z.object({ kind: z.literal("export"), projectId: id, clipIds: z.array(z.string().min(1).max(64)).max(50).optional(), ttlDays, label }),
      ]),
    )
    .mutation(({ ctx, input }) => {
      const target: LinkTarget =
        input.kind === "export" ? { kind: "export", projectId: input.projectId, clipIds: input.clipIds } : { kind: input.kind, clipId: input.clipId };
      return getOrCreateLink(ctx.svc, ctx.user.id, target, { source: sourceOf(ctx), ttlDays: input.ttlDays, label: input.label });
    }),
  list: protectedProcedure
    .input(
      z.object({
        projectId: id.optional(),
        clipId: id.optional(),
        active: z.boolean().optional(),
        cursor: id.optional(),
        limit: z.number().int().min(1).max(LINK_LIST_MAX).default(50),
      }),
    )
    .query(({ ctx, input }) => listLinks(ctx.svc, ctx.user.id, input)),
  /** One link, a clip's, a project's, or every link of the account. */
  revoke: protectedProcedure
    .input(z.union([z.object({ linkId: id }), z.object({ clipId: id }), z.object({ projectId: id }), z.object({ all: z.literal(true) })]))
    .mutation(async ({ ctx, input }) => {
      const revoked = await revokeLinks(ctx.svc, ctx.user.id, input);
      return { revoked, message: revokeMessage(revoked) };
    }),
});

const webhookUrl = z.string().trim().min(1).max(2000);
const events = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length);
const description = z.string().trim().max(120);

export const webhooksRouter = router({
  /** What can be subscribed to, for the event checkboxes. */
  eventTypes: protectedProcedure.query(() => WEBHOOK_EVENT_TYPES),
  list: protectedProcedure.query(({ ctx }) => listEndpoints(ctx.svc, ctx.user.id)),
  /** The secret is in the answer only this once. */
  create: protectedProcedure
    .input(z.object({ url: webhookUrl, events, description: description.optional() }))
    .mutation(({ ctx, input }) => createEndpoint(ctx.svc, ctx.user.id, input)),
  update: protectedProcedure
    .input(
      z.object({ id, url: webhookUrl.optional(), events: events.optional(), description: description.nullable().optional(), enabled: z.boolean().optional() }),
    )
    .mutation(({ ctx, input }) => updateEndpoint(ctx.svc, ctx.user.id, input.id, input)),
  delete: protectedProcedure.input(z.object({ id })).mutation(({ ctx, input }) => deleteEndpoint(ctx.svc, ctx.user.id, input.id)),
  rotateSecret: protectedProcedure.input(z.object({ id })).mutation(({ ctx, input }) => rotateSecret(ctx.svc, ctx.user.id, input.id)),
  /** Sends a webhook.test now and answers with what the receiver said. */
  test: protectedProcedure.input(z.object({ id })).mutation(({ ctx, input }) => testEndpoint(ctx.svc, ctx.user.id, input.id)),
  deliveries: protectedProcedure
    .input(
      z.object({
        endpointId: id.optional(),
        status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
        projectId: id.optional(),
        cursor: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(DELIVERY_LIST_MAX).default(50),
      }),
    )
    .query(({ ctx, input }) => listDeliveries(ctx.svc, ctx.user.id, input)),
  resend: protectedProcedure
    .input(z.object({ deliveryId: z.number().int().positive() }))
    .mutation(({ ctx, input }) => resendDelivery(ctx.svc, ctx.user.id, input.deliveryId)),
});

export { MEDIA_LINK_KINDS };
