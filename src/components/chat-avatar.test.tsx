import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatAvatar } from "@/components/chat-avatar";
import { circleChatView, testWisp } from "@/test/chat-fixtures";

const wisps = ["atlas", "nova", "orion", "lyra", "vega"].map((id) =>
  testWisp(id, { appearance: { ...testWisp(id).appearance, body: "drop", trail: "hook" } }),
);

describe("ChatAvatar", () => {
  it("draws a circle's Wisps with their own bodies and trails, filling their slots", () => {
    const { container } = render(<ChatAvatar chat={circleChatView("crew", wisps.slice(0, 3))} size="xl" />);

    const drawn = container.querySelectorAll("[data-slot=wisp]");
    expect(drawn).toHaveLength(3);
    for (const wisp of drawn) expect(wisp).toHaveClass("size-full!");
    expect(container.querySelectorAll(".wisp-trail")).toHaveLength(3);
    expect(container.querySelector(".ring-2")).toBeNull();
  });

  it("raises a Wisp with a trail so its body lines up with one without", () => {
    const trailless = testWisp("lyra", { appearance: { ...testWisp("lyra").appearance, trail: "none" } });
    const { container } = render(<ChatAvatar chat={circleChatView("crew", [trailless, ...wisps.slice(0, 2)])} />);

    const slots = [...container.firstElementChild!.children];
    expect(slots.map((slot) => slot.classList.contains("-translate-y-[12%]"))).toEqual([false, true, true]);
  });

  it("sets two Wisps side by side and centers one alone, bigger", () => {
    const tile = (members: typeof wisps) => [
      ...render(<ChatAvatar chat={circleChatView("crew", members)} />).container.firstElementChild!.children,
    ];

    const [left, right] = tile(wisps.slice(0, 2));
    expect(left).toHaveClass("left-[4%]", "size-[54%]");
    expect(right).toHaveClass("left-[42%]", "size-[54%]");
    expect(tile(wisps.slice(0, 1))[0]).toHaveClass("left-[12%]", "size-[76%]");
  });

  it("puts the count of the others behind the Wisps shown", () => {
    const { container } = render(<ChatAvatar chat={circleChatView("crew", wisps)} />);

    const tile = container.firstElementChild!;
    expect(tile.firstElementChild).toHaveTextContent("+3");
    expect(tile.querySelectorAll("[data-slot=wisp]")).toHaveLength(2);
  });
});
