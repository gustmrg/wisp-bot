import { powerMonitor } from "electron";
import { networkInterfaces } from "node:os";

const NETWORK_POLL_MS = 5_000;

/** This computer's network addresses; they change with another Wi-Fi or a VPN going up or down. */
function networkAddresses(): string {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses ?? []).filter((address) => !address.internal).map((address) => `${name}/${address.address}`),
    )
    .sort()
    .join(",");
}

/**
 * Calls `onWake` when this computer resumes from sleep or its network
 * addresses change. Electron has no event for a network change, so the
 * addresses are compared every few seconds.
 */
export function watchDeviceWake(onWake: () => void): () => void {
  let addresses = networkAddresses();
  const poll = setInterval(() => {
    const next = networkAddresses();
    if (next === addresses) return;
    addresses = next;
    onWake();
  }, NETWORK_POLL_MS);
  powerMonitor.on("resume", onWake);
  return () => {
    clearInterval(poll);
    powerMonitor.off("resume", onWake);
  };
}
