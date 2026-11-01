/**
 * Which library assets a layer template names, as one SQL relation: every layer's `assetId` (role "layer") and the
 * template's intro / outro (roles "intro" / "outro"). Usage counts, "used by", the purge guard and the library sweep
 * all read it, so an asset a template needs is never purged whichever way the template uses it. Templates are not in
 * `asset_refs` (that table is keyed by project); the table is small and per user, so the jsonb walk is cheap.
 */
import { sql } from "drizzle-orm";

/** Columns: template_id, user_id, name, updated_at, deleted_at, asset_id, role ("layer" | "intro" | "outro"). */
export const templateAssetUses = sql`
  select t.id as template_id, t.user_id, t.name, t.updated_at, t.deleted_at, u.asset_id, u.role
  from layer_templates t
  cross join lateral (
    select l->>'assetId' as asset_id, 'layer' as role from jsonb_array_elements(t.layers) l
    union all select t.bumpers->>'intro', 'intro'
    union all select t.bumpers->>'outro', 'outro'
  ) u
  where u.asset_id is not null`;
