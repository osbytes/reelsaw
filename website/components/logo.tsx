// Mirrors LogoMark / Logo in apps/web/src/App.tsx
const MARK_R =
  "M23.69 47V24.32H30.07V30.5L29.2 30.55Q29.3 28.6 30.3 27.09Q31.3 25.57 32.82 24.71Q34.34 23.84 35.94 23.84Q37.11 23.84 38.17 24.17Q39.23 24.49 40.39 25.22L37.35 30.93Q36.87 30.61 36.06 30.38Q35.25 30.14 34.45 30.14Q33.6 30.14 32.81 30.44Q32.03 30.74 31.43 31.38Q30.83 32.01 30.48 33.01Q30.26 33.65 30.14 34.65Q30.03 35.65 30.03 37.55V47Z";

export function LogoMark({ className = "h-[26px] w-[26px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={`shrink-0 ${className}`} aria-hidden>
      <rect width="64" height="64" rx="16" className="fill-acc" />
      <path d={MARK_R} className="fill-acc-ink" />
      <line x1="14" y1="40" x2="50" y2="26" strokeWidth="4" className="stroke-acc" />
    </svg>
  );
}

export function Logo({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <a href="/" className="flex items-center gap-2.5 text-ink no-underline" aria-label="Reelsaw home">
      <LogoMark />
      {wordmark && (
        <span className="text-[15px] font-extrabold tracking-tight" aria-hidden>
          reel<span className="mx-px font-medium text-acc-text">/</span>saw
        </span>
      )}
    </a>
  );
}

export function GitHubMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
