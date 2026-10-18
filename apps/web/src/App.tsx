import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, Link, NavLink, useLocation } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { Moon, Sun, LogOut, LifeBuoy } from "lucide-react";
import { ReportDialog } from "./components/ReportDialog";
import { openReportHere } from "./lib/report";
import { useSession, signOut } from "./lib/auth";
import { useTRPC } from "./lib/trpc";
import { useTheme } from "./lib/theme";
import { LoginPage } from "./pages/Login";
import { ProjectsPage } from "./pages/Projects";
const NewProjectPage = lazy(() => import("./pages/NewProject").then((m) => ({ default: m.NewProjectPage })));
const ProjectPage = lazy(() => import("./pages/Project").then((m) => ({ default: m.ProjectPage })));
const LibraryPage = lazy(() => import("./pages/Library").then((m) => ({ default: m.LibraryPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
import { PendingPage } from "./pages/Pending";
const AdminUsersPage = lazy(() => import("./pages/AdminUsers").then((m) => ({ default: m.AdminUsersPage })));
import { Skeleton, SkeletonRegion } from "./components/ui";
import { ConsentPage } from "./pages/Consent";
import { useMe, useSystemStatus } from "./lib/account";
const ClipEditorPage = lazy(() => import("./pages/ClipEditor").then((m) => ({ default: m.ClipEditorPage })));
import { ErrorBoundary } from "./components/ErrorBoundary";
import { CommandPaletteProvider, useCommandPalette } from "./components/CommandPalette";
import { UploadsProvider } from "./lib/uploads";
import { Search } from "lucide-react";
import { Toaster } from "sonner";

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
  const status = useSystemStatus(10_000);
  const why = status.data?.paused;
  if (!why) return null;
  const reason = why === "disk" ? "disk nearly full" : `${why} busy`;
  return (
    <Link to="/settings" className="chip min-w-0 shrink-0 whitespace-nowrap bg-warn-soft text-ink no-underline" title="Heavy jobs wait until the machine has room" aria-label={`Jobs paused: ${reason}`}>
      <span className="font-mono">◷</span> <span className="hidden sm:inline">Jobs paused · {reason}</span>
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
          <DropdownMenu.Item className="menu-item" onSelect={openReportHere}>
            <LifeBuoy className="h-4 w-4" /> Report an issue…
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => signOut().then(() => window.location.assign("/login"))}>
            <LogOut className="h-4 w-4" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Admins only: link to user management, with the number waiting for approval. */
function UsersLink({ nav }: { nav: (a: { isActive: boolean }) => string }) {
  const me = useMe();
  const trpc = useTRPC();
  const isAdmin = me.data?.role === "admin";
  const pending = useQuery({ ...trpc.admin.users.pendingCount.queryOptions(), enabled: isAdmin, refetchInterval: 30_000 });
  if (!isAdmin) return null;
  return (
    <NavLink to="/admin/users" className={nav}>
      Users
      {pending.data ? <span className="ml-1.5 rounded-full bg-warn-soft px-1.5 py-0.5 font-mono text-[11px] text-ink" title="Waiting for approval">{pending.data}</span> : null}
    </NavLink>
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
        <NavLink to="/library" className={nav}>
          Library
        </NavLink>
        <NavLink to="/settings" className={nav}>
          Settings
        </NavLink>
        <UsersLink nav={nav} />
      </nav>
      <div className="flex-1" />
      <MachineChip />
      <SearchButton />
      <button className="btn-ghost h-[34px] w-[34px] px-0" onClick={openReportHere} title="Report an issue (!)" aria-label="Report an issue">
        <LifeBuoy className="h-4 w-4" />
      </button>
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
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>{children}</Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}

/** What shows while a page's code loads (the bar stays; only the content area is a skeleton). */
function PageFallback() {
  return (
    <SkeletonRegion label="Loading…" className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full rounded-[16px]" />
    </SkeletonRegion>
  );
}

/** What shows while the session and account load: a bar and a few content blocks, no "Loading…" text. */
function AppSkeleton() {
  return (
    <SkeletonRegion label="Loading…" className="flex h-screen flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 sm:px-6">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="ml-auto h-8 w-8 rounded-full" />
      </div>
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="aspect-video rounded-[16px]" />
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

function Protected({ children, bare, admin }: { children: React.ReactNode; bare?: boolean; admin?: boolean }) {
  const { data, isPending } = useSession();
  const me = useMe(!!data);
  if (isPending || (data && me.isPending)) return <AppSkeleton />;
  if (!data) return <Navigate to="/login" replace />;
  // waiting for approval or suspended: one page, nothing else (the server refuses everything anyway)
  if (me.data?.blocked) return <PendingPage />;
  if (admin && me.data?.role !== "admin") return <Navigate to="/" replace />;
  // the editor hides the global bar so the timeline gets the room
  if (bare)
    return (
      <div className="flex h-screen flex-col overflow-hidden">
        <ErrorBoundary>
          <Suspense fallback={<PageFallback />}>{children}</Suspense>
        </ErrorBoundary>
      </div>
    );
  return <Shell>{children}</Shell>;
}

/** The one toast host (sonner), themed with the app tokens so light and dark follow lib/theme.ts. Narrow screens get sonner's full-width bottom layout. */
function AppToaster() {
  const [theme] = useTheme();
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      richColors={false}
      offset={16}
      mobileOffset={12}
      toastOptions={{
        classNames: {
          toast: "!rounded-[14px] !border !border-line !bg-panel !text-ink !shadow-pop !text-[13px] !font-semibold",
          title: "!text-ink",
          description: "!text-ink2",
          error: "!border-err",
        },
      }}
    />
  );
}

export function App() {
  return (
    <UploadsProvider>
    <CommandPaletteProvider>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/consent" element={<ConsentPage />} />
      <Route path="/" element={<Protected><ProjectsPage /></Protected>} />
      <Route path="/new" element={<Protected><NewProjectPage /></Protected>} />
      <Route path="/library" element={<Protected><LibraryPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="/admin/users" element={<Protected admin><AdminUsersPage /></Protected>} />
      <Route path="/p/:id" element={<Protected><ProjectPage /></Protected>} />
      <Route path="/p/:id/clips/:clipId" element={<Protected bare><ClipEditorPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    <ReportDialog />
    <AppToaster />
    </CommandPaletteProvider>
    </UploadsProvider>
  );
}
