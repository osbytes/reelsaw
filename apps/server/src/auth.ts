import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Config } from "./config.js";
import { schema, type Db } from "./db/index.js";

export function createAuth(config: Config, db: Db) {
  return betterAuth({
    baseURL: config.APP_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_URL, "http://localhost:5173"],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: schema.user, session: schema.session, account: schema.account, verification: schema.verification },
    }),
    emailAndPassword: { enabled: true, disableSignUp: !config.ALLOW_SIGNUP },
    session: { cookieCache: { enabled: true, maxAge: 60 } },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
