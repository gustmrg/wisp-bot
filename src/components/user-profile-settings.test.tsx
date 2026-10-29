import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { UserProfileSettings } from "./user-profile-settings";

it("saves the name when the field loses focus, keeping the fields that moved to memory", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => true);
  render(
    <UserProfileSettings
      controller={{
        profile: { preferredName: "Ada" },
        loading: false,
        error: null,
        save,
      }}
    />,
  );
  // Background and response preferences are memory entries now (ADR 029).
  expect(screen.queryByLabelText("About you (optional)")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save profile" })).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), " Grace ");
  expect(save).not.toHaveBeenCalled();
  await user.tab();
  expect(save).toHaveBeenCalledWith({ preferredName: " Grace " });
  expect(screen.getByLabelText("Name")).toHaveValue("Grace");
});

it("saves on Enter and skips a name that did not change", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => true);
  render(
    <UserProfileSettings
      controller={{
        profile: { preferredName: "Ada" },
        loading: false,
        error: null,
        save,
      }}
    />,
  );
  await user.click(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), " {Enter}");
  expect(save).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Name"), "x{Enter}");
  expect(save).toHaveBeenCalledTimes(1);
});

it("keeps the name required and never saves it empty", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => true);
  render(
    <UserProfileSettings
      controller={{
        profile: { preferredName: "Ada" },
        loading: false,
        error: null,
        save,
      }}
    />,
  );
  await user.clear(screen.getByLabelText("Name"));
  await user.tab();
  expect(screen.getByRole("alert")).toHaveTextContent("Your name is required.");
  expect(save).not.toHaveBeenCalled();
});
