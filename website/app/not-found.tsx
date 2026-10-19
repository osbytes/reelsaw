import type { Metadata } from "next";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  return (
    <main className="container-page flex min-h-dvh flex-col items-center justify-center gap-5 py-20 text-center">
      <Logo />
      <h1 className="text-[28px] font-bold tracking-tight">That page is not here</h1>
      <p className="max-w-[40ch] text-ink2">The link may be old. Everything about Reelsaw is on the home page.</p>
      <a href="/" className="btn-primary">
        Back to reelsaw.com
      </a>
    </main>
  );
}
