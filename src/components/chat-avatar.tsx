import { HashIcon } from "lucide-react";
import { Wisp } from "@/components/wisp";
import type { Chat, ChatCollection } from "@/chat-data";
import { getCircleMembers } from "@/lib/circle-members";
import { cn } from "@/lib/utils";

interface ChatAvatarProps {
  chat: Chat;
  chats?: ChatCollection;
  size?: "default" | "sm" | "lg" | "xl";
}

const CLUSTER_SLOTS = ["left-[30%] top-[4%]", "left-[5%] top-[38%]", "left-[41%] top-[40%]"];

function ChatAvatar({ chat, chats, size = "default" }: ChatAvatarProps) {
  if (chat.kind === "circle") {
    const members = chats ? getCircleMembers(chat, chats) : [];
    const tileSize =
      size === "sm"
        ? "size-6 rounded-md"
        : size === "lg"
          ? "size-9 rounded-lg"
          : size === "xl"
            ? "size-20 rounded-[18px]"
            : "size-8 rounded-lg";
    const ring = "ring-[#eeeeee] dark:ring-[#212120]";

    // Circles render as a bunch of overlapping round Wisps; the 2x2 grid is
    // kept for exactly four members where a bunch would hide one of them.
    if (members.length === 0 || members.length === 4) {
      return (
        <span
          className={cn(
            "grid flex-none place-content-center items-center justify-items-center overflow-hidden bg-[#eeeeee] dark:bg-[#212120]",
            tileSize,
            size === "sm"
              ? "gap-px p-0.5"
              : size === "lg"
                ? "gap-px p-0.5"
                : size === "xl"
                  ? "gap-[3px] p-[5px]"
                  : "gap-px p-0.5",
            members.length > 1 ? "grid-cols-2" : "grid-cols-1",
            "[&>svg]:h-[70%] [&>svg]:w-[70%]",
          )}
          aria-hidden="true"
        >
          {members.length ? (
            members.slice(0, 4).map((member) => (
              <span
                className="flex aspect-square w-full items-center justify-center [&>img]:size-full! [&>svg]:size-full!"
                key={member.id}
              >
                <ChatAvatar chat={member} size="sm" />
              </span>
            ))
          ) : (
            <HashIcon />
          )}
        </span>
      );
    }

    const visibleMembers = members.slice(0, members.length > 3 ? 2 : 3);
    return (
      <span
        className={cn("relative flex-none overflow-hidden bg-[#eeeeee] dark:bg-[#212120]", tileSize)}
        aria-hidden="true"
      >
        {visibleMembers.map((member, index) => (
          <span
            className={cn("absolute size-[54%] overflow-hidden rounded-full ring-2", ring, CLUSTER_SLOTS[index])}
            key={member.id}
          >
            {member.avatarImage ? (
              <img className="size-full object-cover" src={member.avatarImage} alt="" />
            ) : (
              <Wisp className="size-full" color={member.color} name={member.name} shape="circle" />
            )}
          </span>
        ))}
        {members.length > 3 ? (
          <span
            className={cn(
              "absolute flex size-[54%] items-center justify-center rounded-full bg-[#dcdcdc] font-semibold text-[#555555] ring-2 dark:bg-[#3a3a3a] dark:text-[#c9c9c9]",
              ring,
              size === "sm" ? "text-[6px]" : size === "xl" ? "text-[16px]" : "text-[8px]",
              CLUSTER_SLOTS[2],
            )}
          >
            +{members.length - 2}
          </span>
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

  return <Wisp aria-hidden="true" color={chat.color} name={chat.name} shape={chat.shape} size={size} />;
}

export { ChatAvatar };
export type { ChatAvatarProps };
