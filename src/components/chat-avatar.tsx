import { HashIcon } from "lucide-react";
import { Wisp } from "@/components/wisp";
import type { AgentSettings, ChatCollection } from "@/chat-data";
import { getCircleMembers } from "@/lib/circle-members";

interface ChatAvatarProps {
  chat: AgentSettings;
  chats?: ChatCollection;
  size?: "default" | "sm" | "lg" | "xl";
}

function ChatAvatar({ chat, chats, size = "default" }: ChatAvatarProps) {
  if (chat.isCircle) {
    const members = chats ? getCircleMembers(chat, chats) : [];
    const visibleMembers = members.slice(0, members.length > 4 ? 3 : 4);
    return (
      <span className="circle-avatar" data-size={size} data-count={Math.min(members.length, 4)} aria-hidden="true">
        {members.length ? visibleMembers.map((member) => (
          <span className="circle-avatar-member" key={member.id}><ChatAvatar chat={member} size="sm" /></span>
        )) : <HashIcon />}
        {members.length > 4 ? <span className="circle-avatar-more">+{members.length - 3}</span> : null}
      </span>
    );
  }

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
