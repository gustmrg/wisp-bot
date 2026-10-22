import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WispChatDisplaySettings } from "@/components/wisp-chat-display-settings";
import { testWisp } from "@/test/chat-fixtures";

describe("WispChatDisplaySettings", () => {
  it("saves whether the chat shows the Wisp's reasoning as soon as it is switched", async () => {
    const onChangeWisp = vi.fn(async () => true);
    const { rerender } = render(<WispChatDisplaySettings wisp={testWisp("one")} onChangeWisp={onChangeWisp} />);
    const toggle = screen.getByRole("switch", { name: "Show reasoning" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    expect(onChangeWisp).toHaveBeenCalledWith({ showReasoning: true });

    rerender(<WispChatDisplaySettings wisp={testWisp("one", { showReasoning: true })} onChangeWisp={onChangeWisp} />);
    await userEvent.click(screen.getByRole("switch", { name: "Show reasoning" }));
    expect(onChangeWisp).toHaveBeenLastCalledWith({ showReasoning: false });
  });

  it("says when the choice could not be saved", async () => {
    render(<WispChatDisplaySettings wisp={testWisp("one")} onChangeWisp={async () => false} />);
    await userEvent.click(screen.getByRole("switch", { name: "Show reasoning" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this setting.");
  });
});
