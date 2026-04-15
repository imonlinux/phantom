import { useCallback, useRef, useSyncExternalStore } from "react";
import { abortSession, getSession, type SessionDetail } from "@/lib/client";
import type { ChatMessage, ToolCallState } from "@/lib/chat-types";
import { createChatStore, dispatchFrame, type ChatStore } from "@/lib/chat-store";

export function useChat(sessionId: string | null): {
  messages: ChatMessage[];
  activeToolCalls: Map<string, ToolCallState>;
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  abort: () => void;
  loadSession: (id: string) => void;
} {
  const storeRef = useRef<ChatStore>(createChatStore());
  const abortRef = useRef<AbortController | null>(null);
  const store = storeRef.current;

  const state = useSyncExternalStore(store.subscribe, store.getState);

  const processSSEStream = useCallback(
    async (body: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const reader = body.getReader();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line.startsWith("id: ")) {
            const seq = parseInt(line.slice(4), 10);
            if (!isNaN(seq)) {
              store.update((s) => ({
                ...s,
                lastSeq: Math.max(s.lastSeq, seq),
              }));
            }
          } else if (line === "" && currentEvent && currentData) {
            dispatchFrame(store, currentEvent, currentData);
            currentEvent = "";
            currentData = "";
          }
        }
      }

      store.update((s) => ({ ...s, isStreaming: false }));
    },
    [store],
  );

  const sendMessage = useCallback(
    (text: string) => {
      if (!sessionId) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      store.update((s) => ({ ...s, isStreaming: true }));

      fetch("/chat/stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          text,
          tab_id: "web-" + Date.now(),
        }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok || !res.body) {
            store.update((s) => ({ ...s, isStreaming: false }));
            return;
          }
          return processSSEStream(res.body);
        })
        .catch(() => {
          store.update((s) => ({ ...s, isStreaming: false }));
        });
    },
    [sessionId, store, processSSEStream],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    if (sessionId) {
      abortSession(sessionId).catch(() => {});
    }
    store.update((s) => ({ ...s, isStreaming: false }));
  }, [sessionId, store]);

  const loadSession = useCallback(
    (id: string) => {
      store.reset(id);
      getSession(id)
        .then((detail: SessionDetail) => {
          const msgs = detail.messages.map(messageRowToChatMessage);
          store.update((s) => ({ ...s, messages: msgs, sessionId: id }));
        })
        .catch(() => {});
    },
    [store],
  );

  return {
    messages: state.messages,
    activeToolCalls: state.activeToolCalls,
    isStreaming: state.isStreaming,
    sendMessage,
    abort,
    loadSession,
  };
}

function messageRowToChatMessage(
  row: SessionDetail["messages"][number],
): ChatMessage {
  let contentBlocks: Array<{
    type: string;
    text?: string;
    [key: string]: unknown;
  }> = [];
  try {
    const parsed = JSON.parse(row.content_json);
    contentBlocks = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    contentBlocks = [{ type: "text", text: row.content_json }];
  }

  return {
    id: row.id,
    role: row.role as "user" | "assistant",
    content: contentBlocks,
    createdAt: row.created_at,
    status: row.status as "committed" | "streaming" | "error",
    stopReason: row.stop_reason,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}
