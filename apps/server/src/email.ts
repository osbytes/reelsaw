/**
 * Outgoing mail (approvals, password reset, verification). EMAIL_DRIVER=none (default) keeps every
 * mail-dependent feature off, so a self-hosted box needs no mail setup. smtp uses nodemailer;
 * resend uses the Resend HTTP API. Boot checks the driver so a typo fails fast.
 *
 * Templates send multipart HTML + plain text. HTML is table-based and inline-styled for mail
 * clients; no remote images or tracking pixels. The plain-text part keeps the same links.
 */
import { REPO_URL } from "@reelsaw/shared";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import type { Telemetry } from "./telemetry.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Email {
  enabled: boolean;
  driver: Config["EMAIL_DRIVER"];
  check(): Promise<void>;
  /** Sends, or logs at debug when disabled. Never throws into a request: failures are logged. */
  send(mail: Mail): Promise<void>;
}

export function createEmail(config: Config, log: Logger, telemetry?: Pick<Telemetry, "captureException">): Email {
  const from = config.EMAIL_FROM ?? "";
  const driver = config.EMAIL_DRIVER;
  let transport: import("nodemailer").Transporter | null = null;

  async function deliver(mail: Mail) {
    if (driver === "smtp") {
      if (!transport) transport = (await import("nodemailer")).default.createTransport(config.SMTP_URL!);
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
      return;
    }
    if (driver === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${config.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
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
    async send(mail) {
      if (driver === "none") {
        log.debug({ to: mail.to, subject: mail.subject }, "email disabled; not sent");
        return;
      }
      try {
        await deliver(mail);
        log.info({ to: mail.to, subject: mail.subject }, "email sent");
      } catch (err) {
        log.error({ err, to: mail.to, subject: mail.subject }, "email failed");
        // a sign-up waiting on its verification or reset mail is stuck until someone looks; never the address or subject
        telemetry?.captureException(err, { where: "email", driver });
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

function escapeHtml(s: string): string {
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
    `Or paste this link into your browser:<br>` +
    `<a href="${safe}" style="color:${accText};text-decoration:underline">${safe}</a></p>`
  );
}

/** Muted footer under the card: brand + source repo (no tracking). */
function footerHtml(): string {
  const href = escapeHtml(REPO_URL);
  return `Sent by Reelsaw · <a href="${href}" style="color:${ink3};text-decoration:underline">github.com/osbytes/reelsaw</a> · No tracking.`;
}

function footerText(): string {
  return `Sent by Reelsaw · ${REPO_URL} · No tracking.`;
}

/** Shared shell: soft page background, white card, brand, body, muted footer. */
export function layout(opts: { preheader: string; title: string; bodyHtml: string }): string {
  const preheader = escapeHtml(opts.preheader);
  const title = escapeHtml(opts.title);
  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light only"><title>${title}</title></head>` +
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

/** Branded HTML + plain-text templates. No tracking. */
export const templates = {
  waitingForApproval: (appUrl: string, name: string, email: string) => {
    const who = name ? `${name} (${email})` : email;
    const url = `${appUrl.replace(/\/$/, "")}/admin/users`;
    return message({
      subject: `${name || email} is waiting for approval`,
      preheader: `${who} signed up and is waiting for an admin.`,
      title: "New sign-up waiting",
      text: `${who} signed up for Reelsaw and is waiting for an admin.\n\nApprove or decline: ${url}\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">${escapeHtml(who)} signed up for Reelsaw and is waiting for an admin.</p>` +
        ctaButton(url, "Review sign-ups") +
        linkFallback(url),
    });
  },
  approved: (appUrl: string) => {
    const url = `${appUrl.replace(/\/$/, "")}/login`;
    return message({
      subject: "Your Reelsaw account is ready",
      preheader: "An admin approved your account. You can sign in now.",
      title: "You're in",
      text: `An admin approved your account. Sign in: ${url}\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">An admin approved your account. You can sign in and start cutting.</p>` + ctaButton(url, "Sign in") + linkFallback(url),
    });
  },
  resetPassword: (url: string) =>
    message({
      subject: "Reset your Reelsaw password",
      preheader: "Use the button below if you asked to reset your password.",
      title: "Reset your password",
      text: `Someone asked to reset the password for this account. If that was you, open:\n\n${url}\n\nIf not, ignore this message; nothing changes.\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">Someone asked to reset the password for this account. If that was you, choose a new one:</p>` +
        ctaButton(url, "Reset password") +
        linkFallback(url) +
        `<p style="margin:20px 0 0;font-size:13px;color:${ink3}">If you didn't ask for this, ignore the message — nothing changes.</p>`,
    }),
  verifyEmail: (url: string) =>
    message({
      subject: "Confirm your email for Reelsaw",
      preheader: "Confirm this address to finish signing up. The link works for 24 hours.",
      title: "Confirm your email",
      text: `Confirm this address to finish signing up. The link works for 24 hours:\n\n${url}\n`,
      bodyHtml:
        `<p style="margin:0 0 12px">Confirm this address to finish signing up for Reelsaw. The link works for 24 hours.</p>` +
        ctaButton(url, "Confirm email") +
        linkFallback(url),
    }),
};
