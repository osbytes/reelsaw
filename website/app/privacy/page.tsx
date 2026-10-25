import type { Metadata } from "next";
import { PRIVACY } from "@/content/legal";
import { LegalPage } from "@/components/legal";

const title = "Privacy policy";
const description = "What the hosted Reelsaw service collects (account, videos, transcripts, billing status, usage), who processes it (model providers, Stripe, object storage), how long it is kept, and your rights.";
export const metadata: Metadata = { title, description, alternates: { canonical: "/privacy" }, openGraph: { title, description, url: "/privacy" }, twitter: { title, description } };

export default function PrivacyPage() {
  return <LegalPage slug="privacy" title={title} intro="What the hosted service keeps about you, why, for how long, and who else touches it. Nothing here applies to a Reelsaw you run yourself." sections={PRIVACY} />;
}
