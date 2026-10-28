import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CircleMemberPicker } from "@/components/circle-member-picker";
import { testWisp } from "@/test/chat-fixtures";

function wisp(id: string, name: string) {
  return testWisp(id, { name });
}

const atlas = wisp("atlas", "Atlas");
const nova = wisp("nova", "Nova");

describe("CircleMemberPicker", () => {
  it("adds with the keyboard, preserves order, and announces the change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CircleMemberPicker availableWisps={[atlas, nova]} selectedIds={[nova.id]} onChange={onChange} />);

    const atlasCheckbox = screen.getByRole("checkbox", { name: "Atlas" });
    atlasCheckbox.focus();
    await user.keyboard(" ");

    expect(onChange).toHaveBeenCalledWith([nova.id, atlas.id]);
    expect(screen.getByRole("status")).toHaveTextContent("Atlas added to circle.");
  });

  it("crowns the first selected Wisp, the lead, once there are two", () => {
    const { rerender } = render(
      <CircleMemberPicker availableWisps={[atlas, nova]} selectedIds={[nova.id]} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole("img", { name: "Lead" })).not.toBeInTheDocument();

    rerender(
      <CircleMemberPicker availableWisps={[atlas, nova]} selectedIds={[nova.id, atlas.id]} onChange={vi.fn()} />,
    );
    // Its chip names it; in the list below, the crown is decoration and the checkbox keeps the Wisp's name.
    expect(screen.getByRole("img", { name: "Lead" })).toBeInTheDocument();
    expect(document.querySelectorAll(".lead-crown")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Nova" })).toBeChecked();
  });

  it("provides accessible removal controls and deduplicates selected IDs", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CircleMemberPicker availableWisps={[atlas]} selectedIds={[atlas.id, atlas.id]} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Remove Atlas" }));

    expect(onChange).toHaveBeenCalledWith([]);
    expect(screen.getAllByRole("button", { name: "Remove Atlas" })).toHaveLength(1);
  });

  it("drops stale selections when the available Wisp is deleted while open", () => {
    const { rerender } = render(
      <CircleMemberPicker availableWisps={[atlas]} selectedIds={[atlas.id]} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Remove Atlas" })).toBeVisible();

    rerender(<CircleMemberPicker availableWisps={[]} selectedIds={[atlas.id]} onChange={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Remove Atlas" })).not.toBeInTheDocument();
    expect(screen.getByText("No Wisps yet. Create one to add it here.")).toBeVisible();
  });
});
