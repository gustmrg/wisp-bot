import { Wisp } from "@/components/wisp";
import type { Chat } from "@/chat-data";

interface ChatAvatarProps {
  chat: Chat;
  size?: "default" | "sm" | "lg" | "xl";
}

function ChatAvatar({ chat, size = "default" }: ChatAvatarProps) {
  if (chat.avatarImage) {
    return <img className="chat-avatar-image" data-size={size} src={chat.avatarImage} alt="" />;
  }

  return (
    <Wisp
      aria-hidden="true"
      color={chat.color}
      name={chat.name}
      shape={chat.shape}
      size={size}
    />
  );
}

export { ChatAvatar };
export type { ChatAvatarProps };
