import { useCallback, useEffect } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useChat } from "@/hooks/use-chat";
import { ChatInput } from "@/components/chat-input";
import { MessageList } from "@/components/message-list";

export function SessionRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const {
    messages,
    activeToolCalls,
    isStreaming,
    sendMessage,
    abort,
    loadSession,
  } = useChat(sessionId ?? null);

  useEffect(() => {
    if (sessionId) {
      loadSession(sessionId);
    }
  }, [sessionId, loadSession]);

  // Handle initial message passed from the welcome state
  useEffect(() => {
    const state = location.state as { initialMessage?: string } | null;
    if (state?.initialMessage && sessionId) {
      sendMessage(state.initialMessage);
      // Clear the state so it doesn't re-fire
      window.history.replaceState({}, "", location.pathname);
    }
  }, [sessionId, location.state, location.pathname, sendMessage]);

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  const emptyThinking = new Map<string, never>();

  return (
    <>
      <MessageList
        messages={messages}
        activeToolCalls={activeToolCalls}
        thinkingBlocks={emptyThinking}
      />
      <ChatInput
        onSend={handleSend}
        onStop={abort}
        isStreaming={isStreaming}
      />
    </>
  );
}
