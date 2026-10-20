import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MarkdownView } from "@/components/markdown-view";

const members = [
  { id: "nova", name: "Nova" },
  { id: "orion", name: "Orion" },
];

describe("mentions in Markdown", () => {
  it("sets apart the members a reply mentions, each opening its Wisp", async () => {
    const user = userEvent.setup();
    const onOpenWisp = vi.fn();
    const { container } = render(
      <MarkdownView text={"Over to @Orion, then **@nova** checks it."} mentions={{ members, onOpenWisp }} />,
    );

    await user.click(screen.getByRole("button", { name: "@Orion" }));
    await user.click(screen.getByRole("button", { name: "@nova" }));
    expect(onOpenWisp.mock.calls).toEqual([["orion"], ["nova"]]);
    // Nothing is added or lost around the mentions.
    expect(container).toHaveTextContent("Over to @Orion, then @nova checks it.", { normalizeWhitespace: false });
    expect(container.querySelector("strong")).toHaveTextContent("@nova");
  });

  it("leaves email addresses, links, code and other names as they are", () => {
    const text = [
      "Write to nova@example.com or <orion@example.com>, or mail me at ada@Nova.",
      "",
      "See [@Nova](https://example.com/nova), run `@Orion deploy`, ask @Novak or @Nobody.",
      "",
      "```",
      "@Nova in a block",
      "```",
    ].join("\n");
    const { container } = render(<MarkdownView text={text} mentions={{ members, onOpenWisp: vi.fn() }} />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "nova@example.com" })).toHaveAttribute("href", "mailto:nova@example.com");
    expect(screen.getByRole("link", { name: "orion@example.com" })).toHaveAttribute("href", "mailto:orion@example.com");
    expect(screen.getByRole("link", { name: "@Nova" })).toHaveAttribute("href", "https://example.com/nova");
    expect(container.querySelector("p code")).toHaveTextContent("@Orion deploy");
    expect(container.querySelector("pre")).toHaveTextContent("@Nova in a block");
    expect(container).toHaveTextContent("mail me at ada@Nova.");
  });

  it("renders the same Markdown without members", () => {
    const text = "Ask @Nova at nova@example.com";
    const plain = render(<MarkdownView text={text} />).container.innerHTML;
    const none = render(<MarkdownView text={text} mentions={{ members: [] }} />).container.innerHTML;

    expect(none).toBe(plain);
    expect(plain).not.toContain("<button");
  });
});
