import { Paperclip } from "lucide-react";
import { Button } from "@/ui/button";

export function ChatInputToolbar() {
  return (
    <div className="flex items-center gap-1 px-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground"
        aria-label="Attach file"
        disabled
        title="File attachments coming soon"
      >
        <Paperclip className="h-4 w-4" />
      </Button>
    </div>
  );
}
