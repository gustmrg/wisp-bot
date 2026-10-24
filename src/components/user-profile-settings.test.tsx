import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { UserProfileSettings } from "./user-profile-settings";

it("edits the preferred name and explicitly saves it, keeping the fields that moved to memory", async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => true);
  render(
    <UserProfileSettings
      controller={{
        profile: { preferredName: "Ada", aboutYou: "Developer", responsePreferences: "Brief" },
        loading: false,
        error: null,
        save,
      }}
    />,
  );
  await user.clear(screen.getByLabelText("Preferred name"));
  await user.type(screen.getByLabelText("Preferred name"), "Grace");
  // Background and response preferences are memory entries now (ADR 029).
  expect(screen.queryByLabelText("About you (optional)")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Response preferences (optional)")).not.toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  expect(save).toHaveBeenCalledWith({ preferredName: "Grace", aboutYou: "Developer", responsePreferences: "Brief" });
  expect(await screen.findByRole("status")).toHaveTextContent("Profile saved.");
});

it("keeps the preferred name required", async () => {
  const user = userEvent.setup();
  render(
    <UserProfileSettings
      controller={{
        profile: { preferredName: "Ada", aboutYou: "", responsePreferences: "" },
        loading: false,
        error: null,
        save: vi.fn(async () => true),
      }}
    />,
  );
  await user.clear(screen.getByLabelText("Preferred name"));
  expect(screen.getByRole("alert")).toHaveTextContent("Your preferred name is required.");
  expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
});
