/**
 * Outgoing mail (approvals, password reset, verification, the ready note). EMAIL_DRIVER=none
 * (default) keeps every mail-dependent feature off, so a self-hosted box needs no mail setup.
 * smtp uses nodemailer; resend uses the Resend HTTP API. Boot checks the driver so a typo fails fast.
 *
 * Templates send multipart HTML + plain text. HTML is table-based and inline-styled for mail
 * clients; no remote images or tracking pixels. The plain-text part keeps the same links. Copy comes from the server
 * catalogue (i18n.ts) in the recipient's language: build a mail inside `inLocaleOf(recipient, …)`.
 */
import { msg, plural } from "@lingui/core/runtime-macro";
import { unsubscribeHeaders } from "./notify/preferences.js";
import { localeDir, REPO_URL } from "@reelsaw/shared";
import { currentLocale, type MessageDescriptor, t } from "./i18n.js";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** extra headers, e.g. List-Unsubscribe on mail an account can turn off (notify/preferences.ts) */
  headers?: Record<string, string>;
}

export interface Email {
  enabled: boolean;
  driver: Config["EMAIL_DRIVER"];
  check(): Promise<void>;
  /**
   * Sends, or logs at debug when disabled. Failures are logged. `strict` rethrows so a job can
   * retry; request-path mail leaves it off and never fails the request.
   *
   * `idempotencyKey` (a job that may send the same mail twice): the same key means the same mail.
   * Resend gets it as `Idempotency-Key` and drops a repeat within 24 hours. SMTP has no dedup, so
   * the key becomes a fixed Message-ID: some inboxes collapse the repeat, others show it twice.
   */
  send(mail: Mail, opts?: { strict?: boolean; idempotencyKey?: string }): Promise<void>;
}

/** The domain of a Message-ID: the sender's, else the app's host. */
export function messageIdDomain(from: string, appUrl: string): string {
  const m = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from);
  if (m) return m[1]!;
  try {
    return new URL(appUrl).hostname || "reelsaw.local";
  } catch {
    return "reelsaw.local";
  }
}

export function createEmail(config: Config, log: Logger): Email {
  const from = config.EMAIL_FROM ?? "";
  const driver = config.EMAIL_DRIVER;
  let transport: import("nodemailer").Transporter | null = null;

  /** "sent", or "duplicate" when the provider says this idempotency key already went out */
  async function deliver(mail: Mail, idempotencyKey?: string): Promise<"sent" | "duplicate"> {
    if (driver === "smtp") {
      if (!transport) transport = (await import("nodemailer")).default.createTransport(config.SMTP_URL!);
      const messageId = idempotencyKey ? `<${idempotencyKey}@${messageIdDomain(from, config.APP_URL)}>` : undefined;
      await transport.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(messageId ? { messageId } : {}),
        ...(mail.headers ? { headers: mail.headers } : {}),
      });
      return "sent";
    }
    if (driver === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.RESEND_API_KEY}`,
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          ...(mail.headers ? { headers: mail.headers } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return "sent";
      const body = (await res.text()).slice(0, 300);
      // same key, different body: the first one was accepted (a re-render changed a clip name since)
      if (idempotencyKey && res.status === 409 && body.includes("invalid_idempotent_request")) return "duplicate";
      throw new Error(`resend ${res.status}: ${body}`);
    }
    return "sent";
  }

  return {
    enabled: driver !== "none",
    driver,
    async check() {
      if (driver === "smtp") {
        transport = (await import("nodemailer")).default.createTransport(config.SMTP_URL!);
        await transport.verify();
      }
      if (driver === "resend") {
        const res = await fetch("https://api.resend.com/domains", {
          headers: { authorization: `Bearer ${config.RESEND_API_KEY}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) throw new Error("RESEND_API_KEY was rejected");
      }
    },
    async send(mail, opts) {
      if (driver === "none") {
        log.debug({ to: mail.to, subject: mail.subject }, "email disabled; not sent");
        return;
      }
      try {
        const r = await deliver(mail, opts?.idempotencyKey);
        if (r === "duplicate") log.info({ to: mail.to, subject: mail.subject, idempotencyKey: opts?.idempotencyKey }, "email already sent; repeat dropped");
        else log.info({ to: mail.to, subject: mail.subject }, "email sent");
      } catch (err) {
        // reported (log.ts): a sign-up waiting on its verification or reset mail is stuck until someone looks.
        // Only `driver` becomes a tag; the address and subject stay in the log.
        log.error({ err, driver, to: mail.to, subject: mail.subject }, "email failed");
        if (opts?.strict) throw err;
      }
    },
  };
}

/** Light-theme tokens from apps/web (hex — mail clients lack oklch). */
const ink = "#1c1c1e";
const ink2 = "#4f4f55";
const ink3 = "#6e6e74";
const bg = "#f5f5f4";
const panel = "#ffffff";
const line = "#e2e2e0";
const acc = "#8460d2";
const accInk = "#ffffff";
const accText = "#653eae";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function brandMark(): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">` +
    `<tr>` +
    `<td style="width:32px;height:32px;border-radius:8px;background-color:${acc};color:${accInk};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;line-height:32px;text-align:center">r</td>` +
    `<td style="padding-left:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;letter-spacing:-0.02em;color:${ink};line-height:32px">reel<span style="color:${accText};font-weight:500">/</span>saw</td>` +
    `</tr></table>`
  );
}

function ctaButton(href: string, label: string): string {
  const safe = escapeHtml(href);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:28px 0 8px">` +
    `<tr><td style="border-radius:10px;background-color:${acc}">` +
    `<a href="${safe}" style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;line-height:1.2;color:${accInk};text-decoration:none">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

function linkFallback(href: string): string {
  const safe = escapeHtml(href);
  return (
    `<p style="margin:16px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${ink3};word-break:break-all">` +
    `${escapeHtml(t(msg`Or paste this link into your browser:`))}<br>` +
    `<a href="${safe}" style="color:${accText};text-decoration:underline">${safe}</a></p>`
  );
}

/**
 * A message as mail HTML: its values escaped, its own text kept (the catalogue is ours), and its numbered tags
 * (`<0>projects page</0>`) turned into the markup `tags` gives, so a link stays inside its sentence for translators.
 */
export function htmlMessage(descriptor: MessageDescriptor, tags: Record<number, (inner: string) => string> = {}): string {
  const values = Object.fromEntries(Object.entries(descriptor.values ?? {}).map(([k, v]) => [k, typeof v === "string" ? escapeHtml(v) : v]));
  return t({ ...descriptor, values }).replace(/<(\d+)>(.*?)<\/\1>/gs, (_, n: string, inner: string) => tags[Number(n)]?.(inner) ?? inner);
}

/** The same message as plain text: its numbered tags dropped, their words kept. */
function tx(descriptor: MessageDescriptor): string {
  return t(descriptor).replace(/<\/?\d+>/g, "");
}

/** Muted footer under the card: brand + source repo (no tracking). */
function footerHtml(): string {
  const href = escapeHtml(REPO_URL);
  return htmlMessage(msg`Sent by Reelsaw · <0>github.com/osbytes/reelsaw</0> · No tracking.`, {
    0: (inner) => `<a href="${href}" style="color:${ink3};text-decoration:underline">${inner}</a>`,
  });
}

function footerText(): string {
  const repo = REPO_URL;
  return t(msg`Sent by Reelsaw · ${{ repo }} · No tracking.`);
}

/** Shared shell: soft page background, white card, brand, body, muted footer. In the current scope's language and direction. */
export function layout(opts: { preheader: string; title: string; bodyHtml: string }): string {
  const preheader = escapeHtml(opts.preheader);
  const title = escapeHtml(opts.title);
  const lang = currentLocale();
  return (
    `<!DOCTYPE html><html lang="${escapeHtml(lang)}" dir="${localeDir(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light only"><title>${title}</title></head>` +
    `<body style="margin:0;padding:0;background-color:${bg};color:${ink}">` +
    // Hidden preheader for inbox previews
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${bg}">${preheader}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:${bg}">` +
    `<tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:480px;width:100%;background-color:${panel};border:1px solid ${line};border-radius:18px">` +
    `<tr><td style="padding:28px 28px 8px">${brandMark()}</td></tr>` +
    `<tr><td style="padding:20px 28px 8px">` +
    `<h1 style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;line-height:1.25;color:${ink}">${title}</h1>` +
    `</td></tr>` +
    `<tr><td style="padding:8px 28px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:${ink2}">` +
    opts.bodyHtml +
    `</td></tr>` +
    `</table>` +
    `<p style="margin:20px 0 0;max-width:480px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.4;color:${ink3};text-align:center">${footerHtml()}</p>` +
    `</td></tr></table></body></html>`
  );
}

function message(opts: { subject: string; preheader: string; title: string; text: string; bodyHtml: string }): Omit<Mail, "to"> {
  return {
    subject: opts.subject,
    text: `${opts.text.trimEnd()}\n\n${footerText()}\n`,
    html: layout({ preheader: opts.preheader, title: opts.title, bodyHtml: opts.bodyHtml }),
  };
}

/** The billing mails' shape: a lead, bulleted sections (each shown only when it has items), a closing line, the Billing page. */
function planMail(o: {
  subject: string;
  preheader: string;
  title: string;
  lead: string;
  sections: { lead: string; items: string[] }[];
  tail: string;
  billingUrl: string;
  cta: string;
}): Omit<Mail, "to"> {
  const sections = o.sections.filter((x) => x.items.length);
  const text = sections.map((x) => `${x.lead}\n${x.items.map((i) => `- ${i}`).join("\n")}\n\n`).join("");
  const html = sections
    .map(
      (x) =>
        `<p style="margin:0 0 8px">${escapeHtml(x.lead)}</p><ul style="margin:0 0 12px;padding-left:20px">${x.items.map((i) => `<li style="margin:0 0 6px">${escapeHtml(i)}</li>`).join("")}</ul>`,
    )
    .join("");
  return message({
    subject: o.subject,
    preheader: o.preheader,
    title: o.title,
    text: `${o.lead}

${text}${o.tail}

${o.billingUrl}
`,
    bodyHtml:
      `<p style="margin:0 0 12px">${escapeHtml(o.lead)}</p>` +
      html +
      `<p style="margin:0 0 12px">${escapeHtml(o.tail)}</p>` +
      ctaButton(o.billingUrl, o.cta) +
      linkFallback(o.billingUrl),
  });
}

/**
 * Branded HTML + plain-text templates. No tracking. Each renders in the current locale scope (i18n.ts): the caller
 * builds the mail inside `inLocaleOf(recipient, …)`, so it reads in the recipient's language, not the actor's.
 */
export const templates = {
  waitingForApproval: (appUrl: string, name: string, email: string) => {
    const who = name ? `${name} (${email})` : email;
    const person = name || email;
    const url = `${appUrl.replace(/\/$/, "")}/admin/users`;
    return message({
      subject: t(msg`${{ person }} is waiting for approval`),
      preheader: t(msg`${{ who }} signed up and is waiting for an admin.`),
      title: t(msg`New sign-up waiting`),
      text: `${t(msg`${{ who }} signed up for Reelsaw and is waiting for an admin.`)}\n\n${t(msg`Approve or decline: ${{ url }}`)}\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">${htmlMessage(msg`${{ who }} signed up for Reelsaw and is waiting for an admin.`)}</p>` +
        ctaButton(url, t(msg`Review sign-ups`)) +
        linkFallback(url),
    });
  },
  webhookDisabled: (appUrl: string, endpoint: string, reason: string) => {
    const url = `${appUrl.replace(/\/$/, "")}/settings#webhooks`;
    const stopped = msg`Reelsaw stopped sending events to <0>${{ endpoint }}</0>.`;
    return message({
      subject: t(msg`A Reelsaw webhook was turned off`),
      preheader: t(msg`${{ endpoint }} stopped receiving events.`),
      title: t(msg`Webhook turned off`),
      text: `${tx(stopped)}

${reason}

${t(msg`Fix the receiver, then turn the webhook back on and resend what it missed: ${{ url }}`)}
`,
      bodyHtml:
        `<p style="margin:0 0 12px">${htmlMessage(stopped, { 0: (inner) => `<b>${inner}</b>` })}</p>` +
        `<p style="margin:0 0 12px">${escapeHtml(reason)}</p>` +
        `<p style="margin:0 0 12px">${escapeHtml(t(msg`Fix the receiver, then turn the webhook back on and resend what it missed from its delivery log.`))}</p>` +
        ctaButton(url, t(msg`Open webhooks`)) +
        linkFallback(url),
    });
  },
  /** A cancellation was scheduled: when the plan ends and what Free will refuse then (`over`: quota.ts overages sentences). */
  planEnding: (billingUrl: string, planLabel: string, endsOn: string, over: string[], expect: string[] = []) => {
    const plan = planLabel;
    const on = endsOn;
    return planMail({
      subject: t(msg`Your Reelsaw ${{ plan }} plan ends on ${{ on }}`),
      preheader: t(msg`${{ plan }} stays until ${{ on }}, then the account moves to Free.`),
      title: t(msg`${{ plan }} ends on ${{ on }}`),
      lead: t(msg`Your ${{ plan }} plan is canceled. It stays in force until ${{ on }}, then the account moves to the Free plan. Nothing is deleted.`),
      sections: [
        { lead: t(msg`On that day this account would be over Free's limits:`), items: over },
        { lead: t(msg`What else changes on Free:`), items: expect },
      ],
      tail: t(msg`Changed your mind? Renew from the Billing page before then and nothing changes.`),
      billingUrl,
      cta: t(msg`Open billing`),
    });
  },
  /** The subscription ended: the account is on Free now, where it is over Free's limits, and what else changed (`expect`). */
  planEnded: (billingUrl: string, planLabel: string, over: string[], expect: string[] = []) => {
    const plan = planLabel;
    return planMail({
      subject: t(msg`Your Reelsaw ${{ plan }} plan has ended`),
      preheader: t(msg`The account is on the Free plan now. Your projects and clips are all still here.`),
      title: t(msg`You're on Free now`),
      lead: t(msg`Your ${{ plan }} plan has ended and the account is on the Free plan. Your projects and clips are all still here.`),
      sections: [
        { lead: t(msg`This account is over Free's limits:`), items: over },
        { lead: t(msg`What else changes on Free:`), items: expect },
      ],
      tail: t(msg`Pick a plan again any time to lift the limits.`),
      billingUrl,
      cta: t(msg`See plans`),
    });
  },
  approved: (appUrl: string) => {
    const url = `${appUrl.replace(/\/$/, "")}/login`;
    return message({
      subject: t(msg`Your Reelsaw account is ready`),
      preheader: t(msg`An admin approved your account. You can sign in now.`),
      title: t(msg`You're in`),
      text: `${t(msg`An admin approved your account. Sign in: ${{ url }}`)}\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">${escapeHtml(t(msg`An admin approved your account. You can sign in and start cutting.`))}</p>` +
        ctaButton(url, t(msg`Sign in`)) +
        linkFallback(url),
    });
  },
  resetPassword: (url: string) =>
    message({
      subject: t(msg`Reset your Reelsaw password`),
      preheader: t(msg`Use the button below if you asked to reset your password.`),
      title: t(msg`Reset your password`),
      text: `${t(msg`Someone asked to reset the password for this account. If that was you, open:`)}\n\n${url}\n\n${t(msg`If not, ignore this message; nothing changes.`)}\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">${escapeHtml(t(msg`Someone asked to reset the password for this account. If that was you, choose a new one:`))}</p>` +
        ctaButton(url, t(msg`Reset password`)) +
        linkFallback(url) +
        `<p style="margin:20px 0 0;font-size:13px;color:${ink3}">${escapeHtml(t(msg`If you didn't ask for this, ignore the message — nothing changes.`))}</p>`,
    }),
  verifyEmail: (url: string) =>
    message({
      subject: t(msg`Confirm your email for Reelsaw`),
      preheader: t(msg`Confirm this address to finish signing up. The link works for 24 hours.`),
      title: t(msg`Confirm your email`),
      text: `${t(msg`Confirm this address to finish signing up. The link works for 24 hours:`)}\n\n${url}\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">${escapeHtml(t(msg`Confirm this address to finish signing up for Reelsaw. The link works for 24 hours.`))}</p>` +
        ctaButton(url, t(msg`Confirm email`)) +
        linkFallback(url),
    }),
  /**
   * Projects that finished while the account was away. One note for the whole batch.
   * `milestone` 1 is "your first"; higher numbers get a single line. No tracking.
   */
  clipsReady: (
    appUrl: string,
    opts: {
      greeting: string | null;
      projects: Array<{ id: string; title: string; clips: number; failed: number; rerender: boolean; highlights: string[]; more: number }>;
      hidden: number;
      milestone: number | null;
      /** one-click unsubscribe (notify/preferences.ts): a line under the note and the List-Unsubscribe headers */
      unsubscribeUrl?: string;
    },
  ) => {
    const base = appUrl.replace(/\/$/, "");
    // every project in the note, listed or counted in "And N more"
    const n = opts.projects.length + opts.hidden;
    const clips = opts.projects.reduce((sum, p) => sum + p.clips, 0);
    const allRerender = n > 0 && opts.hidden === 0 && opts.projects.every((p) => p.rerender);
    const first = opts.milestone === 1;
    const subject = first
      ? t(msg`Your first clips are ready`)
      : n === 1 && allRerender
        ? t(msg`A new render is ready`)
        : n === 1
          ? t(msg`Your clips are ready`)
          : t(msg({ id: "email.ready.projects", message: plural({ n }, { one: "# project is ready", other: "# projects are ready" }) }));
    const one = opts.projects[0];
    const title = one?.title ?? "";
    // the clip count covers the listed projects only, so a note with more says how many projects instead
    const preheader =
      n === 1 && one
        ? t(msg({ id: "email.ready.preheader_one", message: msg`${plural({ clips }, { one: "# clip", other: "# clips" })} from ${{ title }}` }))
        : opts.hidden > 0
          ? t(msg({ id: "email.ready.preheader_count", message: plural({ n }, { one: "# project", other: "# projects" }) }))
          : t(
              msg({
                id: "email.ready.preheader_many",
                message: msg`${plural({ n }, { one: "# project", other: "# projects" })}, ${plural({ clips }, { one: "# clip", other: "# clips" })}`,
              }),
            );
    const intro =
      n === 1
        ? allRerender
          ? t(msg`A new render finished while you were away.`)
          : t(msg`This finished while you were away.`)
        : allRerender
          ? t(msg`New renders finished while you were away.`)
          : t(msg`These finished while you were away.`);
    const greeting = opts.greeting;
    const hello = greeting ? msg`Hi ${{ greeting }} — ${{ intro }}` : null;
    const firstLine = first ? (n === 1 ? t(msg`This is the first project you've finished.`) : t(msg`These are the first projects you've finished.`)) : null;
    const count = opts.milestone ?? 0;
    const milestoneLine = opts.milestone && opts.milestone > 1 ? t(msg`That's ${{ count }} projects finished.`) : null;
    const home = `${base}/`;
    const open = n === 1 && one ? `${base}/p/${encodeURIComponent(one.id)}` : home;
    const blocks = opts.projects.map((p) => projectBlock(base, p)).join("");
    const hidden = opts.hidden;
    const moreLine = msg`And ${{ hidden }} more on your <0>projects page</0>.`;
    const more =
      hidden > 0
        ? `<p style="margin:16px 0 0;font-size:13px;color:${ink3}">${htmlMessage(moreLine, {
            0: (inner) => `<a href="${escapeHtml(home)}" style="color:${accText};text-decoration:underline">${inner}</a>`,
          })}</p>`
        : "";
    const settingsHref = escapeHtml(`${base}/settings#email`);
    const stop = opts.unsubscribeUrl
      ? `<p style="margin:20px 0 0;font-size:12px;color:${ink3}">${htmlMessage(
          msg`You get this because a project finished while you were away. <0>Stop these emails</0> or change it under <1>Settings → Account</1>.`,
          {
            0: (inner) => `<a href="${escapeHtml(opts.unsubscribeUrl ?? "")}" style="color:${ink3};text-decoration:underline">${inner}</a>`,
            1: (inner) => `<a href="${settingsHref}" style="color:${ink3};text-decoration:underline">${inner}</a>`,
          },
        )}</p>`
      : "";
    const unsubscribe = opts.unsubscribeUrl ?? "";
    const mail = message({
      subject,
      preheader,
      title: subject,
      text: [
        hello ? t(hello) : intro,
        firstLine,
        milestoneLine,
        ...opts.projects.map((p) => projectText(base, p)),
        hidden > 0 ? t(msg`And ${{ hidden }} more: ${{ home }}`) : null,
        n === 1 ? t(msg`Open: ${{ open }}`) : t(msg`Open your projects: ${{ home }}`),
        opts.unsubscribeUrl ? t(msg`Stop these emails: ${{ unsubscribe }}`) : null,
      ]
        .filter((s): s is string => !!s)
        .join("\n\n"),
      bodyHtml:
        `<p style="margin:0 0 12px">${hello ? htmlMessage(hello) : escapeHtml(intro)}</p>` +
        (firstLine ? `<p style="margin:0 0 12px">${escapeHtml(firstLine)}</p>` : "") +
        (milestoneLine ? `<p style="margin:0 0 16px;color:${accText};font-weight:600">${escapeHtml(milestoneLine)}</p>` : "") +
        blocks +
        more +
        ctaButton(open, n === 1 ? t(msg`Open project`) : t(msg`Open projects`)) +
        linkFallback(open) +
        stop,
    });
    return opts.unsubscribeUrl ? { ...mail, headers: unsubscribeHeaders(opts.unsubscribeUrl) } : mail;
  },
};

function clipCount(clips: number): string {
  return t(msg({ id: "email.ready.clips", message: plural({ clips }, { one: "# clip", other: "# clips" }) }));
}

function failedCount(failed: number): string {
  return t(msg({ id: "email.ready.failed", message: plural({ failed }, { one: "# needs another try", other: "# need another try" }) }));
}

/** The highlighted clip names, then "and N more" when the project has others. */
function highlightNames(names: string, more: number): string {
  return more > 0 ? t(msg`${{ names }} and ${{ more }} more`) : names;
}

function projectBlock(base: string, p: { id: string; title: string; clips: number; failed: number; highlights: string[]; more: number }): string {
  const href = escapeHtml(`${base}/p/${encodeURIComponent(p.id)}`);
  const bits = [clipCount(p.clips), ...(p.failed > 0 ? [failedCount(p.failed)] : [])].join(" · ");
  const names = p.highlights.join(" · ");
  return (
    `<p style="margin:14px 0 0">` +
    `<a href="${href}" style="color:${ink};font-weight:600;text-decoration:underline">${escapeHtml(p.title)}</a><br>` +
    `<span style="color:${ink3};font-size:13px">${bits}</span>` +
    (names ? `<br><span style="font-size:14px">${escapeHtml(highlightNames(names, p.more))}</span>` : "") +
    `</p>`
  );
}

function projectText(base: string, p: { id: string; title: string; clips: number; failed: number; highlights: string[]; more: number }): string {
  const bits = [clipCount(p.clips), ...(p.failed > 0 ? [failedCount(p.failed)] : [])].join(", ");
  const names = p.highlights.join(", ");
  return `${p.title} — ${bits}${names ? `\n${highlightNames(names, p.more)}` : ""}\n${base}/p/${p.id}`;
}
