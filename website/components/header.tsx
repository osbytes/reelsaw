import { GitHubMark, Logo } from "./logo";
import { ThemeToggle } from "./theme";
import { SITE, appLink } from "@/lib/site";

const NAV = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#features", label: "Features" },
  { href: "/#agents", label: "Agents" },
  { href: "/use-cases", label: "Use cases" },
  { href: "/alternatives", label: "Compare" },
  { href: "/pricing", label: "Pricing" },
  { href: "/#install", label: "Self-host" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
      <div className="container-page flex h-[60px] items-center justify-between gap-4">
        <Logo />
        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="btn-quiet text-ink2 hover:text-ink">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <a href={SITE.github} target="_blank" rel="noreferrer" className="btn-ghost h-[34px]" aria-label="Reelsaw on GitHub">
            <GitHubMark />
            <span className="hidden lg:inline">GitHub</span>
          </a>
          <ThemeToggle />
          <a href={appLink("/signup", "header")} className="btn-primary h-[34px] px-3 text-sm whitespace-nowrap">
            Start free
          </a>
        </div>
      </div>
    </header>
  );
}
