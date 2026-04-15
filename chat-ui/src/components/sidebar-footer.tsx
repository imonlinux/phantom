import { useEffect, useState } from "react";
import { getBootstrap, type BootstrapData } from "@/lib/client";
import { ThemeToggle } from "./theme-toggle";

export function SidebarFooter() {
  const [data, setData] = useState<BootstrapData | null>(null);

  useEffect(() => {
    getBootstrap()
      .then(setData)
      .catch(() => {});
  }, []);

  return (
    <div className="border-t border-sidebar-border px-3 py-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-sidebar-foreground">
            {data?.agent_name ?? "Phantom"}
          </div>
          <div className="flex gap-2 text-xs text-sidebar-muted-foreground">
            {data?.evolution_gen != null && (
              <span>Gen {data.evolution_gen}</span>
            )}
          </div>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}
