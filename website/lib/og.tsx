import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const ogSize = { width: 1200, height: 630 } as const;
export const ogContentType = "image/png";

export const defaultOgAlt = `${SITE.name}: AI video clipper you self-host or run hosted`;
export const defaultOgTitle = "Long videos in. Vertical clips out. On your hardware, or hosted.";
export const defaultOgDescription =
  "Open-source AI clipper: transcribe, pick moments, reframe to 9:16, caption. Self-host with no meter, or use app.reelsaw.com. Fully local with no API keys, or any AI provider.";

type OgCard = {
  /** Large headline on the card. Prefer a short h1 over a long meta title. */
  title: string;
  /** Supporting line under the title. */
  description: string;
  /** Optional small label above the title (e.g. "Guide", "Reelsaw vs Opus Clip"). */
  eyebrow?: string;
};

let logoSrcPromise: Promise<string> | null = null;

function logoSrc() {
  logoSrcPromise ??= readFile(join(process.cwd(), "public/logo-dark.png")).then((buf) => `data:image/png;base64,${buf.toString("base64")}`);
  return logoSrcPromise;
}

function titleSize(title: string) {
  if (title.length > 70) return 40;
  if (title.length > 48) return 46;
  return 54;
}

/** Shared Open Graph / Twitter card. Root `opengraph-image.tsx` is the site-wide fallback. */
export async function renderOgImage({ title, description, eyebrow }: OgCard) {
  const logo = await logoSrc();
  const size = titleSize(title);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "linear-gradient(160deg, #131314 0%, #1c1c1e 60%, #26203a 100%)",
        color: "#f1f1f2",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} width={360} height={96} alt="" style={{ width: 360, height: 96 }} />
        {eyebrow ? (
          <div
            style={{
              display: "flex",
              fontSize: 22,
              fontWeight: 600,
              color: "#c9b5ff",
              letterSpacing: 0.4,
              maxWidth: 420,
              textAlign: "right",
            }}
          >
            {eyebrow}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 1040 }}>
        <div
          style={{
            fontSize: size,
            fontWeight: 700,
            lineHeight: 1.12,
            letterSpacing: -1.5,
            display: "flex",
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 26, color: "#bcbcc1", lineHeight: 1.4, display: "flex" }}>{description}</div>
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 22, color: "#8e8e94" }}>
        <span style={{ color: "#c9b5ff" }}>reelsaw.com</span>
        <span>·</span>
        <span>github.com/osbytes/reelsaw</span>
        <span>·</span>
        <span>AGPL-3.0</span>
      </div>
    </div>,
    { ...ogSize },
  );
}

/** Trim a meta description so it fits the card without wrapping past ~3 lines. */
export function ogBlurb(text: string, max = 160) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine
    .slice(0, max - 1)
    .replace(/\s+\S*$/, "")
    .trimEnd()}…`;
}
