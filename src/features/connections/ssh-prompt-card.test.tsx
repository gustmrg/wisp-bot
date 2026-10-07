import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SshPromptCard } from "./ssh-prompt-card";

describe("SshPromptCard", () => {
  it("links to Tailscale's approval page, and cancels the check on request", async () => {
    const api = { answerSshPrompt: vi.fn(async () => ({ ok: true as const, value: {} })) };
    Object.defineProperty(window, "wisp", { configurable: true, value: api });
    render(
      <SshPromptCard
        prompt={{
          id: 4,
          kind: "browser",
          url: "https://login.tailscale.com/a/abc",
          message: "Tailscale asks you to approve this connection to pi in your browser.",
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Open the approval page" })).toHaveAttribute(
      "href",
      "https://login.tailscale.com/a/abc",
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.answerSshPrompt).toHaveBeenCalledWith({ id: 4 });
  });

  it("names the host once when OpenSSH repeats it", () => {
    Object.defineProperty(window, "wisp", { configurable: true, value: { answerSshPrompt: vi.fn() } });
    render(
      <SshPromptCard
        prompt={{ id: 1, kind: "hostKey", host: "[box]:2222 ([box]:2222)", fingerprint: "SHA256:x", message: "" }}
      />,
    );
    expect(screen.getByText(/has not connected to \[box\]:2222 before/)).toBeVisible();
  });
});
