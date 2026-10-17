/**
 * Outgoing mail (approvals, password reset, verification). EMAIL_DRIVER=none (default) keeps every
 * mail-dependent feature off, so a self-hosted box needs no mail setup. smtp uses nodemailer;
 * resend uses the Resend HTTP API. Boot checks the driver so a typo fails fast.
 */
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Email {
  enabled: boolean;
  driver: Config["EMAIL_DRIVER"];
  check(): Promise<void>;
  /** Sends, or logs at debug when disabled. Never throws into a request: failures are logged. */
  send(mail: Mail): Promise<void>;
}

export function createEmail(config: Config, log: Logger): Email {
  const from = config.EMAIL_FROM ?? "";
  const driver = config.EMAIL_DRIVER;
  let transport: import("nodemailer").Transporter | null = null;

  async function deliver(mail: Mail) {
    if (driver === "smtp") {
      if (!transport) transport = (await import("nodemailer")).default.createTransport(config.SMTP_URL!);
      await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
      return;
    }
    if (driver === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${config.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
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
        const res = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${config.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10_000) });
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
      }
    },
  };
}

/** Plain-text templates. Short, no HTML, no tracking. */
export const templates = {
  waitingForApproval: (appUrl: string, name: string, email: string) => ({
    subject: `${name || email} is waiting for approval`,
    text: `${name ? `${name} (${email})` : email} signed up for Reelsaw and is waiting for an admin.\n\nApprove or decline: ${appUrl}/admin/users\n`,
  }),
  approved: (appUrl: string) => ({
    subject: "Your Reelsaw account is ready",
    text: `An admin approved your account. Sign in: ${appUrl}/login\n`,
  }),
  resetPassword: (url: string) => ({
    subject: "Reset your Reelsaw password",
    text: `Someone asked to reset the password for this account. If that was you, open:\n\n${url}\n\nIf not, ignore this message; nothing changes.\n`,
  }),
  verifyEmail: (url: string) => ({
    subject: "Confirm your email for Reelsaw",
    text: `Confirm this address to finish signing up:\n\n${url}\n`,
  }),
};
