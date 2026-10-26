import type { Metadata } from "next";
import { TERMS } from "@/content/legal";
import { LegalPage } from "@/components/legal";

const title = "Terms of service";
const description = "Terms for hosted Reelsaw at app.reelsaw.com: accounts, plans and Stripe payment, your content, limits, the Free plan watermark, and ending the agreement.";
export const metadata: Metadata = { title, description, alternates: { canonical: "/terms" }, openGraph: { title, description, url: "/terms" }, twitter: { title, description } };

export default function TermsPage() {
  return <LegalPage slug="terms" title={title} intro="Plain terms for the hosted service. The open-source software has its own licence, the AGPL-3.0, and these terms do not change it." sections={TERMS} />;
}
