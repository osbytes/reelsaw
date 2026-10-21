import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@/components/analytics";
import { ThemeSync } from "@/components/theme";
import { SITE } from "@/lib/site";
import { THEME_BOOT_SCRIPT } from "@/lib/theme-script";
import "./globals.css";

const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: SITE.title, template: `%s · ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [
    "video clipper",
    "AI video clipping",
    "long-form to short-form",
    "self-hosted",
    "open source",
    "YouTube to Shorts",
    "TikTok clips",
    "Reels",
    "9:16 reframing",
    "auto captions",
    "karaoke captions",
    "transcription",
    "MCP server",
    "Docker",
    "Ollama",
    "Whisper",
    "OpusClip alternative",
  ],
  authors: [{ name: "Reelsaw contributors", url: SITE.github }],
  creator: "Reelsaw contributors",
  category: "technology",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    url: "/",
    title: SITE.title,
    description: SITE.description,
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: SITE.title, description: SITE.description },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#8460d2",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script sets data-theme before React hydrates.
    // ThemeSync puts it back when a later commit rebuilds <html> without that attribute.
    <html lang="en" className={`${hanken.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <ThemeSync />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
