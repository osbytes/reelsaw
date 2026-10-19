import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name}: self-hosted, AI-powered video clipper`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const logo = await readFile(join(process.cwd(), "public/logo-dark.png"));
  const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;
  return new ImageResponse(
    (
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} width={450} height={120} alt="" style={{ width: 450, height: 120 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 54, fontWeight: 700, lineHeight: 1.1, letterSpacing: -1.5 }}>Long videos in. Vertical clips out. On your own hardware.</div>
          <div style={{ fontSize: 26, color: "#bcbcc1", lineHeight: 1.4 }}>Open-source AI clipper: transcribe, pick moments, reframe to 9:16, caption. Fully local with no API keys, or any AI provider.</div>
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 22, color: "#8e8e94" }}>
          <span style={{ color: "#c9b5ff" }}>reelsaw.com</span>
          <span>·</span>
          <span>github.com/osbytes/reelsaw</span>
          <span>·</span>
          <span>AGPL-3.0</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
