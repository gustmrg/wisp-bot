import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CreateCircleDialog } from "@/components/create-circle-dialog";
import { testWisp } from "@/test/chat-fixtures";

const atlas = testWisp("atlas", { name: "Atlas" });
const nova = testWisp("nova", { name: "Nova" });

describe("CreateCircleDialog", () => {
  it("creates a circle with its members in order, the chosen lead first", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => true);
    const onOpenChange = vi.fn();
    render(<CreateCircleDialog open onOpenChange={onOpenChange} wisps={[atlas, nova]} onCreate={onCreate} />);

    const create = screen.getByRole("button", { name: "Create circle" });
    expect(create).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "  Launch team ");
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Atlas" }));
    await user.click(screen.getByRole("checkbox", { name: "Nova" }));
    const lead = screen.getByRole("group", { name: "Lead" });
    expect(screen.getByRole("radio", { name: "Atlas" })).toBeChecked();
    expect(lead).toHaveAccessibleDescription(/Answers messages that mention no one/);
    await user.click(screen.getByRole("radio", { name: "Nova" }));
    await user.type(screen.getByRole("textbox", { name: "Purpose (optional)" }), "Ship the launch");
    await user.click(create);

    expect(onCreate).toHaveBeenCalledWith({
      kind: "circle",
      name: "Launch team",
      label: "",
      description: "Ship the launch",
      notifyOnUpdatesEnabled: true,
      memberIds: ["nova", "atlas"],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the draft when the circle could not be created", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<CreateCircleDialog open onOpenChange={onOpenChange} wisps={[atlas]} onCreate={vi.fn(async () => false)} />);

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
    await user.click(screen.getByRole("checkbox", { name: "Atlas" }));
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create this circle.");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Crew");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
