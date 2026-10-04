import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { UserProfileSettings } from "./user-profile-settings";

it("edits all profile fields and explicitly saves them, including clearing values", async () => {
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
  await user.clear(screen.getByLabelText("About you (optional)"));
  await user.clear(screen.getByLabelText("Response preferences (optional)"));
  await user.type(screen.getByLabelText("Response preferences (optional)"), "Explain tradeoffs");
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save profile" }));
  expect(save).toHaveBeenCalledWith({ preferredName: "Grace", aboutYou: "", responsePreferences: "Explain tradeoffs" });
  expect(await screen.findByRole("status")).toHaveTextContent("Profile saved.");
});
