import { GitHubMark, Logo } from "./logo";
import { ThemeToggle } from "./theme";
import { SITE } from "@/lib/site";

const NAV = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#features", label: "Features" },
  { href: "/#agents", label: "Agents" },
  { href: "/alternatives", label: "Compare" },
  { href: "/#install", label: "Install" },
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
          <a href={SITE.github} target="_blank" rel="noreferrer" className="btn-ghost h-[34px]">
            <GitHubMark />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
