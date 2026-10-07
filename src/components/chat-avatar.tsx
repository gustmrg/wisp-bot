import { HashIcon } from "lucide-react";
import { Wisp } from "@/components/wisp";
import type { ChatView, Wisp as WispEntity } from "@/chat-data";
import { cn } from "@/lib/utils";

type AvatarSize = "default" | "sm" | "lg" | "xl";

interface ChatAvatarProps {
  chat: ChatView;
  size?: AvatarSize;
}

interface WispAvatarProps {
  wisp: Pick<WispEntity, "name" | "shape" | "color" | "avatarImage">;
  size?: AvatarSize;
}

const CLUSTER_SLOTS = ["left-[30%] top-[4%]", "left-[5%] top-[38%]", "left-[41%] top-[40%]"];

/** A conversation's picture: its Wisp's, or a circle's members together. */
function ChatAvatar({ chat, size = "default" }: ChatAvatarProps) {
  if (chat.kind === "circle") {
    const members = chat.members;
    const tileSize =
      size === "sm"
        ? "size-6 rounded-md"
        : size === "lg"
          ? "size-9 rounded-lg"
          : size === "xl"
            ? "size-20 rounded-[18px]"
            : "size-8 rounded-lg";
    const ring = "ring-muted";

    // Circles render as a bunch of overlapping round Wisps; the 2x2 grid is
    // kept for exactly four members where a bunch would hide one of them.
    if (members.length === 0 || members.length === 4) {
      return (
        <span
          className={cn(
            "grid flex-none place-content-center items-center justify-items-center overflow-hidden bg-muted",
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
                <WispAvatar wisp={member} size="sm" />
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
      <span className={cn("relative flex-none overflow-hidden bg-muted", tileSize)} aria-hidden="true">
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
              "absolute flex size-[54%] items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground ring-2",
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

  return <WispAvatar wisp={chat.wisp} size={size} />;
}

/** A Wisp's uploaded picture, or its shape in its color. */
function WispAvatar({ wisp, size = "default" }: WispAvatarProps) {
  if (wisp.avatarImage) {
    return (
      <img
        className={cn(
          "flex-none rounded-[28%] object-cover",
          size === "sm" ? "size-6" : size === "lg" ? "size-9" : size === "xl" ? "size-14" : "size-8",
        )}
        src={wisp.avatarImage}
        alt=""
      />
    );
  }

  return <Wisp aria-hidden="true" color={wisp.color} name={wisp.name} shape={wisp.shape} size={size} />;
}

export { ChatAvatar, WispAvatar };
export type { ChatAvatarProps, WispAvatarProps };
