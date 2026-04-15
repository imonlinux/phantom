import { MessageSquarePlus, Moon, Search, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/command";
import { useTheme } from "@/hooks/use-theme";
import type { SessionSummary } from "@/lib/client";

export function CommandPalette({
  sessions,
  onNewSession,
  onSessionClick,
}: {
  sessions: SessionSummary[];
  onNewSession: () => void;
  onSessionClick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSelect = useCallback(
    (value: string) => {
      setOpen(false);
      if (value === "new-session") {
        onNewSession();
      } else if (value === "toggle-theme") {
        toggleTheme();
      } else if (value.startsWith("session:")) {
        onSessionClick(value.slice(8));
      }
    },
    [onNewSession, onSessionClick, toggleTheme],
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search conversations..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Navigation">
          <CommandItem value="new-session" onSelect={handleSelect}>
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            New conversation
          </CommandItem>
          <CommandItem value="toggle-theme" onSelect={handleSelect}>
            {theme === "light" ? (
              <Moon className="mr-2 h-4 w-4" />
            ) : (
              <Sun className="mr-2 h-4 w-4" />
            )}
            Toggle theme
          </CommandItem>
        </CommandGroup>
        {sessions.length > 0 && (
          <CommandGroup heading="Conversations">
            {sessions.slice(0, 10).map((session) => (
              <CommandItem
                key={session.id}
                value={`session:${session.id}`}
                onSelect={handleSelect}
              >
                <Search className="mr-2 h-4 w-4" />
                {session.title ?? "Untitled conversation"}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
