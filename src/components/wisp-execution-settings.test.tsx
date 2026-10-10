import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { WispExecutionView } from "../../shared/execution";
import { WispExecutionSettings } from "./wisp-execution-settings";

const VIEW: WispExecutionView = {
  mode: "off",
  image: null,
  defaultImage: "wisp-sandbox:abc",
  hasGitToken: false,
  runtime: { available: true, name: "docker", version: "29.8.1" },
  container: "absent",
};

function install(view: WispExecutionView) {
  let current = view;
  const saveWispExecution = vi.fn(
    async (request: { mode: WispExecutionView["mode"]; image: string | null; gitToken?: string | null }) => {
      current = {
        ...current,
        mode: request.mode,
        image: request.image,
        ...(request.gitToken === undefined ? {} : { hasGitToken: request.gitToken !== null }),
      };
      return { ok: true as const, value: current };
    },
  );
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: { getWispExecution: vi.fn(async () => ({ ok: true as const, value: current })), saveWispExecution },
  });
  return saveWispExecution;
}

it("turns commands on, saves a token without echoing it, and keeps other settings", async () => {
  const user = userEvent.setup();
  const save = install(VIEW);
  render(<WispExecutionSettings conversationId="one" />);
  await user.click(screen.getByRole("button", { name: "Commands" }));

  await user.click(await screen.findByRole("radio", { name: "In a container" }));
  expect(save).toHaveBeenLastCalledWith({ conversationId: "one", mode: "container", image: null });
  expect(await screen.findByText("Docker 29.8.1 · Container: Not created yet")).toBeInTheDocument();

  const token = screen.getByLabelText("GitHub token");
  expect(token).toHaveAttribute("type", "password");
  await user.type(token, "github_pat_x");
  await user.click(screen.getAllByRole("button", { name: "Save" })[1]!);
  expect(save).toHaveBeenLastCalledWith({
    conversationId: "one",
    mode: "container",
    image: null,
    gitToken: "github_pat_x",
  });
  expect(await screen.findByRole("button", { name: "Remove token" })).toBeInTheDocument();
  expect(screen.getByLabelText("GitHub token")).toHaveValue("");
});

it("explains a missing container program and does not offer to turn commands on", async () => {
  const user = userEvent.setup();
  install({ ...VIEW, runtime: { available: false, message: "Install Docker or Podman on the server." } });
  render(<WispExecutionSettings conversationId="one" />);
  await user.click(screen.getByRole("button", { name: "Commands" }));

  expect(await screen.findByText("Install Docker or Podman on the server.")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "In a container" })).toBeDisabled();
});
