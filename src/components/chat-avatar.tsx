import { Wisp } from "@/components/wisp";
import type { Chat } from "@/chat-data";

interface ChatAvatarProps {
  chat: Chat;
  size?: "default" | "sm" | "lg";
}

function ChatAvatar({ chat, size = "default" }: ChatAvatarProps) {
  return (
    <Wisp
      aria-hidden="true"
      color={chat.color}
      name={chat.name}
      size={size}
    />
  );
}

export { ChatAvatar };
export type { ChatAvatarProps };
