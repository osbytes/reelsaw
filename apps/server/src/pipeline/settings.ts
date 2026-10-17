/**
 * Settings for a new project: built-in defaults, then the user's saved defaults, then what the
 * form (or an agent) sent. One function so the web form, MCP and re-analyze agree.
 */
import { eq } from "drizzle-orm";
import { projectSettingsSchema, defaultProjectSettings, userProjectDefaultsSchema, type ProjectSettings, type UserProjectDefaults } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";

export async function userDefaults(db: Db, userId: string): Promise<UserProjectDefaults> {
  const row = await db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId), columns: { projectDefaults: true } });
  const parsed = userProjectDefaultsSchema.safeParse(row?.projectDefaults ?? {});
  return parsed.success ? parsed.data : {};
}

export async function resolveProjectSettings(db: Db, userId: string, input: Partial<ProjectSettings> | undefined): Promise<ProjectSettings> {
  const mine = await userDefaults(db, userId);
  // undefined values in the input must not shadow a saved default
  const given = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v !== undefined));
  return projectSettingsSchema.parse({ ...defaultProjectSettings, ...mine, ...given });
}
