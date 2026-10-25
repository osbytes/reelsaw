import type { Metadata } from "next";
import { TERMS } from "@/content/legal";
import { LegalPage } from "@/components/legal";

const title = "Terms of service";
const description = "The terms for the hosted Reelsaw service at app.reelsaw.com: accounts, plans and payment through Stripe, your content, limits, the Free plan watermark, and how the agreement ends.";
export const metadata: Metadata = { title, description, alternates: { canonical: "/terms" }, openGraph: { title, description, url: "/terms" }, twitter: { title, description } };

export default function TermsPage() {
  return <LegalPage slug="terms" title={title} intro="Plain terms for the hosted service. The open-source software has its own licence, the AGPL-3.0, and these terms do not change it." sections={TERMS} />;
}
