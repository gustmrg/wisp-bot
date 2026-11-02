import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { CircleExecutionView } from "../../shared/execution";
import type { Wisp } from "@/chat-data";
import { CircleExecutionSettings } from "./circle-execution-settings";

const MEMBERS = [
  { id: "atlas", name: "Atlas" },
  { id: "nova", name: "Nova" },
] as unknown as ReadonlyArray<Wisp>;

const VIEW: CircleExecutionView = {
  commands: false,
  memberIdsWithCommands: ["nova"],
  runtime: { available: true, name: "docker", version: "29.8.1" },
};

function install(view: CircleExecutionView) {
  let current = view;
  const saveCircleExecution = vi.fn(async (request: { commands: boolean }) => {
    current = { ...current, commands: request.commands };
    return { ok: true as const, value: current };
  });
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: { getCircleExecution: vi.fn(async () => ({ ok: true as const, value: current })), saveCircleExecution },
  });
  return saveCircleExecution;
}

it("starts off, warns about trust, and names who can run commands once on", async () => {
  const user = userEvent.setup();
  const save = install(VIEW);
  render(<CircleExecutionSettings conversationId="crew" members={MEMBERS} />);

  const toggle = await screen.findByRole("switch", { name: "Run commands in this circle" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(screen.getByText(/Wisps you trust together/)).toBeInTheDocument();
  expect(screen.queryByText(/Can run commands here/)).not.toBeInTheDocument();

  await user.click(toggle);

  expect(save).toHaveBeenCalledWith({ conversationId: "crew", commands: true });
  expect(await screen.findByText("Can run commands here: Nova.")).toBeInTheDocument();
});

it("says so when no member has its own setting on", async () => {
  install({ ...VIEW, commands: true, memberIdsWithCommands: [] });
  render(<CircleExecutionSettings conversationId="crew" members={MEMBERS} />);

  expect(await screen.findByText(/No member can run commands yet/)).toBeInTheDocument();
});

it("cannot be turned on without Docker or Podman, but can be turned off", async () => {
  const runtime = { available: false as const, message: "Docker or Podman is not available." };
  install({ ...VIEW, runtime });
  const { unmount } = render(<CircleExecutionSettings conversationId="crew" members={MEMBERS} />);
  expect(await screen.findByRole("switch", { name: "Run commands in this circle" })).toBeDisabled();
  expect(screen.getByText("Docker or Podman is not available.")).toBeInTheDocument();
  unmount();

  install({ ...VIEW, commands: true, runtime });
  render(<CircleExecutionSettings conversationId="crew" members={MEMBERS} />);
  expect(await screen.findByRole("switch", { name: "Run commands in this circle" })).toBeEnabled();
});
