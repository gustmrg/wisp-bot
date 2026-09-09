import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CreateAgentDialog } from "@/components/create-agent-dialog";

describe("CreateAgentDialog persistence", () => {
  it("keeps the form open on failure so the same draft can be retried", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<CreateAgentDialog onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.type(name, "Atlas");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create this Wisp");
    expect(name).toHaveValue("Atlas");
    await user.click(screen.getByRole("button", { name: "Create Wisp" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreate).toHaveBeenCalledTimes(2);
  });
});
