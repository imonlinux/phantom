import { useEffect, useState } from "react";
import { getBootstrap, type BootstrapData } from "@/lib/client";

export function EmptyState({
  onSuggestionClick,
}: {
  onSuggestionClick: (text: string) => void;
}) {
  const [data, setData] = useState<BootstrapData | null>(null);

  useEffect(() => {
    getBootstrap()
      .then(setData)
      .catch(() => {});
  }, []);

  const defaultSuggestions = [
    "What can you do?",
    "Show me your current configuration",
    "What scheduled jobs do you have?",
    "Tell me about your recent activity",
  ];

  const suggestions = data?.suggestions?.length
    ? data.suggestions
    : defaultSuggestions;

  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="max-w-2xl text-center">
        <h1 className="font-serif text-4xl tracking-tight text-foreground sm:text-5xl">
          What can I help you with?
        </h1>
        <p className="mt-4 text-base text-muted-foreground">
          {data?.agent_name ?? "Phantom"} is ready to help.
          {data?.evolution_gen != null && data.evolution_gen > 0
            ? ` Generation ${data.evolution_gen}.`
            : ""}
        </p>
      </div>

      <div className="mt-8 flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggestionClick(suggestion)}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
