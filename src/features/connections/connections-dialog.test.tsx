import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ConnectionApi, ConnectionState } from "../../../shared/connections";
import { ConnectionsDialog } from "./connections-dialog";

it("lets the user open Tailscale authentication while SSH connect is still pending", async () => {
  let finish: (value: { ok: true; value: ConnectionState }) => void = () => undefined;
  const local: ConnectionState = { phase: "local", profileId: "local", generation: 0 };
  const auth: ConnectionState = {
    phase: "authenticating",
    profileId: "server",
    generation: 1,
    authenticationUrl: "https://login.tailscale.com/a/example",
  };
  const api = {
    list: vi.fn(async () => ({
      ok: true,
      value: [
        {
          id: "server",
          name: "Remote",
          kind: "ssh",
          host: "wisp.tailnet.ts.net",
          port: 22,
          remotePort: 8787,
          sshAuthMode: "tailscale-ssh",
        },
      ],
    })),
    connect: vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    openAuthentication: vi.fn(async () => ({ ok: true, value: {} })),
  } as unknown as ConnectionApi;
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  const mounted = render(<ConnectionsDialog api={api} state={local} open onOpenChange={onOpenChange} />);
  await user.click(await screen.findByRole("button", { name: /^Connect$/ }));
  mounted.rerender(<ConnectionsDialog api={api} state={auth} open onOpenChange={onOpenChange} />);
  const authenticate = screen.getByRole("button", { name: "Open Tailscale authentication" });
  expect(authenticate).toBeEnabled();
  await user.click(authenticate);
  expect(api.openAuthentication).toHaveBeenCalledOnce();
  await act(async () => finish({ ok: true, value: { ...auth, phase: "connected" } }));
});
