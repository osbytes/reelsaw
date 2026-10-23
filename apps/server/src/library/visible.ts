import { eq, isNull, or } from "drizzle-orm";
import { schema } from "../db/index.js";

/** A library row this account may read and use: its own upload, or an instance-shared row (`user_id` null; imports from the catalog and providers). */
export const assetVisibleTo = (userId: string) => or(eq(schema.assets.userId, userId), isNull(schema.assets.userId))!;
