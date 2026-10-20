import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChatAvatar } from "@/components/chat-avatar";
import { circleChatView, testWisp } from "@/test/chat-fixtures";

const wisps = ["atlas", "nova", "orion", "lyra", "vega"].map((id) =>
  testWisp(id, { appearance: { ...testWisp(id).appearance, body: "drop", trail: "hook" } }),
);

describe("ChatAvatar", () => {
  it("draws a circle's Wisps with their own bodies, without trails, filling their slots", () => {
    const { container } = render(<ChatAvatar chat={circleChatView("crew", wisps.slice(0, 3))} size="xl" />);

    const drawn = container.querySelectorAll("[data-slot=wisp]");
    expect(drawn).toHaveLength(3);
    for (const wisp of drawn) expect(wisp).toHaveClass("size-full!");
    expect(container.querySelector(".wisp-trail")).toBeNull();
    expect(container.querySelector(".ring-2")).toBeNull();
  });

  it("puts the count of the others behind the Wisps shown", () => {
    const { container } = render(<ChatAvatar chat={circleChatView("crew", wisps)} />);

    const tile = container.firstElementChild!;
    expect(tile.firstElementChild).toHaveTextContent("+3");
    expect(tile.querySelectorAll("[data-slot=wisp]")).toHaveLength(2);
  });
});
