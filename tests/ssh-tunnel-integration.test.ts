import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTunnelFetch } from "../electron/connections/tunnel-fetch.js";
import { OpenSshTransport, type SshTunnel } from "../electron/connections/ssh-tunnel.js";
import { createWispServer, type WispServer } from "../server/application.js";
import { RemoteBackendClient } from "../client/remote-backend-client.js";
import type { SshConnectionProfile } from "../shared/connections.js";

const execute = promisify(execFile);
let daemon: ChildProcess | undefined;
let tunnel: SshTunnel | undefined;
let server: WispServer | undefined;
let client: RemoteBackendClient | undefined;
let directory: string | undefined;
afterEach(async () => {
  client?.disconnect();
  tunnel?.close();
  daemon?.kill();
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function availablePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return port;
}
// Opt in when the host/CI deliberately provides sshd. This starts only an ephemeral loopback daemon.
describe.skipIf(process.env.WISP_TEST_SSHD !== "1")("real OpenSSH integration", () => {
  it("requires explicit host trust, authenticates with a key, and carries the remote HTTP/SSE protocol", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "wisp-sshd-"));
    const hostKey = path.join(directory, "host_ed25519");
    const identityFile = path.join(directory, "identity_ed25519");
    await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    await execute("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identityFile]);
    const authorized = path.join(directory, "authorized_keys");
    await writeFile(authorized, await readFile(`${identityFile}.pub`), { mode: 0o600 });
    const port = await availablePort();
    const config = path.join(directory, "sshd_config");
    await writeFile(
      config,
      [
        "ListenAddress 127.0.0.1",
        `Port ${port}`,
        `HostKey ${hostKey}`,
        `PidFile ${path.join(directory, "pid")}`,
        `AuthorizedKeysFile ${authorized}`,
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM yes",
        "PermitRootLogin yes",
        "AllowTcpForwarding local",
        "PermitTTY no",
        "X11Forwarding no",
        "AllowAgentForwarding no",
        `AllowUsers ${userInfo().username}`,
        "LogLevel ERROR",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    let daemonError = "";
    daemon = spawn(process.env.WISP_SSHD_PATH ?? "/usr/sbin/sshd", ["-D", "-e", "-f", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    daemon.stderr?.on("data", (data: Buffer) => {
      daemonError += data.toString();
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (daemon.exitCode !== null) throw new Error(`Test sshd failed to start: ${daemonError}`);
    server = await createWispServer({
      dataDirectory: path.join(directory, "server"),
      port: 0,
      agentMode: "fake",
      admin: false,
    });
    const profile: SshConnectionProfile = {
      id: "integration",
      name: "Loopback SSH test",
      kind: "ssh",
      host: "127.0.0.1",
      port,
      username: userInfo().username,
      identityFile,
      sshAuthMode: "openssh",
      remotePort: Number(new URL(server.url).port),
    };
    const transport = new OpenSshTransport(path.join(directory, "client"));
    await expect(transport.connect(profile, () => undefined)).rejects.toMatchObject({ code: "host_unknown" });
    const challenge = await transport.inspectHost(profile);
    expect(challenge.fingerprint).toMatch(/^SHA256:/);
    await expect(transport.trustHost(profile.id, "SHA256:wrong")).rejects.toThrow();
    await transport.trustHost(profile.id, challenge.fingerprint);
    tunnel = await transport.connect(profile, () => undefined);
    client = new RemoteBackendClient({
      baseUrl: tunnel.endpoint,
      allowLoopbackHttp: true,
      fetch: createTunnelFetch(tunnel.endpoint, tunnel.hostHeader),
      auth: { kind: "bearer" },
    });
    await client.pair(server.auth.createPairingCode().code, "SSH integration");
    await client.connect();
    expect(client.getState().phase).toBe("connected");
    expect(client.getServer()?.serverId).toBe(server.database.serverId);
    client.disconnect();
    tunnel.close();
    expect((await fetch(`${server.url}/health/ready`)).ok).toBe(true);
  }, 30000);
});
