import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { captcha } from "better-auth/plugins/captcha";
import { APIError } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { mcp } from "@better-auth/mcp";
import { eq, sql } from "drizzle-orm";
import type { Config } from "./config.js";
import { schema, type Db } from "./db/index.js";
import type { Email } from "./email.js";
import { templates } from "./email.js";
import type { Logger } from "./log.js";
import type { InstanceSettings } from "./instance-settings.js";
import { clientIp, signupGuard, SignupRefused } from "./abuse.js";
import type { Telemetry } from "./telemetry.js";

/** The MCP endpoint as OAuth clients see it (token audience). */
export const mcpResource = (config: Config) => new URL("/api/mcp", config.APP_URL).toString();

/** API keys look like `rs_…`; agents send them as `Authorization: Bearer rs_…` (or `x-api-key`). */
export const API_KEY_PREFIX = "rs_";

/** Serialises the "first account becomes admin" decision (arbitrary constant, used only here). */
const FIRST_ADMIN_LOCK = 7_203_104_001;

export function createAuth(config: Config, db: Db, email: Email, log: Logger, settings: InstanceSettings, telemetry?: Telemetry) {
  // SIGNUP_MODE, REQUIRE_EMAIL_VERIFICATION and the captcha are runtime settings (instance-settings.ts):
  // read them at request time, never once here. Better Auth checks `emailAndPassword.*` on the options
  // object it was given, so those fields are kept current from the settings' subscription.
  const mode = () => settings.get().SIGNUP_MODE;
  const emailAndPassword = {
    enabled: true,
    disableSignUp: mode() === "closed",
    requireEmailVerification: settings.get().REQUIRE_EMAIL_VERIFICATION,
    sendResetPassword: email.enabled ? async ({ user, url }: { user: { email: string }; url: string }) => email.send({ to: user.email, ...templates.resetPassword(url) }) : undefined,
  };
  const emailVerification = email.enabled
    ? {
        sendOnSignUp: settings.get().REQUIRE_EMAIL_VERIFICATION,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => email.send({ to: user.email, ...templates.verifyEmail(url) }),
      }
    : undefined;
  settings.subscribe((s) => {
    emailAndPassword.disableSignUp = s.SIGNUP_MODE === "closed";
    emailAndPassword.requireEmailVerification = s.REQUIRE_EMAIL_VERIFICATION;
    if (emailVerification) emailVerification.sendOnSignUp = s.REQUIRE_EMAIL_VERIFICATION;
  });
  /** Bot protection whose provider and keys can change at runtime: a fresh captcha plugin per request, or nothing. */
  const captchaGate: BetterAuthPlugin = {
    id: "captcha",
    onRequest: async (request, ctx) => {
      const s = settings.get();
      if (!s.CAPTCHA_PROVIDER || !s.CAPTCHA_SITE_KEY || !s.CAPTCHA_SECRET_KEY) return;
      return captcha({ provider: s.CAPTCHA_PROVIDER, secretKey: s.CAPTCHA_SECRET_KEY, endpoints: ["/sign-up/email", "/sign-in/email", "/request-password-reset"] }).onRequest!(request, ctx);
    },
  };
  /** emails whose sign-up saw an empty user table; resolved in the `after` hook */
  const firstCandidates = new Set<string>();
  return betterAuth({
    baseURL: config.APP_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_URL, "http://localhost:5173"],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        apikey: schema.apikey,
        jwks: schema.jwks,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    user: {
      // set by the server only (input: false): a sign-up request cannot choose its role or approve itself
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "user", input: false },
        approvedAt: { type: "date", required: false, input: false },
        banned: { type: "boolean", required: false, defaultValue: false, input: false },
        banReason: { type: "string", required: false, input: false },
        emailKey: { type: "string", required: false, input: false },
        signupIp: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            log.info({ userId: (session as { userId?: string }).userId }, "sign-in");
          },
        },
      },
      user: {
        create: {
          // the first account administers the box; later ones follow SIGNUP_MODE. Count-then-insert
          // races (two concurrent first sign-ups both see zero users), so a "first" candidate is
          // inserted as a plain user and promoted in `after` by one conditional update under a lock.
          before: async (user, ctx) => {
            // checked here, at request time, so closing sign-ups applies to the next request without a restart
            if (mode() === "closed") throw new APIError("FORBIDDEN", { message: "Sign-ups are closed on this Reelsaw." });
            // abuse guards (abuse.ts): accounts per address per day, temporary domains, one account per mailbox
            const headers = ctx?.request?.headers ?? ctx?.headers ?? new Headers();
            let guard: { emailKey: string; signupIp: string | null };
            try {
              guard = await signupGuard(db, settings.get(), { email: user.email, ip: clientIp(headers, config.TRUST_PROXY) }, log);
            } catch (err) {
              if (err instanceof SignupRefused) throw new APIError("FORBIDDEN", { message: err.message });
              throw err;
            }
            const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.user);
            const first = n === 0;
            if (first) firstCandidates.add(user.email);
            return { data: { ...user, ...guard, role: "user", approvedAt: first || mode() === "open" ? new Date() : null } };
          },
          // Better Auth owns the user insert, so this audit row cannot share its transaction. It is a
          // record of something that did happen; nothing reads it to decide state (the Users page
          // and the gate read the user row). Admin actions in accounts.ts commit row + event together.
          after: async (user) => {
            let u = user as typeof user & { role?: string; approvedAt?: Date | null };
            if (firstCandidates.delete(u.email)) {
              const won = await db.transaction(async (tx) => {
                await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
                const promoted = await tx.execute(
                  sql`update "user" set role = 'admin' where id = ${u.id} and not exists (select 1 from "user" where role = 'admin') returning id`,
                );
                if (promoted.rows.length === 0 && mode() !== "open") await tx.update(schema.user).set({ approvedAt: null }).where(eq(schema.user.id, u.id));
                return promoted.rows.length > 0;
              });
              u = { ...u, role: won ? "admin" : "user", approvedAt: won || mode() === "open" ? (u.approvedAt ?? new Date()) : null };
            }
            await db.insert(schema.adminEvents).values({ type: "user.signed_up", userId: u.id, email: u.email, payload: { role: u.role ?? "user", approved: !!u.approvedAt, mode: mode() } });
            log.info({ userId: u.id, role: u.role ?? "user", approved: !!u.approvedAt, mode: mode() }, "sign-up");
            telemetry?.identify(u.id, { email: u.email, name: u.name, role: u.role ?? "user" });
            telemetry?.capture("user.signed_up", u.id, { mode: mode(), approved: !!u.approvedAt });
            if (u.approvedAt) return;
            const admins = await db.query.user.findMany({ where: eq(schema.user.role, "admin"), columns: { email: true } });
            for (const a of admins) void email.send({ to: a.email, ...templates.waitingForApproval(config.APP_URL, u.name, u.email) });
          },
        },
      },
    },
    emailAndPassword,
    emailVerification,
    session: { cookieCache: { enabled: true, maxAge: 60 } },
    plugins: [
      captchaGate,
      // MCP over OAuth 2.1: Reelsaw is the authorization server; connectors register themselves (DCR), the
      // user signs in and consents in the browser. API keys keep working for CLIs regardless.
      ...(config.MCP_OAUTH
        ? [
            jwt(),
            mcp({
              loginPage: "/login",
              consentPage: "/consent",
              resource: mcpResource(config),
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              scopes: ["openid", "profile", "email", "offline_access"],
              clientRegistrationDefaultScopes: ["openid", "profile", "email", "offline_access"],
              accessTokenExpiresIn: 3600,
              refreshTokenExpiresIn: 60 * 60 * 24 * 30,
            }),
          ]
        : []),
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        requireName: true,
        // keys are created from the Settings page; a key never mints a browser session
        enableSessionForAPIKeys: false,
        // the plugin's default is 10 requests/day, meant for public APIs; an agent driving a project does far more
        rateLimit: { enabled: false },
        keyExpiration: { defaultExpiresIn: null },
        startingCharactersConfig: { shouldStore: true, charactersLength: 8 },
      }),
    ],
    logger: {
      log: (level, message, ...args) => {
        const l = level === "error" ? "error" : level === "warn" ? "warn" : "debug";
        log[l]({ args: args.length ? args : undefined }, `better-auth: ${message}`);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
/** The user row as every route sees it (session or API key). */
export type AuthUser = typeof schema.user.$inferSelect;

export type Requester = {
  user: AuthUser;
  via: "session" | "apikey";
  session: Session | null;
  /** Signed in, but not allowed to use the app yet / any more. `reason` is a sentence for the user. */
  blocked: null | { kind: "pending" | "banned"; reason: string };
};

export function bearerToken(headers: Headers): string | null {
  const h = headers.get("authorization");
  if (h && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, "").trim();
  return headers.get("x-api-key");
}

export function blockedReason(u: Pick<AuthUser, "approvedAt" | "banned" | "banReason">): Requester["blocked"] {
  if (u.banned) return { kind: "banned", reason: u.banReason ? `This account is suspended: ${u.banReason}` : "This account is suspended." };
  if (!u.approvedAt) return { kind: "pending", reason: "Your account is waiting for an admin to approve it." };
  return null;
}

/**
 * Who is making this request: the browser session (cookie) or an API key (bearer header).
 * Every HTTP route that serves user data goes through here, so agents using a key can do what
 * the web app can: tRPC, MCP, uploads and media downloads. The user row is always read fresh, so
 * a ban or an approval applies to the next request, not the next sign-in.
 */
export async function requester(auth: Auth, db: Db, headers: Headers): Promise<Requester | null> {
  const token = bearerToken(headers);
  let userId: string | null = null;
  let via: Requester["via"] = "session";
  let session: Session | null = null;
  if (token && token.startsWith(API_KEY_PREFIX)) {
    const res = await auth.api.verifyApiKey({ body: { key: token } });
    if (!res.valid || !res.key) return null;
    userId = res.key.referenceId;
    via = "apikey";
  } else {
    session = await auth.api.getSession({ headers });
    if (!session) return null;
    userId = session.user.id;
  }
  const user = await db.query.user.findFirst({ where: eq(schema.user.id, userId) });
  if (!user) return null;
  return { user, via, session, blocked: blockedReason(user) };
}

/** `requester`, but only for accounts allowed to use the app. Pending and suspended accounts get null. */
export async function activeRequester(auth: Auth, db: Db, headers: Headers): Promise<Requester | null> {
  const r = await requester(auth, db, headers);
  return r && !r.blocked ? r : null;
}
