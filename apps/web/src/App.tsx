import { Routes, Route, Navigate, Link, NavLink, useLocation } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { Moon, Sun, LogOut } from "lucide-react";
import { useSession, signOut } from "./lib/auth";
import { useTRPC } from "./lib/trpc";
import { useTheme } from "./lib/theme";
import { LoginPage } from "./pages/Login";
import { ProjectsPage } from "./pages/Projects";
import { NewProjectPage } from "./pages/NewProject";
import { ProjectPage } from "./pages/Project";
import { SettingsPage } from "./pages/Settings";
import { ClipEditorPage } from "./pages/ClipEditor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CommandPaletteProvider, useCommandPalette } from "./components/CommandPalette";
import { UploadsProvider } from "./lib/uploads";
import { Search } from "lucide-react";

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5 text-ink no-underline">
      <span className="grid h-[26px] w-[26px] place-items-center rounded-[8px] bg-acc text-acc-ink">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
          <path d="M2 3h2.5v10H2zM6.75 3h2.5v10h-2.5zM11.5 3H14v10h-2.5z" opacity=".35" />
          <path d="M1 7.2h14v1.6H1z" />
        </svg>
      </span>
      <span className="hidden text-[15px] font-bold tracking-tight sm:inline">Reelsaw</span>
    </Link>
  );
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, toggle] = useTheme();
  return (
    <button className={`btn-ghost h-[34px] w-[34px] px-0 ${className}`} onClick={toggle} title={theme === "dark" ? "Light theme" : "Dark theme"} aria-label="Toggle theme">
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

/** "Always-visible machine state": shows when heavy jobs are paused, and why. */
function MachineChip() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.settings.get.queryOptions(), refetchInterval: 10_000 });
  const r = q.data?.resources;
  if (!r) return null;
  const why = !r.ok.memory
    ? `memory ${Math.round(((r.memTotalMB - r.memAvailableMB) / Math.max(1, r.memTotalMB)) * 100)}%`
    : !r.ok.cpu
      ? `CPU ${r.cpuPercent}%`
      : !r.ok.disk
        ? "disk nearly full"
        : null;
  if (!why) return null;
  return (
    <Link to="/settings" className="chip bg-warn-soft text-ink no-underline" title="Heavy jobs wait until the machine has room">
      <span className="font-mono">◷</span> <span className="hidden sm:inline">Jobs paused ·</span> {why}
    </Link>
  );
}

function Avatar() {
  const { data } = useSession();
  const u = data?.user;
  if (!u) return null;
  const initials = (u.name || u.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="grid h-[30px] w-[30px] place-items-center rounded-full bg-acc-soft text-xs font-bold text-acc-text" title={u.email} aria-label="Account">
          {initials}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="menu">
          <DropdownMenu.Label className="px-2.5 py-1.5 text-xs text-ink3">{u.email}</DropdownMenu.Label>
          <DropdownMenu.Item className="menu-item" onSelect={() => signOut().then(() => window.location.assign("/login"))}>
            <LogOut className="h-4 w-4" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SearchButton() {
  const open = useCommandPalette();
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";
  return (
    <button onClick={() => open()} className="flex h-[34px] items-center gap-2 rounded-[10px] border border-line bg-sunk px-2.5 text-[13px] text-ink3 hover:text-ink sm:w-[240px]" aria-label="Search">
      <Search className="h-4 w-4" />
      <span className="hidden flex-1 text-left sm:inline">Search or paste a link…</span>
      <span className="kbd hidden sm:inline-grid">{mod}K</span>
    </button>
  );
}

export function TopBar() {
  const nav = ({ isActive }: { isActive: boolean }) => `rounded-[9px] px-2.5 py-[7px] no-underline sm:px-3 ${isActive ? "bg-sunk font-semibold text-ink" : "text-ink2 hover:text-ink"}`;
  const loc = useLocation();
  const inProjects = loc.pathname === "/" || loc.pathname.startsWith("/p/") || loc.pathname === "/new";
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-5 sm:px-5">
      <Logo />
      <nav className="flex min-w-0 gap-0.5 sm:gap-1">
        <NavLink to="/" className={() => nav({ isActive: inProjects })}>
          Projects
        </NavLink>
        <NavLink to="/settings" className={nav}>
          Settings
        </NavLink>
      </nav>
      <div className="flex-1" />
      <SearchButton />
      <MachineChip />
      <ThemeToggle />
      <Avatar />
    </header>
  );
}

/** Pages own their scrolling (ScrollArea) so the workspace can split into independent panes. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col">
        <ErrorBoundary>{children}</ErrorBoundary>
      </div>
    </div>
  );
}

function Protected({ children, bare }: { children: React.ReactNode; bare?: boolean }) {
  const { data, isPending } = useSession();
  if (isPending) return <div className="p-10 text-center text-ink3">Loading…</div>;
  if (!data) return <Navigate to="/login" replace />;
  // the editor hides the global bar so the timeline gets the room
  if (bare)
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <ErrorBoundary>{children}</ErrorBoundary>
      </div>
    );
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <UploadsProvider>
    <CommandPaletteProvider>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Protected><ProjectsPage /></Protected>} />
      <Route path="/new" element={<Protected><NewProjectPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/p/:id" element={<Protected><ProjectPage /></Protected>} />
      <Route path="/p/:id/clips/:clipId" element={<Protected bare><ClipEditorPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </CommandPaletteProvider>
    </UploadsProvider>
  );
}
