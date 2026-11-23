import { useMemo, useState } from "react";
import { Link } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { formatNumber } from "@reelsaw/shared";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC, useTRPCClient } from "../lib/trpc";
import { ago } from "../lib/time";
import { ScrollArea, SECTION_LIST_MAX_H } from "./scroll-area";
import { PANEL_FOCUS_CLEARANCE } from "./StickyPanelFooter";
import { ConfirmDialog, Modal, Segmented, Select, Skeleton, SkeletonRegion } from "./ui";

type Rule = inferRouterOutputs<AppRouter>["admin"]["signupRules"]["list"]["rules"][number];
type Kind = Rule["kind"];
type Action = Rule["action"];

const KINDS: Array<{ value: Kind; label: MessageDescriptor; placeholder: MessageDescriptor | string }> = [
  { value: "ip", label: msg`Address or range`, placeholder: msg`203.0.113.7 or 203.0.113.0/24` },
  { value: "email", label: msg`Email pattern`, placeholder: "spam*@gmail.com" },
  { value: "domain", label: msg`Email domain`, placeholder: "example.com" },
  { value: "flag", label: msg`Abuse flag`, placeholder: "" },
];
const FLAGS: Array<{ value: string; label: MessageDescriptor }> = [
  { value: "shared_ip", label: msg`Shared address (3rd account in 7 days)` },
  { value: "signup_burst", label: msg`Burst (5th account in an hour)` },
  { value: "disposable_email", label: msg`Temporary email domain` },
];
const ACTIONS: Array<{ value: Action; label: MessageDescriptor; title: MessageDescriptor }> = [
  { value: "hold", label: msg`Hold`, title: msg`Needs approval; they are not told why` },
  { value: "block", label: msg`Block`, title: msg`The sign-up is refused` },
  { value: "allow", label: msg`Allow`, title: msg`Approved at once, even when sign-ups need approval` },
];
/** What the add button's action does, said beside it (the form is its own confirm). */
const EFFECT: Record<Action, MessageDescriptor> = {
  hold: msg`Matching sign-ups wait for approval and see only “waiting for approval”. Everyone else follows the sign-up mode.`,
  block: msg`Matching sign-ups are refused with a sentence that names no rule.`,
  allow: msg`Matching sign-ups are approved at once, even when sign-ups need approval. Pair an email or domain rule with email verification.`,
};
const TONE: Record<Action, string> = { hold: "text-warn", block: "text-err", allow: "text-ok" };
const KIND_WORD: Record<Kind, MessageDescriptor> = { ip: msg`address`, email: msg`email`, domain: msg`domain`, flag: msg`flag` };
/** The action as a word inside a sentence ("hold", "block", "allow"). */
const ACTION_WORD: Record<Action, MessageDescriptor> = { hold: msg`hold`, block: msg`block`, allow: msg`allow` };
/** The add button for each action. */
const ADD_LABEL: Record<Action, MessageDescriptor> = { hold: msg`Add hold rule`, block: msg`Add block rule`, allow: msg`Add allow rule` };
const tr_ = (d: MessageDescriptor | string) => (typeof d === "string" ? d : i18n._(d));
const actionLabel = (a: Action) => {
  const o = ACTIONS.find((x) => x.value === a);
  return o ? i18n._(o.label) : a;
};
const actionOptions = () => ACTIONS.map((a) => ({ value: a.value, label: i18n._(a.label), title: i18n._(a.title) }));
/** "hold address 203.0.113.7": a rule as it reads in a sentence. */
const ruleWords = (action: Action, kind: Kind, pattern: string) => {
  const a = i18n._(ACTION_WORD[action]);
  const k = i18n._(KIND_WORD[kind]);
  return t`${a} ${k} ${pattern}`;
};

/** A rule as the server names it ("ip 203.0.113.0/24"): what `user.held_by` stores and the Users filter matches (signup-rules.ts `ruleLabel`). */
export const ruleLabel = (r: { kind: Kind; pattern: string }) => `${r.kind} ${r.pattern}`;

/** The Users page filtered to the accounts a hold rule held. */
export const heldByHref = (label: string) => `/admin/users#${new URLSearchParams({ held: label }).toString()}`;

/**
 * Settings → System → Sign-up rules: the admin's firewall in front of SIGNUP_MODE (server: signup-rules.ts). Add a
 * rule, see what each one has caught, try an address against them, remove one (removing a hold or block asks first:
 * it lets those sign-ups in again). Same service as `list_signup_rules` / `manage_signup_rules` and `reelsaw signup-rules`.
 */
export function SignupRulesSection() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery(trpc.admin.signupRules.list.queryOptions());
  const [kind, setKind] = useState<Kind>("ip");
  const [pattern, setPattern] = useState("");
  const [flagValue, setFlagValue] = useState("shared_ip");
  const [action, setAction] = useState<Action>("hold");
  const [note, setNote] = useState("");
  const [removing, setRemoving] = useState<Rule | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [testIp, setTestIp] = useState("");
  const [asked, setAsked] = useState<{ email: string; ip?: string } | null>(null);
  const test = useQuery({
    ...trpc.admin.signupRules.list.queryOptions({ test: asked ?? { email: "" } }),
    enabled: !!asked,
    placeholderData: keepPreviousData,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: trpc.admin.signupRules.pathKey() });
  const change = useMutation(
    trpc.admin.signupRules.change.mutationOptions({
      onSuccess: (r) => {
        const added = r.added[0];
        const removed = r.removed[0];
        if (added) {
          const rule = ruleWords(added.action, added.kind, added.pattern);
          toast(t`Added: ${rule}. Applies to the next sign-up`);
          setPattern("");
          setNote("");
        } else if (removed) {
          const rule = ruleWords(removed.action, removed.kind, removed.pattern);
          toast(t`Removed: ${rule}`);
        }
        refresh();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rules = list.data?.rules ?? [];
  const value = kind === "flag" ? flagValue : pattern.trim();
  const add = () => change.mutate({ add: [{ kind, pattern: value, action, ...(note.trim() ? { note: note.trim() } : {}) }] });
  const remove = (r: Rule) => change.mutate({ remove: [r.id] });
  const runTest = () => {
    const email = testEmail.trim();
    if (!email) return;
    setAsked(testIp.trim() ? { email, ip: testIp.trim() } : { email });
  };
  const verdict = test.data?.test;
  const verdictRule = verdict?.rule ?? "";
  const alsoMatches = (verdict?.matched ?? [])
    .slice(1)
    .map((m) => m.rule)
    .join(", ");
  const verdictFlags = (verdict?.flags ?? []).join(", ");
  const removingTitle = (() => {
    if (!removing) return t`Remove this rule?`;
    const a = i18n._(ACTION_WORD[removing.action]);
    const k = i18n._(KIND_WORD[removing.kind]);
    const pat = removing.pattern;
    return t`Remove the ${a} rule for ${k} ${pat}?`;
  })();
  const kindOptions = KINDS.map((k) => ({ value: k.value, label: i18n._(k.label) }));
  const flagOptions = FLAGS.map((f) => ({ value: f.value, label: i18n._(f.label) }));
  const placeholder = KINDS.find((k) => k.value === kind)?.placeholder;
  const max = list.data?.max ?? 0;

  return (
    <section id="signup-rules" className={`flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5 ${PANEL_FOCUS_CLEARANCE}`}>
      <div>
        <h2 className="text-[15px] font-bold">
          <Trans>Sign-up rules</Trans>
        </h2>
        <p className="mt-0.5 text-sm text-ink2">
          <Trans>
            Hold, block or let in particular sign-ups by address, email, domain or abuse flag, whatever the sign-up mode says. Block beats allow beats hold. A
            held account sees the usual “waiting for approval” and is never told why. Rules apply to new sign-ups; for accounts that exist, use Require approval
            on the Users page.
          </Trans>
        </p>
      </div>

      <form
        className="flex flex-col gap-2 rounded-[12px] border border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) add();
        }}
      >
        <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)_auto]">
          <Select
            ariaLabel={t`What the rule matches`}
            value={kind}
            onValueChange={(v) => setKind(KINDS.find((k) => k.value === v)?.value ?? "ip")}
            options={kindOptions}
          />
          {kind === "flag" ? (
            <Select ariaLabel={t`Abuse flag`} value={flagValue} onValueChange={setFlagValue} options={flagOptions} />
          ) : (
            <input
              className="input"
              placeholder={placeholder === undefined ? undefined : tr_(placeholder)}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              maxLength={200}
              aria-label={t`Pattern`}
            />
          )}
          <Segmented ariaLabel={t`What a match does`} value={action} onChange={setAction} options={actionOptions()} />
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <input
            className="input"
            placeholder={t`Note for other admins (optional)`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            aria-label={t`Note`}
          />
          <button type="submit" className="btn-primary min-w-[8.5rem]" disabled={!value || change.isPending}>
            {i18n._(ADD_LABEL[action])}
          </button>
        </div>
        <p className="min-h-5 text-xs text-ink3">{i18n._(EFFECT[action])}</p>
      </form>

      {list.isPending ? (
        <SkeletonRegion label={t`Loading sign-up rules…`} className="flex flex-col divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 py-2.5">
              <Skeleton className="h-4 w-12" />
              <Skeleton className={`h-4 ${["w-48", "w-36", "w-56"][i]}`} />
              <Skeleton className="ms-auto h-8 w-20" />
            </div>
          ))}
        </SkeletonRegion>
      ) : list.error ? (
        <p className="text-sm text-err">{list.error.message}</p>
      ) : rules.length === 0 ? (
        <p className="py-2 text-sm text-ink3">
          <Trans>No rules yet: the sign-up mode decides every sign-up.</Trans>
        </p>
      ) : (
        <ScrollArea className={SECTION_LIST_MAX_H}>
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">
              <Trans>Sign-up rules, oldest first</Trans>
            </caption>
            <thead className="sticky top-0 bg-panel text-start text-xs text-ink3">
              <tr>
                <th scope="col" className="w-16 py-2 font-medium">
                  <Trans>Action</Trans>
                </th>
                <th scope="col" className="py-2 font-medium">
                  <Trans>Matches</Trans>
                </th>
                <th scope="col" className="w-24 py-2 text-end font-medium">
                  <Trans>Caught</Trans>
                </th>
                <th scope="col" className="w-24 py-2">
                  <span className="sr-only">
                    <Trans>Remove</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rules.map((r) => {
                const added = ago(r.createdAt);
                const by = r.createdBy;
                const lastHit = r.lastHitAt ? ago(r.lastHitAt) : "";
                return (
                  <tr key={r.id}>
                    <td className={`py-2.5 align-top font-semibold ${TONE[r.action]}`}>{actionLabel(r.action)}</td>
                    <td className="min-w-0 py-2.5 align-top">
                      <div className="truncate">
                        <span className="text-ink3">{i18n._(KIND_WORD[r.kind])} </span>
                        <span className="font-mono text-[13px]">{r.pattern}</span>
                      </div>
                      <div className="truncate text-xs text-ink3" title={r.note ?? undefined}>
                        {r.note ? `${r.note} · ` : ""}
                        {by ? t`added ${added} by ${by}` : t`added ${added}`}
                      </div>
                    </td>
                    <td className="py-2.5 text-end align-top tabular-nums" title={r.lastHitAt ? t`Last ${lastHit}` : t`Not yet`}>
                      {r.action === "hold" && r.hits > 0 ? (
                        <Link
                          to={heldByHref(ruleLabel(r))}
                          className="text-acc-text underline-offset-2 hover:underline"
                          title={t`See the accounts this rule held`}
                        >
                          {formatNumber(r.hits)}
                        </Link>
                      ) : (
                        formatNumber(r.hits)
                      )}
                      <div className="text-xs text-ink3">{r.lastHitAt ? lastHit : t`never`}</div>
                    </td>
                    <td className="py-2.5 text-end align-top">
                      <button
                        type="button"
                        className="btn-ghost h-8 w-20 text-xs"
                        disabled={change.isPending}
                        onClick={() => (r.action === "allow" ? remove(r) : setRemoving(r))}
                      >
                        <Trans>Remove</Trans>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollArea>
      )}
      {rules.length > 0 && list.data && rules.length >= list.data.max && (
        <p className="text-xs text-warn">
          <Trans>This is the most an instance keeps ({max}). Widen a rule (a range, a domain) to add another.</Trans>
        </p>
      )}

      <form
        className="flex flex-col gap-2 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          runTest();
        }}
      >
        <p className="text-xs font-semibold text-ink2">
          <Trans>Try a sign-up</Trans>
        </p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
          <input
            className="input"
            placeholder={t`someone@example.com`}
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            aria-label={t`Test email`}
          />
          <input
            className="input"
            placeholder={t`Address (optional)`}
            value={testIp}
            onChange={(e) => setTestIp(e.target.value)}
            aria-label={t`Test address`}
          />
          <button type="submit" className="btn-ghost min-w-[5rem]" disabled={!testEmail.trim() || test.isFetching}>
            <Trans>Try</Trans>
          </button>
        </div>
        <p className="min-h-5 text-xs" aria-live="polite">
          {test.error ? (
            <span className="text-err">{test.error.message}</span>
          ) : verdict ? (
            verdict.action ? (
              <>
                <span className={`font-semibold ${TONE[verdict.action]}`}>{i18n._(ACTION_WORD[verdict.action])}</span>
                <span className="text-ink2">
                  {" "}
                  <Trans>by {verdictRule}</Trans>
                </span>
                {verdict.matched.length > 1 && (
                  <span className="text-ink3">
                    {" "}
                    {"· "}
                    <Trans>also matches {alsoMatches}</Trans>
                  </span>
                )}
                {verdict.flags.length > 0 && (
                  <span className="text-ink3">
                    {" "}
                    {"· "}
                    <Trans>flags {verdictFlags}</Trans>
                  </span>
                )}
              </>
            ) : (
              <span className="text-ink2">
                <Trans>No rule matches: the sign-up mode decides.</Trans>
              </span>
            )
          ) : (
            <span className="text-ink3">
              <Trans>Checks the rules only; nobody is signed up.</Trans>
            </span>
          )}
        </p>
      </form>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removingTitle}
        body={
          removing?.action === "block"
            ? t`Sign-ups it refused can get in again, as the sign-up mode says. Accounts that exist are not changed.`
            : t`Sign-ups it held follow the sign-up mode again. Accounts already waiting for approval stay waiting.`
        }
        confirm={t`Remove rule`}
        onConfirm={() => (removing ? change.mutateAsync({ remove: [removing.id] }) : Promise.resolve())}
      />
    </section>
  );
}

/** The account a rule is being made from: what it signed up with. */
export type RuleSource = { id: string; email: string; signupIp: string | null; status: "pending" | "active" | "suspended"; role: "user" | "admin" };

/** The patterns an account offers, narrowest first: its address, that address's /24, its exact email, its domain. */
function candidates(u: RuleSource): Array<{ kind: Kind; pattern: string; label: string; hint: string }> {
  const out: Array<{ kind: Kind; pattern: string; label: string; hint: string }> = [];
  if (u.signupIp) {
    const ip = u.signupIp;
    out.push({ kind: "ip", pattern: ip, label: t`Address ${ip}`, hint: t`Every sign-up from this exact address` });
    const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(u.signupIp);
    if (v4) {
      const range = `${v4[1]}.0/24`;
      out.push({
        kind: "ip",
        pattern: range,
        label: t`Range ${range}`,
        hint: t`The 256 addresses around it, for a network that rotates addresses`,
      });
    }
  }
  const email = u.email.trim().toLowerCase();
  out.push({ kind: "email", pattern: email, label: t`Email ${email}`, hint: t`This mailbox again, with dots or +tags too` });
  const domain = email.split("@")[1];
  if (domain) out.push({ kind: "domain", pattern: domain, label: t`Domain ${domain}`, hint: t`Everyone at ${domain} and its subdomains` });
  return out;
}

/**
 * Users → ⋯ → Add sign-up rule…: a rule built from what this account signed up with (its address or range, its email,
 * its domain), and optionally this account sent back to approval in the same go. The same procedures as
 * Settings → Sign-up rules and Require approval.
 */
export function RuleFromUserDialog({ user, onClose }: { user: RuleSource; onClose: () => void }) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const options = useMemo(() => candidates(user), [user]);
  const [pick, setPick] = useState(0);
  const [action, setAction] = useState<Action>("hold");
  const userEmail = user.email;
  const [note, setNote] = useState(() => t`from ${userEmail}`);
  const canHold = user.status === "active" && user.role !== "admin";
  const [alsoHold, setAlsoHold] = useState(canHold);
  const holding = alsoHold && canHold && action !== "allow";
  const chosen = options[pick] ?? options[0]!;
  const save = useMutation({
    mutationFn: async () => {
      await client.admin.signupRules.change.mutate({
        add: [{ kind: chosen.kind, pattern: chosen.pattern, action, ...(note.trim() ? { note: note.trim() } : {}) }],
      });
      if (holding) await client.admin.users.hold.mutate({ id: user.id });
    },
    onSuccess: () => {
      const rule = ruleWords(action, chosen.kind, chosen.pattern);
      toast(holding ? t`Added: ${rule}. ${userEmail} waits for approval` : t`Added: ${rule}`);
      void qc.invalidateQueries({ queryKey: trpc.admin.signupRules.pathKey() });
      void qc.invalidateQueries({ queryKey: trpc.admin.users.pathKey() });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const why = user.role === "admin" ? t`Not for an admin.` : user.status === "pending" ? t`They are already waiting for approval.` : t`They are suspended.`;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t`Sign-up rule from ${userEmail}`} width={480}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1.5 text-xs font-semibold text-ink2">
            <Trans>Match</Trans>
          </legend>
          {options.map((o, i) => (
            <label key={o.label} className="flex cursor-pointer items-start gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-sunk">
              <input type="radio" name="rule-pattern" className="mt-1 accent-[var(--acc)]" checked={pick === i} onChange={() => setPick(i)} />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[13px]">{o.label}</span>
                <span className="block text-xs text-ink3">{o.hint}</span>
              </span>
            </label>
          ))}
          {!user.signupIp && (
            <p className="px-2 text-xs text-ink3">
              <Trans>No sign-up address was recorded for this account, so address rules are not offered.</Trans>
            </p>
          )}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink2">
            <Trans>Then</Trans>
          </span>
          <Segmented ariaLabel={t`What a match does`} value={action} onChange={setAction} options={actionOptions()} />
          <p className="min-h-8 text-xs text-ink3">{i18n._(EFFECT[action])}</p>
        </div>
        <input
          className="input"
          placeholder={t`Note for other admins (optional)`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          aria-label={t`Note`}
        />
        <label className={`flex items-start gap-2.5 text-sm ${canHold && action !== "allow" ? "cursor-pointer" : "opacity-50"}`}>
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[var(--acc)]"
            checked={holding}
            disabled={!canHold || action === "allow"}
            onChange={(e) => setAlsoHold(e.target.checked)}
          />
          <span>
            <Trans>Also require approval for this account</Trans>
            <span className="block text-xs text-ink3">
              {canHold ? t`Rules only apply to new sign-ups. This sends them back to “waiting for approval” now, without saying why.` : why}
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-quiet" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button type="submit" className="btn-primary min-w-[8.5rem]" disabled={save.isPending}>
            {i18n._(ADD_LABEL[action])}
          </button>
        </div>
      </form>
    </Modal>
  );
}
