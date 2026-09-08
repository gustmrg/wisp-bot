import { RemoteBackendClient } from "../../client/remote-backend-client.js";
import type { BackendApi } from "../../shared/backend-api.js";
import type { ConnectionProfile, ConnectionState } from "../../shared/connections.js";
import type { SequencedConversationAgentEvent } from "../../shared/contracts.js";
import type { ConversationStateView } from "../../shared/conversations.js";
import { RemoteTransportError } from "../../shared/remote-protocol.js";
import { createTunnelFetch } from "./tunnel-fetch.js";
import { ConnectionProfileStore } from "./profile-store.js";
import { OpenSshTransport, SshConnectionError, type SshTunnel } from "./ssh-tunnel.js";

export class ConnectionManager {
  private state: ConnectionState = { phase: "local", profileId: "local", generation: 0 };
  private client: RemoteBackendClient | undefined;
  private tunnel: SshTunnel | undefined;
  private attempt: AbortController | undefined;
  private subscriptions: Array<() => void> = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly agentListeners = new Set<(event: SequencedConversationAgentEvent) => void>();
  private readonly snapshotListeners = new Set<(state: ConversationStateView) => void>();
  constructor(
    private readonly localBackend: BackendApi,
    private readonly profiles: ConnectionProfileStore,
    private readonly ssh: OpenSshTransport,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly deviceName = "Wisp desktop",
  ) {}
  getBackend(): BackendApi | null {
    return this.state.profileId === "local" ? this.localBackend : (this.client?.api ?? null);
  }
  getState(): ConnectionState {
    return this.state;
  }
  subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeToAgentEvents(listener: (event: SequencedConversationAgentEvent) => void): () => void {
    this.agentListeners.add(listener);
    return () => {
      this.agentListeners.delete(listener);
    };
  }
  subscribeToConversationState(listener: (state: ConversationStateView) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }
  list(): ConnectionProfile[] {
    return this.profiles.list();
  }
  async save(profile: unknown): Promise<ConnectionProfile> {
    const saved = await this.profiles.save(profile);
    if (this.state.profileId === saved.id && saved.kind !== "local") this.disconnect();
    return saved;
  }
  async delete(id: string): Promise<void> {
    if (id === this.state.profileId) await this.connect({ id: "local" });
    await this.profiles.delete(id);
  }
  async connect(request: { id: string; pairingCode?: string }): Promise<ConnectionState> {
    const profile = this.profiles.get(request.id);
    this.cleanup();
    this.state = {
      phase: profile.kind === "local" ? "local" : "connecting",
      profileId: profile.id,
      generation: this.state.generation + 1,
    };
    this.publish();
    if (profile.kind === "local") return this.state;
    this.retries = 0;
    await this.establish(profile, request.pairingCode, this.state.generation);
    return this.state;
  }
  disconnect(): ConnectionState {
    this.cleanup();
    this.state = { phase: "disconnected", profileId: this.state.profileId, generation: this.state.generation + 1 };
    this.publish();
    return this.state;
  }
  async trustHost(request: { id: string; fingerprint: string }): Promise<void> {
    if (
      this.state.phase !== "host_verification_required" ||
      request.id !== this.state.profileId ||
      request.fingerprint !== this.state.hostFingerprint
    )
      throw new Error("There is no matching host verification request.");
    await this.ssh.trustHost(request.id, request.fingerprint);
    await this.connect({ id: request.id });
  }
  async openAuthentication(): Promise<void> {
    const url = this.state.authenticationUrl;
    if (
      !url ||
      this.state.phase !== "authenticating" ||
      new URL(url).hostname !== "login.tailscale.com" ||
      new URL(url).protocol !== "https:"
    )
      throw new Error("There is no pending Tailscale authentication request.");
    await this.openExternal(url);
  }
  dispose(): void {
    this.cleanup();
    this.listeners.clear();
    this.agentListeners.clear();
    this.snapshotListeners.clear();
  }
  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }
  private change(value: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...value };
    this.publish();
  }
  private cleanup(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.attempt?.abort();
    this.attempt = undefined;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.client?.disconnect();
    this.client = undefined;
    this.tunnel?.close();
    this.tunnel = undefined;
  }
  private async establish(
    profile: Exclude<ConnectionProfile, { kind: "local" }>,
    pairingCode: string | undefined,
    generation: number,
  ): Promise<void> {
    const attempt = new AbortController();
    this.attempt = attempt;
    const current = (): boolean => generation === this.state.generation && !attempt.signal.aborted;
    let tunnel: SshTunnel | undefined;
    try {
      let endpoint: string;
      if (profile.kind === "ssh") {
        tunnel = await this.ssh.connect(
          profile,
          (authenticationUrl) => {
            if (current())
              this.change({
                phase: "authenticating",
                authenticationUrl,
                message: "Complete the Tailscale identity check in your browser.",
              });
          },
          attempt.signal,
        );
        if (!current()) {
          tunnel.close();
          return;
        }
        this.tunnel = tunnel;
        endpoint = tunnel.endpoint;
        this.subscriptions.push(
          tunnel.onClose(() => {
            if (current()) this.retry(profile, generation);
          }),
        );
      } else endpoint = profile.endpoint;
      const credentials = await this.profiles.credentials(profile.id);
      if (!current()) return;
      const client = new RemoteBackendClient({
        baseUrl: endpoint,
        allowLoopbackHttp: profile.kind === "ssh",
        fetch: tunnel ? createTunnelFetch(tunnel.endpoint, tunnel.hostHeader) : undefined,
        expectedServerId: profile.expectedServerId,
        auth: {
          kind: "bearer",
          credentials,
          onCredentials: async (value) => {
            if (current()) await this.profiles.saveCredentials(profile.id, value);
          },
        },
      });
      this.client = client;
      this.subscriptions.push(
        client.subscribeToState((state) => {
          if (current()) this.change({ ...state, profileId: profile.id, generation, authenticationUrl: undefined });
        }),
      );
      this.subscriptions.push(
        client.subscribeToSnapshot((snapshot) => {
          if (current()) for (const listener of this.snapshotListeners) listener(snapshot.state);
        }),
      );
      this.subscriptions.push(
        client.api.subscribeToAgentEvents((event) => {
          if (current()) for (const listener of this.agentListeners) listener(event);
        }),
      );
      if (pairingCode) await client.pair(pairingCode, this.deviceName);
      else if (!credentials) {
        if (!tunnel) {
          this.change({
            phase: "pairing_required",
            message: "Generate a pairing code with wispctl on the server and enter it here.",
          });
          return;
        }
        await client.pair(await tunnel.pair(), this.deviceName);
      }
      await client.connect();
      if (!current()) return;
      const server = client.getServer();
      await this.profiles.save({
        ...profile,
        expectedServerId: server?.serverId,
        lastConnectedAt: new Date().toISOString(),
      });
      this.retries = 0;
      this.change({
        phase: "connected",
        serverId: server?.serverId,
        owner: server?.owner,
        message: undefined,
        authenticationUrl: undefined,
      });
    } catch (error) {
      if (!current()) return;
      if (error instanceof SshConnectionError && error.code === "host_unknown" && profile.kind === "ssh") {
        try {
          const challenge = await this.ssh.inspectHost(profile);
          if (current())
            this.change({
              phase: "host_verification_required",
              hostFingerprint: challenge.fingerprint,
              message: "Compare this fingerprint with the server administrator before trusting it.",
            });
        } catch {
          if (current())
            this.change({
              phase: "error",
              message:
                "Verify the host key in your operating system known_hosts file, then reconnect. Hosts behind ProxyJump may require manual verification.",
            });
        }
      } else if (error instanceof RemoteTransportError && error.code === "unauthorized")
        this.change({ phase: "pairing_required", message: "This device needs a new pairing code from the server." });
      else
        this.change({
          phase: "error",
          message: error instanceof Error ? error.message : "The remote connection failed.",
        });
    }
  }
  private retry(profile: Exclude<ConnectionProfile, { kind: "local" }>, generation: number): void {
    if (generation !== this.state.generation || this.retryTimer) return;
    this.cleanup();
    this.change({ phase: "reconnecting", message: "SSH disconnected. Remote agents continue running; reconnecting…" });
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.retries++, 6)) * (0.8 + Math.random() * 0.4);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.establish(profile, undefined, generation).then(() => {
        if (generation === this.state.generation && this.state.phase === "error") this.retry(profile, generation);
      });
    }, delay);
  }
}
