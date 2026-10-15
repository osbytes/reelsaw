import { Routes, Route, Navigate, Link, useLocation } from "react-router";
import { Scissors, LogOut, Settings, Plus } from "lucide-react";
import { useSession, signOut } from "./lib/auth";
import { LoginPage } from "./pages/Login";
import { ProjectsPage } from "./pages/Projects";
import { NewProjectPage } from "./pages/NewProject";
import { ProjectPage } from "./pages/Project";
import { SettingsPage } from "./pages/Settings";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ScrollArea } from "./components/scroll-area";

function Shell({ children }: { children: React.ReactNode }) {
  const { data } = useSession();
  const loc = useLocation();
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="z-10 shrink-0 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Scissors className="h-5 w-5 text-accent" /> Reelsaw
          </Link>
          <nav className="flex items-center gap-2 text-sm sm:gap-3">
            {loc.pathname !== "/new" && (
              <Link to="/new" className="btn-primary whitespace-nowrap">
                <Plus className="h-4 w-4 sm:hidden" />
                <span className="hidden sm:inline">New project</span>
              </Link>
            )}
            <Link to="/settings" className="btn-ghost" title="Settings">
              <Settings className="h-4 w-4" />
            </Link>
            {data?.user && (
              <button className="btn-ghost" onClick={() => signOut().then(() => window.location.assign("/login"))} title={data.user.email}>
                <LogOut className="h-4 w-4" /> <span className="hidden sm:inline">{data.user.name || data.user.email}</span>
              </button>
            )}
          </nav>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto max-w-6xl px-4 py-6">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </ScrollArea>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { data, isPending } = useSession();
  if (isPending) return <div className="p-10 text-center text-muted">Loading…</div>;
  if (!data) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <ProjectsPage />
          </Protected>
        }
      />
      <Route
        path="/new"
        element={
          <Protected>
            <NewProjectPage />
          </Protected>
        }
      />
      <Route
        path="/settings"
        element={
          <Protected>
            <SettingsPage />
          </Protected>
        }
      />
      <Route
        path="/p/:id"
        element={
          <Protected>
            <ProjectPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
