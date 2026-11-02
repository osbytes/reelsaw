/**
 * Terms of service and privacy policy for the hosted service (app.reelsaw.com). Plain language, one section per
 * topic. Bracketed values ([…]) are the facts only the operator can fill in; `LEGAL_UPDATED` is shown on both
 * pages. Have counsel read these once before the first paying customer (docs/specs/ee.md).
 */
export const LEGAL_UPDATED = "2026-10-21";
export const LEGAL_ENTITY = "osbytes";
export const LEGAL_CONTACT = "hi+reelsaw@osbytes.io";
export const LEGAL_LAW = "[the jurisdiction of the operator]";

export type LegalSection = { heading: string; paragraphs: string[]; bullets?: string[] };

export const TERMS: LegalSection[] = [
  {
    heading: "What this covers",
    paragraphs: [
      `These terms apply to the hosted Reelsaw service at app.reelsaw.com (the "Service"), run by ${LEGAL_ENTITY} ("we"). They do not apply to the open-source software, which you may run yourself under the GNU Affero General Public License v3.0; that licence is in the repository.`,
      "By creating an account you accept these terms. If you use the Service for a company, you confirm you may bind it.",
    ],
  },
  {
    heading: "Your account",
    paragraphs: [
      "You need an account with a working email address. Keep your password and API keys to yourself; what happens through them counts as you. Tell us at once if you think someone else has them.",
      "One person per account. Workspaces for teams may come later and will carry their own terms.",
    ],
  },
  {
    heading: "Plans, payment and changes",
    paragraphs: [
      "The Free plan costs nothing and has the limits shown on the pricing page. Paid plans renew monthly or yearly until cancelled. Payment is handled by Stripe; where Stripe acts as merchant of record (Managed Payments), your receipt and the charge on your statement name Link, and Stripe handles tax, refunds and payment disputes under its own terms.",
      "You can change or cancel a plan at any time from Settings → Plan and billing. A cancellation takes effect at the end of the paid period; a plan change is prorated. If a payment fails, the plan stays for a grace period, then the account returns to Free with its limits; your projects are kept.",
      "We may change prices or plan limits with at least 30 days' notice by email; a change applies from your next renewal.",
    ],
  },
  {
    heading: "What you may upload and make",
    paragraphs: [
      "You keep every right to the videos you upload and the clips the Service makes from them. You give us only the permission needed to store, process and show them back to you, which ends when you delete them or close the account.",
      "You confirm you have the right to use what you upload. You may not use the Service for content that is unlawful, that infringes someone's rights, that sexualises minors, or that is meant to harass or deceive. We may remove such content and close the account.",
    ],
  },
  {
    heading: "Limits and fair use",
    paragraphs: [
      "Each plan has limits (minutes of source video per period, storage, projects, jobs at once). The app states a limit when you reach it and when it resets. We may add rate limits to keep the Service working for everyone, and we may suspend an account that is used to attack or overload it.",
    ],
  },
  {
    heading: "Free plan watermark",
    paragraphs: [
      "Clips made on the Free plan carry a small text watermark. Paid plans do not. A clip rendered with the watermark keeps it until it is rendered again.",
    ],
  },
  {
    heading: "Availability and support",
    paragraphs: [
      "We aim to keep the Service up but do not promise a specific availability. We may change or stop features, and we will give reasonable notice before stopping the Service as a whole. Support is by email at " +
        LEGAL_CONTACT +
        ".",
    ],
  },
  {
    heading: "Ending the agreement",
    paragraphs: [
      "You can delete your account at any time; that deletes your projects, clips and files. We may close an account that breaks these terms, after a warning where that is reasonable. Fees already paid are not refunded except as the payment terms above say.",
    ],
  },
  {
    heading: "Liability",
    paragraphs: [
      `The Service is provided as it is. To the extent the law allows, ${LEGAL_ENTITY} is not liable for indirect or consequential loss, and our total liability for anything arising from the Service is limited to what you paid us in the twelve months before the claim. Nothing here limits liability that cannot be limited by law.`,
    ],
  },
  {
    heading: "Changes and law",
    paragraphs: [
      `We may update these terms; the date at the top says when. A material change is announced by email 30 days ahead. These terms are governed by the laws of ${LEGAL_LAW}.`,
    ],
  },
];

export const PRIVACY: LegalSection[] = [
  {
    heading: "What this covers",
    paragraphs: [
      `How ${LEGAL_ENTITY} ("we") handles personal data on the hosted Reelsaw service at app.reelsaw.com and on reelsaw.com. The open-source software you run yourself sends us nothing (its optional update check asks GitHub for the latest release and nothing more).`,
    ],
  },
  {
    heading: "What we collect",
    paragraphs: ["Only what the Service needs:"],
    bullets: [
      "Account: name, email address, a hashed password, when you signed in and from which address and browser.",
      "Content: the videos you upload or link, their transcripts, the clips and files the Service makes, your settings and project history.",
      "Billing: your Stripe customer id, plan and subscription status. Card numbers never reach us; Stripe holds them.",
      "Your decisions: the fixes you accept, reject or make and the clips you edit, create or delete, each with the transcript words or clip text it was about (a few dozen words around a fix, the text of a clip), which models proposed it, and the source's title, link and fingerprint. We use them only to improve what the Service suggests to you (a few of your past rejections are shown to the model checking your next video) and to measure the Service against real choices. We do not sell them or use them for advertising, and model providers do not train on them. Turning off Settings → Learning stops recording; nothing is recorded while it is off.",
      "Usage: minutes processed, storage used, model calls and their cost, which the app shows you and we use for the plan limits.",
      "Technical logs: request ids, errors and timings for 7 days, to keep the Service working.",
      "Website: reelsaw.com uses PostHog analytics with cookieless, aggregated page views; no advertising trackers.",
    ],
  },
  {
    heading: "Who processes it for us",
    paragraphs: [
      "Transcription and the selection of moments run on model providers we choose for the Service (currently Deepgram and Anthropic, through Vercel's AI Gateway). They receive the audio and the transcript of a video while it is processed and, under their API terms, do not train on it. Stripe handles payment. Files are stored on an S3-compatible object store in [region]. Email is sent through Resend. Each of them acts under a data processing agreement.",
    ],
  },
  {
    heading: "How long we keep it",
    paragraphs: [
      'Stored source videos are deleted 30 days after upload and rendered clips 90 days after rendering; the project and its transcript stay so a clip can be rendered again from a fresh upload. Deleted projects, clips, library items and templates are restorable from Deleted for a while (7 days for projects and clips, 30 days for library items and templates) and still count toward storage until you delete them forever or they are purged. Your decisions (above) are kept after a project is deleted forever, so the Service keeps learning from them, until you forget them, when deleting a project ("Also forget what Reelsaw learned from it") or all at once in Settings → Learning, or until you delete the account. An account you delete is purged with everything it owns within 30 days; billing records are kept as long as tax law requires.',
    ],
  },
  {
    heading: "Your rights",
    paragraphs: [
      "You can see and export your content in the app (every project has an export). You can correct your name and email in Settings, delete projects and clips, stop or forget your recorded decisions in Settings → Learning, and delete the account. For anything else, or to object to processing, write to " +
        LEGAL_CONTACT +
        ". If you are in the EU/EEA or the UK you also have the right to complain to your data protection authority.",
    ],
  },
  {
    heading: "Security",
    paragraphs: [
      "Data travels over TLS. Passwords are hashed; API keys are shown once and stored hashed; provider keys are encrypted at rest. Access to production is limited to the operator and logged.",
    ],
  },
  {
    heading: "Changes",
    paragraphs: [`We may update this policy; the date at the top says when, and a material change is announced by email. Questions: ${LEGAL_CONTACT}.`],
  },
];
