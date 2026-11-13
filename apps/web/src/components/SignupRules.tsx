import { useMemo, useState } from "react";
import { Link } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC, useTRPCClient } from "../lib/trpc";
import { ago } from "../lib/time";
import { ScrollArea } from "./scroll-area";
import { PANEL_FOCUS_CLEARANCE } from "./StickyPanelFooter";
import { ConfirmDialog, Modal, Segmented, Select, Skeleton, SkeletonRegion } from "./ui";

type Rule = inferRouterOutputs<AppRouter>["admin"]["signupRules"]["list"]["rules"][number];
type Kind = Rule["kind"];
type Action = Rule["action"];

const KINDS: Array<{ value: Kind; label: string; placeholder: string }> = [
  { value: "ip", label: "Address or range", placeholder: "203.0.113.7 or 203.0.113.0/24" },
  { value: "email", label: "Email pattern", placeholder: "spam*@gmail.com" },
  { value: "domain", label: "Email domain", placeholder: "example.com" },
  { value: "flag", label: "Abuse flag", placeholder: "" },
];
const FLAGS = [
  { value: "shared_ip", label: "Shared address (3rd account in 7 days)" },
  { value: "signup_burst", label: "Burst (5th account in an hour)" },
  { value: "disposable_email", label: "Temporary email domain" },
];
const ACTIONS: Array<{ value: Action; label: string; title: string }> = [
  { value: "hold", label: "Hold", title: "Needs approval; they are not told why" },
  { value: "block", label: "Block", title: "The sign-up is refused" },
  { value: "allow", label: "Allow", title: "Approved at once, even when sign-ups need approval" },
];
/** What the add button's action does, said beside it (the form is its own confirm). */
const EFFECT: Record<Action, string> = {
  hold: "Matching sign-ups wait for approval and see only “waiting for approval”. Everyone else follows the sign-up mode.",
  block: "Matching sign-ups are refused with a sentence that names no rule.",
  allow: "Matching sign-ups are approved at once, even when sign-ups need approval. Pair an email or domain rule with email verification.",
};
const TONE: Record<Action, string> = { hold: "text-warn", block: "text-err", allow: "text-ok" };
const KIND_WORD: Record<Kind, string> = { ip: "address", email: "email", domain: "domain", flag: "flag" };

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
        if (r.added[0]) {
          toast(`Added: ${r.added[0].action} ${r.added[0].kind} ${r.added[0].pattern}. Applies to the next sign-up`);
          setPattern("");
          setNote("");
        } else if (r.removed[0]) toast(`Removed: ${r.removed[0].action} ${r.removed[0].kind} ${r.removed[0].pattern}`);
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

  return (
    <section id="signup-rules" className={`flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5 ${PANEL_FOCUS_CLEARANCE}`}>
      <div>
        <h2 className="text-[15px] font-bold">Sign-up rules</h2>
        <p className="mt-0.5 text-sm text-ink2">
          Hold, block or let in particular sign-ups by address, email, domain or abuse flag, whatever the sign-up mode says. Block beats allow beats hold. A
          held account sees the usual “waiting for approval” and is never told why. Rules apply to new sign-ups; for accounts that exist, use Require approval
          on the Users page.
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
            ariaLabel="What the rule matches"
            value={kind}
            onValueChange={(v) => setKind(KINDS.find((k) => k.value === v)?.value ?? "ip")}
            options={KINDS}
          />
          {kind === "flag" ? (
            <Select ariaLabel="Abuse flag" value={flagValue} onValueChange={setFlagValue} options={FLAGS} />
          ) : (
            <input
              className="input"
              placeholder={KINDS.find((k) => k.value === kind)?.placeholder}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              maxLength={200}
              aria-label="Pattern"
            />
          )}
          <Segmented ariaLabel="What a match does" value={action} onChange={setAction} options={ACTIONS} />
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <input
            className="input"
            placeholder="Note for other admins (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            aria-label="Note"
          />
          <button type="submit" className="btn-primary min-w-[8.5rem]" disabled={!value || change.isPending}>
            Add {action} rule
          </button>
        </div>
        <p className="min-h-5 text-xs text-ink3">{EFFECT[action]}</p>
      </form>

      {list.isPending ? (
        <SkeletonRegion label="Loading sign-up rules…" className="flex flex-col divide-y divide-line">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 py-2.5">
              <Skeleton className="h-4 w-12" />
              <Skeleton className={`h-4 ${["w-48", "w-36", "w-56"][i]}`} />
              <Skeleton className="ml-auto h-8 w-20" />
            </div>
          ))}
        </SkeletonRegion>
      ) : list.error ? (
        <p className="text-sm text-err">{list.error.message}</p>
      ) : rules.length === 0 ? (
        <p className="py-2 text-sm text-ink3">No rules yet: the sign-up mode decides every sign-up.</p>
      ) : (
        <ScrollArea className="max-h-[26rem]">
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">Sign-up rules, oldest first</caption>
            <thead className="sticky top-0 bg-panel text-left text-xs text-ink3">
              <tr>
                <th scope="col" className="w-16 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="py-2 font-medium">
                  Matches
                </th>
                <th scope="col" className="w-24 py-2 text-right font-medium">
                  Caught
                </th>
                <th scope="col" className="w-24 py-2">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className={`py-2.5 align-top font-semibold capitalize ${TONE[r.action]}`}>{r.action}</td>
                  <td className="min-w-0 py-2.5 align-top">
                    <div className="truncate">
                      <span className="text-ink3">{KIND_WORD[r.kind]} </span>
                      <span className="font-mono text-[13px]">{r.pattern}</span>
                    </div>
                    <div className="truncate text-xs text-ink3" title={r.note ?? undefined}>
                      {r.note ? `${r.note} · ` : ""}added {ago(r.createdAt)}
                      {r.createdBy ? ` by ${r.createdBy}` : ""}
                    </div>
                  </td>
                  <td className="py-2.5 text-right align-top tabular-nums" title={r.lastHitAt ? `Last ${ago(r.lastHitAt)}` : "Not yet"}>
                    {r.action === "hold" && r.hits > 0 ? (
                      <Link to={heldByHref(ruleLabel(r))} className="text-acc-text underline-offset-2 hover:underline" title="See the accounts this rule held">
                        {r.hits.toLocaleString()}
                      </Link>
                    ) : (
                      r.hits.toLocaleString()
                    )}
                    <div className="text-xs text-ink3">{r.lastHitAt ? ago(r.lastHitAt) : "never"}</div>
                  </td>
                  <td className="py-2.5 text-right align-top">
                    <button
                      type="button"
                      className="btn-ghost h-8 w-20 text-xs"
                      disabled={change.isPending}
                      onClick={() => (r.action === "allow" ? remove(r) : setRemoving(r))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
      {rules.length > 0 && list.data && rules.length >= list.data.max && (
        <p className="text-xs text-warn">This is the most an instance keeps ({list.data.max}). Widen a rule (a range, a domain) to add another.</p>
      )}

      <form
        className="flex flex-col gap-2 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          runTest();
        }}
      >
        <p className="text-xs font-semibold text-ink2">Try a sign-up</p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
          <input className="input" placeholder="someone@example.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} aria-label="Test email" />
          <input className="input" placeholder="Address (optional)" value={testIp} onChange={(e) => setTestIp(e.target.value)} aria-label="Test address" />
          <button type="submit" className="btn-ghost min-w-[5rem]" disabled={!testEmail.trim() || test.isFetching}>
            Try
          </button>
        </div>
        <p className="min-h-5 text-xs" aria-live="polite">
          {test.error ? (
            <span className="text-err">{test.error.message}</span>
          ) : verdict ? (
            verdict.action ? (
              <>
                <span className={`font-semibold ${TONE[verdict.action]}`}>{verdict.action}</span>
                <span className="text-ink2"> by {verdict.rule}</span>
                {verdict.matched.length > 1 && (
                  <span className="text-ink3">
                    {" "}
                    · also matches{" "}
                    {verdict.matched
                      .slice(1)
                      .map((m) => m.rule)
                      .join(", ")}
                  </span>
                )}
                {verdict.flags.length > 0 && <span className="text-ink3"> · flags {verdict.flags.join(", ")}</span>}
              </>
            ) : (
              <span className="text-ink2">No rule matches: the sign-up mode decides.</span>
            )
          ) : (
            <span className="text-ink3">Checks the rules only; nobody is signed up.</span>
          )}
        </p>
      </form>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove the ${removing?.action ?? ""} rule for ${removing ? `${KIND_WORD[removing.kind]} ${removing.pattern}` : "this pattern"}?`}
        body={
          removing?.action === "block"
            ? "Sign-ups it refused can get in again, as the sign-up mode says. Accounts that exist are not changed."
            : "Sign-ups it held follow the sign-up mode again. Accounts already waiting for approval stay waiting."
        }
        confirm="Remove rule"
        onConfirm={() => {
          if (removing) remove(removing);
          setRemoving(null);
        }}
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
    out.push({ kind: "ip", pattern: u.signupIp, label: `Address ${u.signupIp}`, hint: "Every sign-up from this exact address" });
    const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(u.signupIp);
    if (v4)
      out.push({
        kind: "ip",
        pattern: `${v4[1]}.0/24`,
        label: `Range ${v4[1]}.0/24`,
        hint: "The 256 addresses around it, for a network that rotates addresses",
      });
  }
  const email = u.email.trim().toLowerCase();
  out.push({ kind: "email", pattern: email, label: `Email ${email}`, hint: "This mailbox again, with dots or +tags too" });
  const domain = email.split("@")[1];
  if (domain) out.push({ kind: "domain", pattern: domain, label: `Domain ${domain}`, hint: `Everyone at ${domain} and its subdomains` });
  return out;
}

/**
 * Users → ⋯ → Add sign-up rule…: a rule built from what this account signed up with (its address or range, its email,
 * its domain), and optionally this account sent back to approval in the same go. The same procedures as
 * Settings → Sign-up rules and Require approval.
 */
export function RuleFromUserDialog({ user, onClose }: { user: RuleSource; onClose: () => void }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const options = useMemo(() => candidates(user), [user]);
  const [pick, setPick] = useState(0);
  const [action, setAction] = useState<Action>("hold");
  const [note, setNote] = useState(`from ${user.email}`);
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
      toast(`Added: ${action} ${KIND_WORD[chosen.kind]} ${chosen.pattern}${holding ? `. ${user.email} waits for approval` : ""}`);
      void qc.invalidateQueries({ queryKey: trpc.admin.signupRules.pathKey() });
      void qc.invalidateQueries({ queryKey: trpc.admin.users.pathKey() });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const why = user.role === "admin" ? "Not for an admin." : user.status === "pending" ? "They are already waiting for approval." : "They are suspended.";
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Sign-up rule from ${user.email}`} width={480}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1.5 text-xs font-semibold text-ink2">Match</legend>
          {options.map((o, i) => (
            <label key={o.label} className="flex cursor-pointer items-start gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-sunk">
              <input type="radio" name="rule-pattern" className="mt-1 accent-[var(--acc)]" checked={pick === i} onChange={() => setPick(i)} />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[13px]">{o.label}</span>
                <span className="block text-xs text-ink3">{o.hint}</span>
              </span>
            </label>
          ))}
          {!user.signupIp && <p className="px-2 text-xs text-ink3">No sign-up address was recorded for this account, so address rules are not offered.</p>}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-ink2">Then</span>
          <Segmented ariaLabel="What a match does" value={action} onChange={setAction} options={ACTIONS} />
          <p className="min-h-8 text-xs text-ink3">{EFFECT[action]}</p>
        </div>
        <input
          className="input"
          placeholder="Note for other admins (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          aria-label="Note"
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
            Also require approval for this account
            <span className="block text-xs text-ink3">
              {canHold ? "Rules only apply to new sign-ups. This sends them back to “waiting for approval” now, without saying why." : why}
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary min-w-[8.5rem]" disabled={save.isPending}>
            Add {action} rule
          </button>
        </div>
      </form>
    </Modal>
  );
}
