import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useKeyboard } from "@/hooks/use-keyboard";
import { useSessions } from "@/hooks/use-sessions";
import { useTheme } from "@/hooks/use-theme";
import { useIsMobile } from "@/hooks/use-mobile";
import { CommandPalette } from "./command-palette";
import { DeleteSessionDialog } from "./delete-session-dialog";
import { SidebarPanel } from "./sidebar-panel";

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { sessions, isLoading, createSession, deleteSession, updateSession } =
    useSessions();
  const { toggleTheme } = useTheme();
  const isMobile = useIsMobile();

  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string | null;
  } | null>(null);

  const handleNewSession = useCallback(async () => {
    const id = await createSession();
    navigate(`/s/${id}`);
  }, [createSession, navigate]);

  const handleSessionClick = useCallback(
    (id: string) => {
      navigate(`/s/${id}`);
      if (isMobile) setSidebarOpen(false);
    },
    [navigate, isMobile],
  );

  const handleRename = useCallback(
    (id: string, title: string) => {
      updateSession(id, { title });
    },
    [updateSession],
  );

  const handleDeleteRequest = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      setDeleteTarget({ id, title: session?.title ?? null });
    },
    [sessions],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    deleteSession(deleteTarget.id);
    setDeleteTarget(null);
    if (deleteTarget.id === sessionId) {
      navigate("/");
    }
  }, [deleteTarget, deleteSession, sessionId, navigate]);

  useKeyboard({
    newSession: handleNewSession,
    toggleTheme,
  });

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {sidebarOpen && (
        <div className="w-64 shrink-0 border-r border-border">
          <SidebarPanel
            sessions={sessions}
            isLoading={isLoading}
            activeSessionId={sessionId ?? null}
            onSessionClick={handleSessionClick}
            onNewSession={handleNewSession}
            onRename={handleRename}
            onDelete={handleDeleteRequest}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center border-b border-border px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="mr-3 text-muted-foreground hover:text-foreground"
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              className="h-4 w-4"
            >
              <path
                d="M2 4h12M2 8h12M2 12h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="text-sm font-medium text-foreground">Phantom</span>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>

      <CommandPalette
        sessions={sessions}
        onNewSession={handleNewSession}
        onSessionClick={handleSessionClick}
      />

      <DeleteSessionDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={handleDeleteConfirm}
        sessionTitle={deleteTarget?.title ?? null}
      />
    </div>
  );
}
