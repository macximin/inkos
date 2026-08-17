import { memo } from "react";
import type { Theme } from "../../hooks/use-theme";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "../ai-elements/message";
import { XCircle } from "lucide-react";
import { localizeKnownRuntimeMessage } from "../../lib/error-copy";

export interface ChatMessageProps {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly theme: Theme;
}

export const ChatMessage = memo(function ChatMessage({
  role,
  content,
}: ChatMessageProps) {
  const isUser = role === "user";
  const displayContent = isUser ? content : localizeKnownRuntimeMessage(content);
  const isError = displayContent.startsWith("\u2717");

  return (
    <Message from={role}>
      <MessageContent>
        {isUser ? (
          <div className="text-[17px] leading-[1.72]">{displayContent}</div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-[17px] leading-[1.72] text-destructive">
            <XCircle size={14} className="shrink-0" />
            <span>{displayContent.replace(/^\u2717\s*/, "")}</span>
          </div>
        ) : (
          <MessageResponse>{displayContent}</MessageResponse>
        )}
      </MessageContent>
    </Message>
  );
});

ChatMessage.displayName = "ChatMessage";
