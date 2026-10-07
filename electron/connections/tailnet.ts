import { execFile } from "node:child_process";

import type { TailnetMachine } from "../../shared/connections.js";

const TIMEOUT_MS = 5_000;
// The CLI on the PATH, or the one inside the macOS app.
const CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/**
 * The Linux machines on this computer's tailnet, the kind a Wisp server runs
 * on, online ones first. Nothing when Tailscale is not installed or not
 * running.
 */
export async function listTailnetMachines(options: { tailscalePath?: string } = {}): Promise<TailnetMachine[]> {
  for (const command of options.tailscalePath ? [options.tailscalePath] : CANDIDATES) {
    const output = await new Promise<string | undefined>((resolve) => {
      execFile(
        command,
        ["status", "--json"],
        { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout) => resolve(error ? undefined : stdout),
      );
    });
    if (output !== undefined) return parseTailscaleStatus(output);
  }
  return [];
}

export function parseTailscaleStatus(output: string): TailnetMachine[] {
  let status: { Peer?: Record<string, unknown> };
  try {
    status = JSON.parse(output);
  } catch {
    return [];
  }
  const machines: TailnetMachine[] = [];
  for (const peer of Object.values(status.Peer ?? {})) {
    const { HostName, DNSName, OS, Online, TailscaleIPs } = (peer ?? {}) as Record<string, unknown>;
    if (OS !== "linux" || typeof DNSName !== "string" || !DNSName) continue;
    const dnsName = DNSName.replace(/\.$/, "");
    // Only names OpenSSH can take as a host; the store checks them again.
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(dnsName)) continue;
    const ip = Array.isArray(TailscaleIPs)
      ? TailscaleIPs.find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(String(value)))
      : undefined;
    machines.push({
      name: dnsName.split(".")[0] || (typeof HostName === "string" ? HostName : dnsName),
      dnsName,
      ...(typeof ip === "string" ? { ip } : {}),
      online: Online === true,
    });
  }
  return machines.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
