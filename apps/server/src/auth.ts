import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { apiKey } from "@better-auth/api-key";
import { captcha } from "better-auth/plugins/captcha";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { mcp } from "@better-auth/mcp";
import { eq, sql } from "drizzle-orm";
import { ACCOUNT_EXISTS_MESSAGE, MUST_CHANGE_PASSWORD_MESSAGE, PENDING_APPROVAL_MESSAGE, unverifiedSignInMessage } from "@reelsaw/shared";
import type { Config } from "./config.js";
import { schema, type Db } from "./db/index.js";
import type { Email } from "./email.js";
import { templates } from "./email.js";
import type { Logger } from "./log.js";
import type { InstanceSettings } from "./instance-settings.js";
import { clientIp, signupGuard, SignupRefused } from "./abuse.js";
import type { Telemetry } from "./telemetry.js";
import { FIRST_ADMIN_LOCK } from "./locks.js";
import { EMAIL_VERIFY_EXPIRES_IN_SEC, rememberEmailVerifyToken, withLoginCallback } from "./email-verify.js";

/** The MCP endpoint as OAuth clients see it (token audience). */
export const mcpResource = (config: Config) => new URL("/api/mcp", config.APP_URL).toString();

/** API keys look like `rs_…`; agents send them as `Authorization: Bearer rs_…` (or `x-api-key`). */
export const API_KEY_PREFIX = "rs_";

/** The one header Better Auth reads the client's address from (rate limits, session rows). Set by `withClientIp`, never by the client. */
export const CLIENT_IP_HEADER = "x-reelsaw-client-ip";

/**
 * The request as Better Auth should see it: the address resolved the way every other guard resolves it (abuse.ts `clientIp`,
 * TRUST_PROXY and the hop count) on CLIENT_IP_HEADER, and whatever the client sent there dropped. Better Auth on its own
 * only trusts a single-value X-Forwarded-For; behind a proxy that appends (Railway, Caddy) it found no address and put every
 * sign-in in one shared rate-limit bucket, so one noisy client could lock everyone out.
 */
export function withClientIp(req: Request, trust: Pick<Config, "TRUST_PROXY" | "TRUSTED_PROXY_HEADER" | "TRUSTED_PROXY_HOPS">): Request {
  const headers = new Headers(req.headers);
  headers.delete(CLIENT_IP_HEADER);
  const ip = clientIp(req.headers, trust);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return new Request(req, { headers });
}

export function createAuth(config: Config, db: Db, email: Email, log: Logger, settings: InstanceSettings, telemetry?: Telemetry) {
  // SIGNUP_MODE, REQUIRE_EMAIL_VERIFICATION and the captcha are runtime settings (instance-settings.ts):
  // read them at request time, never once here. Better Auth checks `emailAndPassword.*` on the options
  // object it was given, so those fields are kept current from the settings' subscription.
  const mode = () => settings.get().SIGNUP_MODE;
  const emailAndPassword = {
    enabled: true,
    disableSignUp: mode() === "closed",
    requireEmailVerification: settings.get().REQUIRE_EMAIL_VERIFICATION,
    // same window as confirmation: a delayed mailbox still works; the reset page offers a resend if it has expired
    resetPasswordTokenExpiresIn: EMAIL_VERIFY_EXPIRES_IN_SEC,
    revokeSessionsOnPasswordReset: true,
    // do not await: Better Auth only calls this when the account exists, so waiting on SMTP would leak that by timing
    ...(email.enabled
      ? {
          sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
            void email.send({ to: user.email, ...templates.resetPassword(url) });
          },
        }
      : {}),
    onPasswordReset: async ({ user }: { user: { id: string } }) => {
      log.info({ userId: user.id }, "password reset");
    },
  };
  const emailVerification = email.enabled
    ? {
        sendOnSignUp: settings.get().REQUIRE_EMAIL_VERIFICATION,
        autoSignInAfterVerification: true,
        expiresIn: EMAIL_VERIFY_EXPIRES_IN_SEC,
        sendVerificationEmail: async ({ user, url, token }: { user: { email: string }; url: string; token: string }) => {
          await rememberEmailVerifyToken(db, user.email, token);
          await email.send({ to: user.email, ...templates.verifyEmail(withLoginCallback(url)) });
        },
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
      return captcha({
        provider: s.CAPTCHA_PROVIDER,
        secretKey: s.CAPTCHA_SECRET_KEY,
        endpoints: ["/sign-up/email", "/sign-in/email", "/request-password-reset"],
      }).onRequest!(request, ctx);
    },
  };
  /** emails whose sign-up saw an empty user table; resolved in the `after` hook */
  const firstCandidates = new Set<string>();
  return betterAuth({
    baseURL: config.APP_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: config.NODE_ENV === "production" ? [config.APP_URL] : [config.APP_URL, "http://localhost:5173"],
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
        mustChangePassword: { type: "boolean", required: false, defaultValue: false, input: false },
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
            if (mode() === "closed") throw new APIError("UNPROCESSABLE_ENTITY", { message: "Sign-ups are closed on this Reelsaw." });
            // abuse guards (abuse.ts): accounts per address per day, temporary domains, one account per mailbox.
            // 422, not 403: with email verification on, Better Auth rewrites a 403 from this hook into a fake
            // success (no session, and the submitted password is not saved). The form looks like the sign-up
            // worked, and a password manager stores a password that is not the one in the database.
            const headers = ctx?.request?.headers ?? ctx?.headers ?? new Headers();
            let guard: { emailKey: string; signupIp: string | null };
            try {
              guard = await signupGuard(db, settings.get(), { email: user.email, ip: clientIp(headers, config) }, log);
            } catch (err) {
              if (err instanceof SignupRefused) throw new APIError("UNPROCESSABLE_ENTITY", { message: err.message });
              throw err;
            }
            const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.user);
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
            await db
              .insert(schema.adminEvents)
              .values({ type: "user.signed_up", userId: u.id, email: u.email, payload: { role: u.role ?? "user", approved: !!u.approvedAt, mode: mode() } });
            log.info({ userId: u.id, role: u.role ?? "user", approved: !!u.approvedAt, mode: mode() }, "sign-up");
            // id and role only: no email or name goes to PostHog
            telemetry?.identify(u.id, { role: u.role ?? "user" });
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
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
        if (!email) return;
        // Better Auth itself returns a 200 with a made-up user when this email already exists and
        // verification is required (or auto sign-in is off). The password from that request is hashed
        // and discarded. Refuse first. The sentence is the same whether the account is approved, pending or
        // suspended, so this form cannot be used to probe addresses; a pending or suspended account hears its own
        // reason on sign-in (below), once it has proved the password.
        const existing = await db.query.user.findFirst({
          where: eq(schema.user.email, email),
          columns: { id: true, approvedAt: true, banned: true, banReason: true },
        });
        if (!existing) return;
        log.warn({ userId: existing.id, pending: !existing.approvedAt, banned: existing.banned }, "sign-up refused: account already exists");
        throw new APIError("UNPROCESSABLE_ENTITY", { message: ACCOUNT_EXISTS_MESSAGE, code: "USER_ALREADY_EXISTS" });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email" || !isAPIError(ctx.context.returned)) return;
        const code = ctx.context.returned.body?.code;
        if (code !== "EMAIL_NOT_VERIFIED") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
        if (!email) return;
        // Password already matched. "Email not verified" hides a pending or suspended account; the
        // waiting page says the other sentence, and sign-in should too.
        const existing = await db.query.user.findFirst({
          where: eq(schema.user.email, email),
          columns: { id: true, approvedAt: true, banned: true, banReason: true },
        });
        const message = unverifiedSignInMessage(existing ? blockedReason(existing) : null);
        if (!message || !existing) return;
        log.info({ userId: existing.id, pending: !existing.approvedAt, banned: existing.banned }, "sign-in told the account why it cannot continue");
        throw new APIError("FORBIDDEN", { message, code: existing.banned ? "ACCOUNT_SUSPENDED" : "ACCOUNT_PENDING" });
      }),
    },
    session: { cookieCache: { enabled: true, maxAge: 60 } },
    // http.ts hands every request over through `withClientIp`
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
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
        // a key made through the plugin's own endpoint (not Settings, which sets permissions on the server) cannot administer the instance
        permissions: { defaultPermissions: { admin: [] } },
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
  via: "session" | "apikey" | "oauth";
  /**
   * May use instance-administration tools (settings, queue, failures). A browser session follows the account's
   * role; an OAuth connector never; an API key only with the `admin: ["write"]` permission (keys made before
   * permissions existed have no record and keep full access).
   */
  canAdminister: boolean;
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
  if (!u.approvedAt) return { kind: "pending", reason: PENDING_APPROVAL_MESSAGE };
  return null;
}

/**
 * Why this requester cannot use the app. Pending/suspended always; a browser session (or MCP
 * OAuth) also while they still owe a password after `reelsaw set-password --must-change`. API
 * keys skip that gate so an agent keeps working while the person chooses theirs.
 */
export function cannotUseApp(user: AuthUser, via: Requester["via"]): string | null {
  const blocked = blockedReason(user);
  if (blocked) return blocked.reason;
  if (via !== "apikey" && user.mustChangePassword) return MUST_CHANGE_PASSWORD_MESSAGE;
  return null;
}

/**
 * Who is making this request: the browser session (cookie) or an API key (bearer header).
 * Every HTTP route that serves user data goes through here, so agents using a key can do what
 * the web app can: tRPC, MCP, uploads and media downloads. The user row is always read fresh, so
 * a ban or an approval applies to the next request, not the next sign-in.
 */
export async function requester(auth: Auth, db: Db, headers: Headers, log?: Logger): Promise<Requester | null> {
  const token = bearerToken(headers);
  let userId: string | null = null;
  let via: Requester["via"] = "session";
  let keyAdmin = false;
  let session: Session | null = null;
  if (token && token.startsWith(API_KEY_PREFIX)) {
    const res = await auth.api.verifyApiKey({ body: { key: token } });
    if (!res.valid || !res.key) return null;
    userId = res.key.referenceId;
    via = "apikey";
    keyAdmin = apiKeyCanAdminister(res.key.permissions);
  } else {
    session = await auth.api.getSession({ headers });
    if (!session) return null;
    userId = session.user.id;
  }
  const user = await db.query.user.findFirst({ where: eq(schema.user.id, userId) });
  if (!user) return null;
  return { user, via, canAdminister: via === "session" || keyAdmin, session, blocked: blockedReason(user) };
}

export const ADMIN_REFUSED_MESSAGE = "This key cannot change instance settings. Create a key with instance administration enabled in Settings → API keys.";

/**
 * Keys carry `permissions` (Better Auth's apiKey plugin): `{ admin: ["write"] }` allows the admin tools, anything
 * else (including `{ admin: [] }`, what Settings stores by default, and no record at all) does not. Keys that predate
 * permissions were given `{ admin: ["write"] }` by migration 0048, so they work as before and the grant shows in
 * Settings, where it can be revoked.
 */
export function apiKeyCanAdminister(permissions: Record<string, string[]> | null | undefined): boolean {
  return permissions?.admin?.includes("write") ?? false;
}

/** `requester`, but only for accounts allowed to use the app. Pending, suspended, and must-change sessions get null. */
export async function activeRequester(auth: Auth, db: Db, headers: Headers): Promise<Requester | null> {
  const r = await requester(auth, db, headers);
  return r && !cannotUseApp(r.user, r.via) ? r : null;
}
