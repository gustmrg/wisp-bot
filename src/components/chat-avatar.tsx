import { HashIcon } from "lucide-react";
import { Wisp } from "@/components/wisp";
import type { AgentSettings, ChatCollection } from "@/chat-data";
import { getCircleMembers } from "@/lib/circle-members";
import { cn } from "@/lib/utils";

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
      <span
        className={cn(
          "grid flex-none place-content-center items-center justify-items-center overflow-hidden bg-[#eeeeee] dark:bg-[#161616]",
          size === "sm" ? "size-6 gap-px rounded-md p-0.5"
            : size === "lg" ? "size-9 gap-px rounded-lg p-0.5"
            : size === "xl" ? "size-20 gap-[3px] rounded-[18px] p-[5px]"
            : "size-8 gap-px rounded-lg p-0.5",
          members.length > 1 ? "grid-cols-2" : "grid-cols-1",
          "[&>svg]:h-[70%] [&>svg]:w-[70%]",
        )}
        aria-hidden="true"
      >
        {members.length ? visibleMembers.map((member) => (
          <span className="flex aspect-square w-full items-center justify-center [&>img]:size-full! [&>svg]:size-full!" key={member.id}><ChatAvatar chat={member} size="sm" /></span>
        )) : <HashIcon />}
        {members.length > 4 ? (
          <span className={cn("text-dim leading-none", size === "sm" ? "text-[6px]" : size === "xl" ? "text-[18px]" : "text-[8px]")}>+{members.length - 3}</span>
        ) : null}
      </span>
    );
  }

  if (chat.avatarImage) {
    return (
      <img
        className={cn(
          "flex-none rounded-[28%] object-cover",
          size === "sm" ? "size-6" : size === "lg" ? "size-9" : size === "xl" ? "size-14" : "size-8",
        )}
        src={chat.avatarImage}
        alt=""
      />
    );
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
