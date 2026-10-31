/**
 * /version.txt: the git commit this deployment was built from (Vercel's VERCEL_GIT_COMMIT_SHA, or
 * "unknown" outside Vercel). The IndexNow workflow polls it after a push so it only submits URLs
 * once the new pages are live. Static: rendered once at build time.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response(`${process.env.VERCEL_GIT_COMMIT_SHA || "unknown"}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" },
  });
}
