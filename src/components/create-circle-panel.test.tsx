import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CreateChatDialog } from "@/components/create-chat-dialog";
import { testWisp } from "@/test/chat-fixtures";

const atlas = testWisp("atlas", { name: "Atlas" });
const nova = testWisp("nova", { name: "Nova" });

function renderDialog(props: { onCreate?: () => Promise<boolean>; wisps?: ReturnType<typeof testWisp>[] } = {}) {
  const onCreate = props.onCreate ?? vi.fn(async () => true);
  const onOpenChange = vi.fn();
  // The Wisp panel loads its settings as the dialog opens; these tests never need them.
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: { getAiSettings: () => new Promise(() => {}), getWispSetup: () => new Promise(() => {}) },
  });
  render(
    <CreateChatDialog
      open
      onOpenChange={onOpenChange}
      onCreate={vi.fn(async () => null)}
      onCreateCircle={onCreate}
      wisps={props.wisps ?? [atlas, nova]}
    />,
  );
  return { onCreate, onOpenChange };
}

describe("CreateChatDialog circles", () => {
  it("creates a circle with its members in order, the chosen lead first", async () => {
    const user = userEvent.setup();
    const { onCreate, onOpenChange } = renderDialog();
    await user.click(screen.getByRole("tab", { name: "Circle" }));

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
    const { onOpenChange } = renderDialog({ onCreate: vi.fn(async () => false), wisps: [atlas] });
    await user.click(screen.getByRole("tab", { name: "Circle" }));

    await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
    await user.click(screen.getByRole("checkbox", { name: "Atlas" }));
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create this circle.");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Crew");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps both drafts while switching between a Wisp and a circle", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByRole("tab", { name: "Wisp" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Create new Wisp" })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Atlas");
    await user.click(screen.getByRole("tab", { name: "Circle" }));
    expect(screen.getByRole("heading", { name: "Create new circle" })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
    await user.click(screen.getByRole("tab", { name: "Wisp" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
    await user.click(screen.getByRole("tab", { name: "Circle" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Crew");
  });

  it("holds the dialog on its tab while a circle is being created", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ onCreate: () => new Promise(() => {}) });

    await user.click(screen.getByRole("tab", { name: "Circle" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Crew");
    await user.click(screen.getByRole("checkbox", { name: "Atlas" }));
    await user.click(screen.getByRole("button", { name: "Create circle" }));

    expect(screen.getByRole("tab", { name: "Wisp" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Create new circle" })).toBeVisible();
  });

  it("points to creating a Wisp when there is none to gather", async () => {
    const user = userEvent.setup();
    renderDialog({ wisps: [] });

    await user.click(screen.getByRole("tab", { name: "Circle" }));
    expect(screen.getByText("Create a Wisp first, then bring it into a circle.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create a Wisp" }));
    expect(screen.getByRole("heading", { name: "Create new Wisp" })).toBeVisible();
  });
});
