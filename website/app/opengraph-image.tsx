import { defaultOgAlt, defaultOgDescription, defaultOgTitle, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const alt = defaultOgAlt;
export const size = ogSize;
export const contentType = ogContentType;

/** Site-wide fallback card; also used for `/`. Child routes override with their own file. */
export default function Image() {
  return renderOgImage({ title: defaultOgTitle, description: defaultOgDescription });
}
