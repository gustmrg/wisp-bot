import { useId, useState } from "react";
import { ChevronLeftIcon, LaptopIcon, Plus, ServerIcon, Settings2 } from "lucide-react";

import { ConfirmAction, SettingsField, StatusDot, type StatusTone } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type {
  ConnectionProfileView,
  ConnectionsView,
  ConnectionStatus,
  SaveConnectionRequest,
} from "../../../shared/connections";
import { InstallServerAction } from "./install-server-action";
import { ServerSetupGuide } from "./server-setup-guide";

const PHASE_LABELS: Record<ConnectionStatus["phase"], string> = {
  choosing: "Not in use",
  local: "In use",
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  pairing_required: "Needs pairing",
  error: "Cannot connect",
};

function phaseTone(phase: ConnectionStatus["phase"]): StatusTone {
  if (phase === "choosing") return "muted";
  if (phase === "local" || phase === "connected") return "success";
  if (phase === "connecting" || phase === "reconnecting") return "warning";
  return "danger";
}

export function describeProfile(profile: ConnectionProfileView): string {
  if (profile.kind === "local") return "Wisps run on this computer.";
  if (profile.kind === "ssh") {
    const target = `${profile.user ? `${profile.user}@` : ""}${profile.host}${profile.sshPort ? `:${profile.sshPort}` : ""}`;
    return `SSH to ${target}, server port ${profile.serverPort}`;
  }
  return profile.url;
}

type ConnectionsResult = { ok: true; value: ConnectionsView } | { ok: false; error: { message: string } };

/**
 * Lists where Wisps can run and switches between them. Used in Settings and on
 * the screen shown while a server cannot be used. The main process pushes every
 * change, so action results only report errors.
 */
export function ConnectionsPanel({ view, serversOnly = false }: { view: ConnectionsView; serversOnly?: boolean }) {
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<ConnectionsResult>) {
    setBusy(key);
    setError("");
    try {
      const result = await action();
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("The connection settings could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  const editedProfile =
    editing && editing !== "new" ? view.profiles.find((profile) => profile.id === editing) : undefined;
  if (editing === "new" || (editedProfile && editedProfile.kind !== "local")) {
    return (
      <ConnectionForm
        key={editing}
        profile={editedProfile && editedProfile.kind !== "local" ? editedProfile : undefined}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="animate-tab-forward">
      {!view.secureStorageAvailable ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          Secure storage is unavailable, so this computer pairs with servers again after every restart.
        </p>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Connections">
        {view.profiles
          .filter((profile) => !serversOnly || profile.kind !== "local")
          .map((profile) => {
            const active = profile.id === view.activeId;
            return (
              <li key={profile.id} className="flex items-center gap-3 rounded-xl px-2 py-3">
                <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted">
                  {profile.kind === "local" ? (
                    <LaptopIcon className="size-4 text-dim" aria-hidden="true" />
                  ) : (
                    <ServerIcon className="size-4 text-dim" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-medium">{profile.name}</span>
                  <span className="mt-1 block truncate text-sm text-dim">{describeProfile(profile)}</span>
                  {active ? (
                    <span className="mt-1.5 flex items-center gap-1.5 text-2xs text-dim">
                      <StatusDot tone={phaseTone(view.status.phase)} />
                      {PHASE_LABELS[view.status.phase]}
                      {view.status.serverVersion ? ` · Server ${view.status.serverVersion}` : null}
                    </span>
                  ) : profile.kind !== "local" && !profile.paired ? (
                    <span className="mt-1.5 block text-2xs text-dim">Not paired yet</span>
                  ) : null}
                </span>
                {active ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Switch to ${profile.name}`}
                    disabled={busy !== null}
                    onClick={() => void run(profile.id, () => window.wisp.activateConnection({ id: profile.id }))}
                  >
                    {busy === profile.id ? "Switching…" : "Switch"}
                  </Button>
                )}
                {profile.kind === "local" ? (
                  // Keeps Switch in the same column on rows without an edit button.
                  <span aria-hidden="true" className="size-7 flex-none" />
                ) : (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label={`Edit ${profile.name}`}
                    disabled={busy !== null}
                    onClick={() => setEditing(profile.id)}
                  >
                    <Settings2 aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
      </ul>
      <button
        type="button"
        onClick={() => setEditing("new")}
        className="group mt-1 flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-3 text-left outline-none transition-colors hover:bg-popover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-muted">
          <Plus className="size-4 text-dim group-hover:text-foreground" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">Add a server</span>
          <span className="mt-1 block text-sm text-dim">Use Wisps running on a Wisp server over SSH or HTTPS.</span>
        </span>
      </button>
      <ServerSetupGuide />
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface Draft {
  kind: "ssh" | "url";
  name: string;
  host: string;
  user: string;
  sshPort: string;
  serverPort: string;
  url: string;
}

function draftFrom(profile?: Exclude<ConnectionProfileView, { kind: "local" }>): Draft {
  return {
    kind: profile?.kind ?? "ssh",
    name: profile?.name ?? "",
    host: profile?.kind === "ssh" ? profile.host : "",
    user: profile?.kind === "ssh" ? (profile.user ?? "") : "",
    sshPort: profile?.kind === "ssh" && profile.sshPort ? String(profile.sshPort) : "",
    serverPort: profile?.kind === "ssh" ? String(profile.serverPort) : "8787",
    url: profile?.kind === "url" ? profile.url : "",
  };
}

function requestFrom(draft: Draft, id?: string): SaveConnectionRequest {
  const name = draft.name.trim() || (draft.kind === "ssh" ? draft.host.trim() : draft.url.trim());
  if (draft.kind === "url") return { ...(id ? { id } : {}), kind: "url", name, url: draft.url.trim() };
  return {
    ...(id ? { id } : {}),
    kind: "ssh",
    name,
    host: draft.host.trim(),
    ...(draft.user.trim() ? { user: draft.user.trim() } : {}),
    ...(draft.sshPort.trim() ? { sshPort: Number(draft.sshPort) } : {}),
    serverPort: Number(draft.serverPort),
  };
}

function ConnectionForm({
  profile,
  onDone,
}: {
  profile?: Exclude<ConnectionProfileView, { kind: "local" }>;
  /** Returns to the list after saving, removing, or going back. */
  onDone: () => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<Draft>(draftFrom(profile));
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState("");
  const update = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));

  async function save() {
    setBusy("save");
    setError("");
    try {
      const result = await window.wisp.saveConnection(requestFrom(draft, profile?.id));
      if (result.ok) onDone();
      else setError(result.error.message);
    } catch {
      setError("The connection could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!profile) return;
    setBusy("remove");
    setError("");
    try {
      const result = await window.wisp.removeConnection({ id: profile.id });
      if (result.ok) onDone();
      else setError(result.error.message);
    } catch {
      setError("The connection could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="animate-tab-forward"
      aria-labelledby={`${formId}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Button type="button" variant="ghost" size="sm" className="mb-3 -ml-2" onClick={onDone}>
        <ChevronLeftIcon aria-hidden="true" />
        Connections
      </Button>
      <h3 id={`${formId}-title`} className="mb-3 mt-0 text-md font-medium">
        {profile ? `Edit ${profile.name}` : "Add a server"}
      </h3>
      {profile ? null : (
        <SegmentedControl
          label="Connect with"
          className="mb-4"
          value={draft.kind}
          options={[
            { value: "ssh", label: "SSH" },
            { value: "url", label: "HTTPS address" },
          ]}
          onChange={(kind) => update({ kind })}
        />
      )}
      <SettingsField label="Name">
        <Input
          value={draft.name}
          placeholder="Home server"
          onChange={(event) => update({ name: event.target.value })}
        />
      </SettingsField>
      {draft.kind === "ssh" ? (
        <>
          <SettingsField label="Host">
            <Input
              required
              value={draft.host}
              placeholder="raspberrypi, 100.64.0.1, or an alias from ~/.ssh/config"
              onChange={(event) => update({ host: event.target.value })}
            />
          </SettingsField>
          <div className="grid grid-cols-3 gap-3 max-[520px]:grid-cols-1">
            <SettingsField label="User (optional)">
              <Input value={draft.user} onChange={(event) => update({ user: event.target.value })} />
            </SettingsField>
            <SettingsField label="SSH port (optional)">
              <Input
                inputMode="numeric"
                value={draft.sshPort}
                placeholder="22"
                onChange={(event) => update({ sshPort: event.target.value })}
              />
            </SettingsField>
            <SettingsField label="Wisp server port">
              <Input
                required
                inputMode="numeric"
                value={draft.serverPort}
                onChange={(event) => update({ serverPort: event.target.value })}
              />
            </SettingsField>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-dim">
            Wisp uses this computer&apos;s OpenSSH, with your SSH agent, keys, and known hosts. Connect once with{" "}
            <code>ssh</code> in a terminal so the host key is trusted. Pairing runs <code>wispctl pair</code> on the
            server for you.
            {profile ? null : (
              <> If the Wisp server is not installed there yet, save, then open the server to install it.</>
            )}
          </p>
        </>
      ) : (
        <>
          <SettingsField label="Address">
            <Input
              required
              value={draft.url}
              placeholder="https://machine.tailnet-name.ts.net"
              onChange={(event) => update({ url: event.target.value })}
            />
          </SettingsField>
          <p className="mb-3 text-xs leading-relaxed text-dim">
            A private HTTPS address for the server, such as Tailscale Serve. You will enter a code from{" "}
            <code>wispctl pair</code> to pair.
          </p>
        </>
      )}
      {error ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        {profile ? (
          <ConfirmAction
            label="Remove"
            confirmLabel="Remove connection"
            pendingLabel="Removing…"
            pending={busy === "remove"}
            disabled={busy !== null}
            description="This computer forgets the server and its pairing. Wisps on the server keep running."
            onConfirm={() => void remove()}
          />
        ) : null}
      </div>
      {profile?.kind === "ssh" ? (
        <div className="mt-5 border-t border-border pt-4">
          <h4 className="mb-1 mt-0 text-base font-medium">Wisp server on {profile.host}</h4>
          <p className="mb-3 mt-0 text-xs leading-relaxed text-dim">
            Installs the server on that machine, or updates it to this app&apos;s version, and connects to it.
          </p>
          <InstallServerAction
            profileId={profile.id}
            host={profile.host}
            label="Install or update the server"
            disabled={busy !== null}
            onInstalled={onDone}
          />
        </div>
      ) : null}
      {profile ? null : <ServerSetupGuide />}
    </form>
  );
}
