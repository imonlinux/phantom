import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@/components/empty-state";
import { ChatInput } from "@/components/chat-input";
import { createSession } from "@/lib/client";

export function ChatRoute() {
  const navigate = useNavigate();

  const handleSuggestionClick = useCallback(
    async (text: string) => {
      const result = await createSession();
      navigate(`/s/${result.id}`, { state: { initialMessage: text } });
    },
    [navigate],
  );

  return (
    <>
      <EmptyState onSuggestionClick={handleSuggestionClick} />
      <ChatInput
        onSend={async (text) => {
          const result = await createSession();
          navigate(`/s/${result.id}`, { state: { initialMessage: text } });
        }}
        onStop={() => {}}
        isStreaming={false}
      />
    </>
  );
}
