import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { WispExecutionView } from "../../shared/execution";
import { WispExecutionSettings } from "./wisp-execution-settings";

const VIEW: WispExecutionView = {
  mode: "off",
  image: null,
  localNetwork: false,
  defaultImage: "wisp-sandbox:abc",
  gitHubPlugin: false,
  gitLabInstance: null,
  runtime: { available: true, name: "docker", version: "29.8.1" },
  container: "absent",
};

function install(view: WispExecutionView) {
  let current = view;
  const saveWispExecution = vi.fn(
    async (request: { mode: WispExecutionView["mode"]; image: string | null; localNetwork: boolean }) => {
      current = {
        ...current,
        mode: request.mode,
        image: request.image,
        localNetwork: request.localNetwork,
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

it("turns commands on, points to the GitHub plugin, and keeps other settings", async () => {
  const user = userEvent.setup();
  const save = install(VIEW);
  render(<WispExecutionSettings conversationId="one" />);

  await user.click(await screen.findByRole("radio", { name: "In a container" }));
  expect(save).toHaveBeenLastCalledWith({ conversationId: "one", mode: "container", image: null, localNetwork: false });
  expect(await screen.findByText("Docker 29.8.1 · Container: Not created yet")).toBeInTheDocument();

  expect(screen.getByText(/add the GitHub plugin in Settings → Plugins/)).toBeInTheDocument();
  expect(screen.queryByLabelText("GitHub token")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove token" })).not.toBeInTheDocument();

  const local = screen.getByRole("switch", { name: "Allow local network" });
  expect(local).toHaveAttribute("aria-checked", "false");
  await user.click(local);
  expect(save).toHaveBeenLastCalledWith({ conversationId: "one", mode: "container", image: null, localNetwork: true });
  expect(await screen.findByRole("switch", { name: "Allow local network" })).toHaveAttribute("aria-checked", "true");
});

it("says when git uses the GitHub plugin's token, and that the Wisp never sees it", async () => {
  install({ ...VIEW, mode: "container", gitHubPlugin: true });
  render(<WispExecutionSettings conversationId="one" />);

  expect(await screen.findByText(/adds the GitHub plugin's token/)).toHaveTextContent("without ever seeing it");
});

it("says which GitLab instance git reaches with the GitLab plugin's token", async () => {
  install({ ...VIEW, mode: "container", gitLabInstance: "https://gitlab.example.com" });
  render(<WispExecutionSettings conversationId="one" />);

  expect(await screen.findByText(/adds the GitLab plugin's token/)).toHaveTextContent(
    "git reaches https://gitlab.example.com through the server",
  );
});

it("explains a missing container program and does not offer to turn commands on", async () => {
  install({ ...VIEW, runtime: { available: false, message: "Install Docker or Podman on the server." } });
  render(<WispExecutionSettings conversationId="one" />);

  expect(await screen.findByText("Install Docker or Podman on the server.")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "In a container" })).toBeDisabled();
});
