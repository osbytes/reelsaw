import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, Link, NavLink, useLocation, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { Moon, Sun, LogOut, LifeBuoy, Settings as SettingsIcon } from "lucide-react";
import { ReportDialog } from "./components/ReportDialog";
import { openReportHere } from "./lib/report";
import { useSession, signOut } from "./lib/auth";
import { useTRPC } from "./lib/trpc";
import { useTheme } from "./lib/theme";
import { MOD, useShortcuts } from "./lib/shortcuts";
import { LoginPage } from "./pages/Login";
import { ProjectsPage } from "./pages/Projects";
const NewProjectPage = lazy(() => import("./pages/NewProject").then((m) => ({ default: m.NewProjectPage })));
const ProjectPage = lazy(() => import("./pages/Project").then((m) => ({ default: m.ProjectPage })));
const LibraryPage = lazy(() => import("./pages/Library").then((m) => ({ default: m.LibraryPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
import { UpdateDot, UpdateMenuHint } from "./components/UpdateNotice";
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

/** The "cut monogram" mark: an ExtraBold Hanken Grotesk "r" (outlined, so it never waits on the web font) sliced by a cut in the accent colour. Same drawing as public/favicon.svg. */
const MARK_R = "M23.69 47V24.32H30.07V30.5L29.2 30.55Q29.3 28.6 30.3 27.09Q31.3 25.57 32.82 24.71Q34.34 23.84 35.94 23.84Q37.11 23.84 38.17 24.17Q39.23 24.49 40.39 25.22L37.35 30.93Q36.87 30.61 36.06 30.38Q35.25 30.14 34.45 30.14Q33.6 30.14 32.81 30.44Q32.03 30.74 31.43 31.38Q30.83 32.01 30.48 33.01Q30.26 33.65 30.14 34.65Q30.03 35.65 30.03 37.55V47Z";

export function LogoMark({ className = "h-[26px] w-[26px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={`shrink-0 ${className}`} aria-hidden>
      <rect width="64" height="64" rx="16" className="fill-acc" />
      <path d={MARK_R} className="fill-acc-ink" />
      <line x1="14" y1="40" x2="50" y2="26" strokeWidth="4" className="stroke-acc" />
    </svg>
  );
}

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5 text-ink no-underline" aria-label="Reelsaw">
      <LogoMark />
      <span className="hidden text-[15px] font-extrabold tracking-tight sm:inline" aria-hidden>
        reel<span className="mx-px font-medium text-acc-text">/</span>saw
      </span>
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
      {/* the mono glyph's ink sits low in its box; a pixel up centres it on the text */}
      <span className="relative -top-px font-mono leading-none" aria-hidden>
        ◷
      </span>
      <span className="hidden sm:inline">Jobs paused · {reason}</span>
    </Link>
  );
}

/** Account menu: settings (with the update hint for admins), report, sign out. */
function Avatar() {
  const { data } = useSession();
  const navigate = useNavigate();
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
        <button className="relative grid h-[30px] w-[30px] place-items-center rounded-full bg-acc-soft text-xs font-bold text-acc-text" title={u.email} aria-label="Account">
          {initials}
          <UpdateDot />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="menu">
          <DropdownMenu.Label className="px-2.5 py-1.5 text-xs text-ink3">{u.email}</DropdownMenu.Label>
          <DropdownMenu.Item className="menu-item" onSelect={() => navigate("/settings")}>
            <SettingsIcon className="h-4 w-4" /> Settings
            <UpdateMenuHint />
          </DropdownMenu.Item>
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
    <button onClick={() => open()} className="flex h-[34px] min-w-0 shrink items-center gap-2 rounded-[10px] border border-line bg-sunk px-2.5 text-[13px] text-ink3 hover:text-ink sm:w-[240px]" aria-label="Search">
      <Search className="h-4 w-4 shrink-0" />
      <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">Search or paste a link…</span>
      <span className="kbd hidden shrink-0 sm:inline-grid">{mod}K</span>
    </button>
  );
}

export function TopBar() {
  const nav = ({ isActive }: { isActive: boolean }) => `rounded-[9px] px-2.5 py-[7px] whitespace-nowrap no-underline sm:px-3 ${isActive ? "bg-sunk font-semibold text-ink" : "text-ink2 hover:text-ink"}`;
  const loc = useLocation();
  const inProjects = loc.pathname === "/" || loc.pathname.startsWith("/p/") || loc.pathname === "/new";
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-5 sm:px-5">
      <Logo />
      <nav className="flex shrink-0 gap-0.5 sm:gap-1">
        <NavLink to="/" className={() => nav({ isActive: inProjects })}>
          Projects
        </NavLink>
        <NavLink to="/library" className={nav}>
          Library
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
  useShortcuts("Everywhere", [
    ["Search, jump or run an action", `${MOD}K`],
    ["Report an issue", "!"],
    ["Show this list", "?"],
  ]);
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
      <Route path="/settings/system" element={<Protected admin><SettingsPage /></Protected>} />
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
