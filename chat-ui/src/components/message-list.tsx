import { ArrowDown } from "lucide-react";
import { useMemo } from "react";
import { useAutoScroll } from "@/hooks/use-auto-scroll";
import type { ChatMessage, ThinkingBlockState, ToolCallState } from "@/lib/chat-types";
import { Button } from "@/ui/button";
import { Message } from "./message";
import { MessageActions } from "./message-actions";

export function MessageList({
  messages,
  activeToolCalls,
  thinkingBlocks,
}: {
  messages: ChatMessage[];
  activeToolCalls: Map<string, ToolCallState>;
  thinkingBlocks: Map<string, ThinkingBlockState>;
}) {
  const { containerRef, isAtBottom, scrollToBottom } = useAutoScroll();

  const toolCallsByMessage = useMemo(() => {
    const map = new Map<string, ToolCallState[]>();
    for (const [, tc] of activeToolCalls) {
      const existing = map.get(tc.messageId) ?? [];
      existing.push(tc);
      map.set(tc.messageId, existing);
    }
    return map;
  }, [activeToolCalls]);

  const thinkingByMessage = useMemo(() => {
    const map = new Map<string, ThinkingBlockState[]>();
    for (const [, tb] of thinkingBlocks) {
      const existing = map.get(tb.messageId) ?? [];
      existing.push(tb);
      map.set(tb.messageId, existing);
    }
    return map;
  }, [thinkingBlocks]);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        className="h-full overflow-y-auto px-4 py-4"
      >
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((message) => (
            <div key={message.id} className="group relative">
              <Message
                message={message}
                toolCalls={toolCallsByMessage.get(message.id) ?? []}
                thinkingBlocks={thinkingByMessage.get(message.id) ?? []}
              />
              {message.role === "assistant" && (
                <MessageActions message={message} />
              )}
            </div>
          ))}
        </div>
      </div>

      {!isAtBottom && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => scrollToBottom()}
            className="gap-1 shadow-md"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to bottom
          </Button>
        </div>
      )}
    </div>
  );
}
