/**
 * Sign-up rules: the admin's firewall in front of SIGNUP_MODE. Each rule matches a sign-up by its address
 * (an IP or CIDR range), its email (a glob), its email domain, or an abuse flag worked out at that moment, and
 * says what a match does:
 *
 *   - hold: the account is created but waits for an admin, exactly like SIGNUP_MODE=approval. It sees the same
 *     "waiting for approval" page and is never told why; the rule is kept on the row (`user.held_by`) for admins.
 *   - block: the sign-up is refused with a sentence that names no rule.
 *   - allow: approved at once, even with SIGNUP_MODE=approval (a team's own domain on a private box).
 *
 * Precedence, one chain (PRINCIPLES: "One precedence chain per setting"): SIGNUP_MODE=closed refuses everyone;
 * the first account is always the admin; then block, then allow, then hold; no match follows SIGNUP_MODE. The
 * hard guards in abuse.ts (`signupGuard`: per-address cap, temporary domains, one account per mailbox) run
 * first and are not rules.
 *
 * Rules act at sign-up only. An account that exists is sent back to approval by an admin (`holdUser` in
 * accounts.ts), never by a rule added later. One implementation behind every surface: the admin router, the
 * MCP tools (list_signup_rules, manage_signup_rules), and `reelsaw signup-rules`.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { schema, type Db } from "./db/index.js";
import type { SignupRuleRow } from "./db/schema.js";
import type { Services } from "./services.js";
import type { Logger } from "./log.js";
import { ABUSE_FLAGS, type AbuseFlag, BURST_ACCOUNTS, emailDomain, emailKey, isDisposable, SHARED_IP_ACCOUNTS, SHARED_IP_DAYS } from "./abuse.js";
import { takeTxLock, txLock } from "./locks.js";
import { globMatch } from "./lib/glob.js";
import { formatRange, inRange, parseIp, parseRange } from "./lib/ip.js";
import { MAX_SIGNUP_RULES, type ListSignupRulesInput, type ManageSignupRulesInput, type SignupRuleAction, type SignupRuleKind } from "./signup-rules-schema.js";

export type SignupRule = Pick<SignupRuleRow, "id" | "kind" | "pattern" | "action">;

/** Who changed the rules: an admin, or the operator CLI (`{ id: "cli", email: "cli" }`, as instance settings do). */
export type RulesActor = { id: string; email: string };

/** The message a blocked sign-up sees. It names no rule, so the form cannot be used to map the rules. */
export const SIGNUP_BLOCKED_MESSAGE = "This sign-up cannot be accepted. If you think that is a mistake, contact whoever runs this Reelsaw.";

/** How a rule reads in a list, a log line, an event and `user.held_by`: "ip 203.0.113.0/24". */
export const ruleLabel = (r: Pick<SignupRule, "kind" | "pattern">) => `${r.kind} ${r.pattern}`;

const isFlag = (v: string): v is AbuseFlag => ABUSE_FLAGS.some((f) => f === v);

/**
 * The pattern as stored, or a sentence saying what is wrong with it. Emails and domains are lower-case (sign-ups
 * are compared lower-case); an address or range is canonical (host bits cleared, RFC 5952 IPv6, an IPv4-mapped
 * range as IPv4), so one network is one pattern and the unique index and `held_by` agree on it.
 */
export function normalizePattern(kind: SignupRuleKind, raw: string): { pattern: string } | { error: string } {
  const p = raw.trim().toLowerCase();
  switch (kind) {
    case "ip": {
      const range = parseRange(p);
      return "error" in range ? { error: range.error.replace(`“${p}”`, `“${raw.trim()}”`) } : { pattern: formatRange(range) };
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+$/.test(p)) return { error: `“${raw}” is not an email pattern. Use name@domain, with * for any characters (spam*@gmail.com).` };
      if (/^\*+@\*+$/.test(p)) return { error: "That pattern matches every address. Change SIGNUP_MODE instead." };
      return { pattern: p };
    }
    case "domain": {
      const d = p.replace(/^@/, "").replace(/^\*\./, "");
      if (!/^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(d)) return { error: `“${raw}” is not an email domain (example.com).` };
      return { pattern: d };
    }
    case "flag":
      return isFlag(p) ? { pattern: p } : { error: `“${raw}” is not a flag. Use one of: ${ABUSE_FLAGS.join(", ")}.` };
  }
}

/** What the rules know about one sign-up. `flags` is only needed when a flag rule exists. */
export type SignupFacts = { email: string; ip: string | null; flags: readonly AbuseFlag[] };

/** A rule's test, built once per pattern: parsing a range or splitting a glob is not redone for every sign-up. */
type Matcher = (facts: SignupFacts) => boolean;
const compiled = new Map<string, Matcher>();

function compile(rule: Pick<SignupRule, "kind" | "pattern">): Matcher {
  switch (rule.kind) {
    case "ip": {
      const range = parseRange(rule.pattern);
      if ("error" in range) return () => false; // stored patterns are canonical; an old or hand-edited row matches nothing
      return (f) => !!f.ip && inRange(range, f.ip);
    }
    case "email":
      // the address as typed, and the mailbox it really is (gmail dots and +tags folded), so `a.b+x@gmail.com` cannot dodge `ab*@gmail.com`
      return (f) => {
        const email = f.email.trim().toLowerCase();
        return globMatch(rule.pattern, email) || globMatch(rule.pattern, emailKey(email));
      };
    case "domain":
      return (f) => {
        const d = emailDomain(f.email);
        return d === rule.pattern || d.endsWith(`.${rule.pattern}`);
      };
    case "flag":
      return (f) => f.flags.some((x) => x === rule.pattern);
  }
}

function matches(rule: SignupRule, facts: SignupFacts): boolean {
  const key = ruleLabel(rule);
  let m = compiled.get(key);
  if (!m) {
    if (compiled.size >= MAX_SIGNUP_RULES * 2) compiled.clear(); // removed rules' matchers go with the next refill
    m = compile(rule);
    compiled.set(key, m);
  }
  return m(facts);
}

const ORDER: Record<SignupRuleAction, number> = { block: 0, allow: 1, hold: 2 };

export type SignupDecision = {
  /** what happens: null = no rule matched, SIGNUP_MODE decides */
  action: SignupRuleAction | null;
  /** the rule that decided (the oldest of the winning action) */
  rule: SignupRule | null;
  /** every rule that matched, deciding one first */
  matched: SignupRule[];
};

/** Pure: which rule decides this sign-up. block beats allow beats hold; among equals, the oldest (the list's order). */
export function decideSignup(rules: readonly SignupRule[], facts: SignupFacts): SignupDecision {
  const matched = rules.filter((r) => matches(r, facts)).sort((a, b) => ORDER[a.action] - ORDER[b.action]);
  const rule = matched[0] ?? null;
  return { action: rule?.action ?? null, rule, matched };
}

/**
 * The abuse flags of a sign-up that has not happened yet, on the hourly pass's own definitions (`flagAccounts`,
 * constants in abuse.ts): this would be the SHARED_IP_ACCOUNTS-th account from the address within SHARED_IP_DAYS
 * (shared_ip), the BURST_ACCOUNTS-th in the same clock hour (signup_burst), or a temporary domain. One indexed
 * count (`user_signup_ip_idx`).
 */
export async function signupFlags(db: Db, email: string, ip: string | null): Promise<AbuseFlag[]> {
  const flags: AbuseFlag[] = [];
  if (ip) {
    const [row] = await db
      .select({
        week: sql<number>`count(*)::int`,
        hour: sql<number>`(count(*) filter (where date_trunc('hour', ${schema.user.createdAt}) = date_trunc('hour', now())))::int`,
      })
      .from(schema.user)
      .where(and(eq(schema.user.signupIp, ip), gte(schema.user.createdAt, sql`now() - make_interval(days => ${SHARED_IP_DAYS})`)));
    // the counts are of earlier accounts; this sign-up would be one more
    if ((row?.week ?? 0) + 1 >= SHARED_IP_ACCOUNTS) flags.push("shared_ip");
    if ((row?.hour ?? 0) + 1 >= BURST_ACCOUNTS) flags.push("signup_burst");
  }
  if (isDisposable(email)) flags.push("disposable_email");
  return flags;
}

async function allRules(db: Db): Promise<SignupRuleRow[]> {
  return db.select().from(schema.signupRules).orderBy(asc(schema.signupRules.createdAt), asc(schema.signupRules.id)).limit(MAX_SIGNUP_RULES);
}

/** The facts and decision for a sign-up: what the create hook acts on and what `test` reports. Reads nothing more when there are no rules. */
export async function evaluateSignup(db: Db, input: { email: string; ip: string | null }): Promise<SignupDecision & { flags: AbuseFlag[] }> {
  const rules = await allRules(db);
  if (!rules.length) return { action: null, rule: null, matched: [], flags: [] };
  const flags = rules.some((r) => r.kind === "flag") ? await signupFlags(db, input.email, input.ip) : [];
  return { ...decideSignup(rules, { email: input.email, ip: input.ip, flags }), flags };
}

/**
 * Called from the Better Auth create hook (auth.ts) before the user row is inserted. Returns the decision; the
 * caller refuses a block and stores a hold, and counts the hit (`countRuleHit`) once the outcome is real: a
 * block at once, a hold or allow after the account exists. Never fails a sign-up for itself: if the rules cannot
 * be read, it logs and lets SIGNUP_MODE decide.
 */
export async function applySignupRules(db: Db, input: { email: string; ip: string | null }, log: Logger): Promise<SignupDecision> {
  let d: SignupDecision & { flags: AbuseFlag[] };
  try {
    d = await evaluateSignup(db, input);
  } catch (err) {
    log.warn({ err }, "sign-up rules unreadable; following SIGNUP_MODE");
    return { action: null, rule: null, matched: [] };
  }
  if (d.rule) log.info({ ruleId: d.rule.id, rule: ruleLabel(d.rule), action: d.action, ip: input.ip, flags: d.flags }, "sign-up rule matched");
  return d;
}

/** One more sign-up a rule decided (the "Caught" count). Best effort: a missed count never fails a sign-up. */
export async function countRuleHit(db: Db, ruleId: string, log: Logger): Promise<void> {
  await db
    .update(schema.signupRules)
    .set({ hits: sql`${schema.signupRules.hits} + 1`, lastHitAt: new Date() })
    .where(eq(schema.signupRules.id, ruleId))
    .catch((err: unknown) => log.warn({ err, ruleId }, "sign-up rule hit not counted"));
}

const ruleOut = (r: SignupRuleRow) => ({
  id: r.id,
  kind: r.kind,
  pattern: r.pattern,
  action: r.action,
  note: r.note,
  createdBy: r.createdBy,
  hits: r.hits,
  lastHitAt: r.lastHitAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Every rule, oldest first (the order ties are broken in), and, with `test`, what they would do to that sign-up.
 * The list is whole: at most MAX_SIGNUP_RULES exist.
 */
export async function listSignupRules(svc: Pick<Services, "database">, input?: ListSignupRulesInput) {
  const db = svc.database.db;
  const rules = await allRules(db);
  const t = input?.test;
  const test = t
    ? await (async () => {
        const ip = t.ip?.trim() || null;
        if (ip && !parseIp(ip)) throw new TRPCError({ code: "BAD_REQUEST", message: `“${ip}” is not an IP address.` });
        const d = await evaluateSignup(db, { email: t.email, ip });
        return {
          email: t.email,
          ip,
          action: d.action,
          rule: d.rule ? ruleLabel(d.rule) : null,
          matched: d.matched.map((r) => ({ id: r.id, rule: ruleLabel(r), action: r.action })),
          flags: d.flags,
        };
      })()
    : null;
  return { rules: rules.map(ruleOut), max: MAX_SIGNUP_RULES, test };
}

/**
 * Add and remove rules in one unit of work with one `signup_rules.changed` event. A pattern that does not parse,
 * a duplicate (same kind and pattern) or going past MAX_SIGNUP_RULES refuses the whole call with a sentence.
 */
export async function changeSignupRules(svc: Pick<Services, "tx">, actor: RulesActor, input: ManageSignupRulesInput) {
  const add = (input.add ?? []).map((r) => {
    const n = normalizePattern(r.kind, r.pattern);
    if ("error" in n) throw new TRPCError({ code: "BAD_REQUEST", message: n.error });
    return { ...r, pattern: n.pattern, note: r.note?.trim() || null };
  });
  const seen = new Set<string>();
  for (const r of add) {
    const k = ruleLabel(r);
    if (seen.has(k)) throw new TRPCError({ code: "BAD_REQUEST", message: `${k} is listed twice.` });
    seen.add(k);
  }
  const removeIds = [...new Set(input.remove ?? [])];
  return svc.tx(async (u) => {
    await takeTxLock(u.db, txLock.signupRules());
    const removed = removeIds.length ? await u.db.delete(schema.signupRules).where(inArray(schema.signupRules.id, removeIds)).returning() : [];
    if (removed.length < removeIds.length) {
      const gone = removeIds.filter((id) => !removed.some((r) => r.id === id));
      throw new TRPCError({ code: "NOT_FOUND", message: `No such rule: ${gone.join(", ")}` });
    }
    const existing = await u.db.select().from(schema.signupRules);
    if (existing.length + add.length > MAX_SIGNUP_RULES)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `An instance keeps at most ${MAX_SIGNUP_RULES} sign-up rules. Remove some first, or widen one (a range, a domain).`,
      });
    for (const r of add) {
      const dup = existing.find((e) => e.kind === r.kind && e.pattern === r.pattern);
      if (dup)
        throw new TRPCError({
          code: "CONFLICT",
          message: `There is already a rule for ${ruleLabel(r)} (${dup.action}). Remove it first to change what it does.`,
        });
    }
    const added = add.length
      ? await u.db
          .insert(schema.signupRules)
          .values(add.map((r) => ({ id: randomUUID(), kind: r.kind, pattern: r.pattern, action: r.action, note: r.note, createdBy: actor.email })))
          .returning()
      : [];
    await u.emit(
      "signup_rules.changed",
      {
        userId: actor.id,
        email: actor.email,
        added: added.map((r) => ({ id: r.id, rule: ruleLabel(r), action: r.action })),
        removed: removed.map((r) => ({ id: r.id, rule: ruleLabel(r), action: r.action })),
      },
      { actorId: actor.id === "cli" ? null : actor.id },
    );
    return { added: added.map(ruleOut), removed: removed.map(ruleOut) };
  });
}
