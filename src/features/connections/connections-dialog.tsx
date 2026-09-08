import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ConnectionApi, ConnectionProfile, ConnectionState } from "../../../shared/connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const fieldClass = "grid gap-1.5 text-xs";
export function ConnectionsDialog({
  api,
  state,
  open,
  onOpenChange,
}: {
  api: ConnectionApi;
  state: ConnectionState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [error, setError] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const result = await api.list();
    if (result.ok) setProfiles(result.value);
    else setError(result.error.message);
  }, [api]);
  useEffect(() => {
    if (open) void load();
  }, [load, open]);
  async function perform(action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (!result.ok) setError(result.error?.message ?? "The connection could not be updated.");
      await load();
    } catch {
      setError("The connection could not be updated.");
    } finally {
      setBusy(false);
    }
  }
  async function connect(id: string) {
    await perform(async () => {
      const result = await api.connect({ id, ...(pairingCode ? { pairingCode } : {}) });
      setPairingCode("");
      if (result.ok && (result.value.phase === "connected" || result.value.phase === "local")) onOpenChange(false);
      return result;
    });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>
            Choose where your Wisps run. Remote conversations and files stay on that server.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-dim" role="status">
          {state.message ?? connectionStatus(state)}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <ul className="grid gap-2" aria-label="Saved connections">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <strong className="block truncate">{profile.name}</strong>
                <span className="block truncate text-xs text-dim">
                  {profile.kind === "local"
                    ? "This computer"
                    : profile.kind === "https"
                      ? profile.endpoint
                      : `${profile.username ? `${profile.username}@` : ""}${profile.host}`}
                </span>
              </div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void connect(profile.id)}>
                {profile.id === state.profileId && ["connected", "local"].includes(state.phase)
                  ? "Reconnect"
                  : "Connect"}
              </Button>
              {profile.kind !== "local" ? (
                <>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(profile)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || (profile.id === state.profileId && state.phase !== "disconnected")}
                    onClick={() => void perform(() => api.delete({ id: profile.id }))}
                  >
                    Remove
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
        {state.phase === "host_verification_required" && state.hostFingerprint ? (
          <section className="grid gap-2 rounded-lg border border-border p-3">
            <h3 className="font-semibold">Verify the SSH host</h3>
            <p className="text-xs text-dim">
              Compare this fingerprint with the server administrator before trusting this host.
            </p>
            <code className="break-all text-xs">{state.hostFingerprint}</code>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const result = await api.trustHost({ id: state.profileId, fingerprint: state.hostFingerprint ?? "" });
                  if (result.ok) await connect(state.profileId);
                  return result;
                })
              }
            >
              Trust this fingerprint
            </Button>
          </section>
        ) : null}
        {state.phase === "authenticating" && state.authenticationUrl ? (
          <Button
            onClick={() =>
              void api
                .openAuthentication()
                .then((result) => {
                  if (!result.ok) setError(result.error.message);
                })
                .catch(() => setError("Could not open SSH authentication."))
            }
          >
            Open Tailscale authentication
          </Button>
        ) : null}
        {state.phase === "pairing_required" ? (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void connect(state.profileId);
            }}
          >
            <label className={fieldClass}>
              Pairing code
              <Input
                type="password"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                autoComplete="off"
                required
              />
            </label>
            <p className="text-xs text-dim">
              Generate a single-use pairing code on the server with the Wisp administration CLI.
            </p>
            <Button type="submit" disabled={busy}>
              Pair this device
            </Button>
          </form>
        ) : null}
        {editing ? (
          <ConnectionForm
            key={editing.id}
            profile={editing}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={(profile) =>
              void perform(async () => {
                const result = await api.save(profile);
                if (result.ok) setEditing(null);
                return result;
              })
            }
          />
        ) : (
          <Button
            variant="outline"
            onClick={() => setEditing({ id: crypto.randomUUID(), name: "My server", kind: "https", endpoint: "" })}
          >
            Add connection
          </Button>
        )}
        {state.phase !== "local" && state.phase !== "disconnected" ? (
          <div className="grid gap-2 border-t border-border pt-3">
            <Button variant="outline" onClick={() => void perform(() => api.disconnect())}>
              Disconnect
            </Button>
            <p className="text-xs text-dim">
              Disconnecting leaves agents running on the server. Use Stop response inside a conversation to cancel a
              task.
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionForm({
  profile,
  busy,
  onSave,
  onCancel,
}: {
  profile: ConnectionProfile;
  busy: boolean;
  onSave: (profile: ConnectionProfile) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [kind, setKind] = useState(profile.kind);
  const [endpoint, setEndpoint] = useState(profile.kind === "https" ? profile.endpoint : "");
  const [host, setHost] = useState(profile.kind === "ssh" ? profile.host : "");
  const [username, setUsername] = useState(profile.kind === "ssh" ? (profile.username ?? "") : "");
  const [port, setPort] = useState(profile.kind === "ssh" ? profile.port : 22);
  const [remotePort, setRemotePort] = useState(profile.kind === "ssh" ? profile.remotePort : 8787);
  const [identityFile, setIdentityFile] = useState(profile.kind === "ssh" ? (profile.identityFile ?? "") : "");
  const [sshAuthMode, setSshAuthMode] = useState<"openssh" | "tailscale-ssh">(
    profile.kind === "ssh" ? profile.sshAuthMode : "openssh",
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    const common = {
      id: profile.id,
      name: name.trim(),
      ...(profile.expectedServerId ? { expectedServerId: profile.expectedServerId } : {}),
    };
    onSave(
      kind === "local"
        ? { ...common, kind }
        : kind === "https"
          ? { ...common, kind, endpoint: endpoint.trim() }
          : {
              ...common,
              kind,
              host: host.trim(),
              username: username.trim() || undefined,
              port,
              remotePort,
              sshAuthMode,
              identityFile: identityFile.trim() || undefined,
            },
    );
  }
  return (
    <form className="grid gap-3 rounded-lg border border-border p-3" onSubmit={submit}>
      <label className={fieldClass}>
        Name
        <Input value={name} required maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className={fieldClass}>
        Connection type
        <select
          className="h-9 rounded-md border border-input bg-background px-2"
          value={kind}
          onChange={(event) => setKind(event.target.value as ConnectionProfile["kind"])}
        >
          <option value="https">HTTPS / Tailscale Serve</option>
          <option value="ssh">SSH tunnel</option>
        </select>
      </label>
      {kind === "https" ? (
        <label className={fieldClass}>
          Server URL
          <Input
            type="url"
            placeholder="https://wisp.your-tailnet.ts.net"
            value={endpoint}
            required
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
      ) : null}
      {kind === "ssh" ? (
        <>
          <label className={fieldClass}>
            Host or SSH config alias
            <Input
              placeholder="server.your-tailnet.ts.net"
              value={host}
              required
              onChange={(event) => setHost(event.target.value)}
            />
          </label>
          <label className={fieldClass}>
            SSH user
            <Input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={fieldClass}>
              SSH port
              <Input
                type="number"
                min={1}
                max={65535}
                value={port}
                required
                onChange={(event) => setPort(Number(event.target.value))}
              />
            </label>
            <label className={fieldClass}>
              Wisp server port
              <Input
                type="number"
                min={1}
                max={65535}
                value={remotePort}
                required
                onChange={(event) => setRemotePort(Number(event.target.value))}
              />
            </label>
          </div>
          <label className={fieldClass}>
            SSH authentication
            <select
              className="h-9 rounded-md border border-input bg-background px-2"
              value={sshAuthMode}
              onChange={(event) => setSshAuthMode(event.target.value as typeof sshAuthMode)}
            >
              <option value="openssh">OpenSSH key or agent (also over Tailscale)</option>
              <option value="tailscale-ssh">Tailscale SSH</option>
            </select>
          </label>
          {sshAuthMode === "openssh" ? (
            <label className={fieldClass}>
              Identity file path (optional)
              <Input
                value={identityFile}
                placeholder="/Users/you/.ssh/id_ed25519"
                onChange={(event) => setIdentityFile(event.target.value)}
              />
            </label>
          ) : null}
        </>
      ) : null}
      <p className="text-xs text-dim">
        For Tailscale, connect this device to the same tailnet. HTTPS requires Tailscale Serve on the server.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Save connection
        </Button>
      </div>
    </form>
  );
}
export function connectionStatus(state: ConnectionState): string {
  switch (state.phase) {
    case "local":
      return "Running on this computer";
    case "connected":
      return "Connected · Files and agents are on the server";
    case "reconnecting":
      return "Reconnecting · Remote agents continue running";
    case "connecting":
      return "Connecting to the server…";
    case "authenticating":
      return "Waiting for SSH authentication…";
    case "pairing_required":
      return "Pair this device with the server";
    case "host_verification_required":
      return "SSH host verification required";
    case "disconnected":
      return "Disconnected · Remote agents continue running";
    case "error":
      return "Connection unavailable";
  }
}
