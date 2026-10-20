import { HashIcon } from "lucide-react";
import { Wisp, type WispState } from "@/components/wisp";
import type { ChatView, Wisp as WispEntity } from "@/chat-data";
import { cn } from "@/lib/utils";

type AvatarSize = "default" | "sm" | "lg" | "xl";

interface ChatAvatarProps {
  chat: ChatView;
  size?: AvatarSize;
  /** What a Wisp's conversation is doing; circles do not show it. */
  state?: WispState;
}

interface WispAvatarProps {
  wisp: Pick<WispEntity, "name" | "appearance" | "color">;
  size?: AvatarSize;
  state?: WispState;
}

const CLUSTER_SLOTS = ["left-[30%] top-[4%]", "left-[5%] top-[38%]", "left-[41%] top-[40%]"];
/** The count of the others, centered on the third slot and about as big as a Wisp's body in it. */
const COUNT_SLOT = "left-[48%] top-[47%] size-[40%]";

/** A conversation's picture: its Wisp's, or a circle's members together. */
function ChatAvatar({ chat, size = "default", state }: ChatAvatarProps) {
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

    // Circles render as a bunch of overlapping Wisps; the 2x2 grid is
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
        {/* The count sits behind the Wisps, which come first. */}
        {members.length > 3 ? (
          <span
            className={cn(
              "absolute flex items-center justify-center rounded-full bg-foreground/15 font-semibold text-foreground",
              size === "sm" ? "text-[5px]" : size === "xl" ? "text-[13px]" : "text-[7px]",
              COUNT_SLOT,
            )}
          >
            +{members.length - 2}
          </span>
        ) : null}
        {visibleMembers.map((member, index) => (
          <span className={cn("absolute size-[54%]", CLUSTER_SLOTS[index])} key={member.id}>
            {/* Without its trail a Wisp stays in its slot; `!` beats the size the `sm` variant sets. */}
            <Wisp
              className="size-full!"
              appearance={{ ...member.appearance, trail: "none" }}
              color={member.color}
              name={member.name}
              size="sm"
            />
          </span>
        ))}
      </span>
    );
  }

  return <WispAvatar wisp={chat.wisp} size={size} state={state} />;
}

/** A Wisp drawn from its appearance. */
function WispAvatar({ wisp, size = "default", state }: WispAvatarProps) {
  return (
    <Wisp
      aria-hidden="true"
      appearance={wisp.appearance}
      color={wisp.color}
      name={wisp.name}
      size={size}
      state={state}
    />
  );
}

export { ChatAvatar, WispAvatar };
export type { ChatAvatarProps, WispAvatarProps };
