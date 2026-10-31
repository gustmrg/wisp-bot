import { useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, QrCodeIcon, SmartphoneIcon } from "lucide-react";
import { encode } from "uqr";

import {
  ConfirmAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsRowCopy,
  SettingsRowDescription,
  SettingsRowTitle,
} from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { CopyCommand } from "@/features/connections/connection-screen";
import { useTimeFormat, useTimeZone } from "@/hooks/use-time-zone";
import { formatClockTime } from "@/lib/clock-time";
import type { BackendResult } from "../../shared/contracts";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  type PairedDeviceView,
  type RemoteAccessPairing,
  type RemoteAccessView,
} from "../../shared/remote-access";

type Busy = "save" | "pair" | `revoke:${string}` | null;

// How often the list is read while a QR code waits to be scanned.
const PAIRING_POLL_MS = 2_000;

/**
 * Remote access to Wisps on this computer, for a phone or another device.
 * Set up in steps until it has an address, then a switch that turns it on
 * and off. Not the same as Connections, which picks where this app's Wisps run.
 */
export function RemoteAccessSettingsSection() {
  const [view, setView] = useState<RemoteAccessView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [pairing, setPairing] = useState<RemoteAccessPairing | null>(null);
  /** The device that paired with the code last shown, to say so. */
  const [paired, setPaired] = useState<string | null>(null);
  const knownDevices = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let active = true;
    window.wisp.getRemoteAccess().then(
      (result) => {
        if (!active) return;
        if (result.ok) setView(result.value);
        else setLoadError(result.error.message);
      },
      () => {
        if (active) setLoadError("Remote access settings could not be read.");
      },
    );
    return () => {
      active = false;
    };
  }, []);

  // While a QR code is on screen, watch for the device that scans it.
  useEffect(() => {
    if (!pairing) return;
    let active = true;
    const timer = setInterval(() => {
      window.wisp.getRemoteAccess().then(
        (result) => {
          if (!active || !result.ok) return;
          setView(result.value);
          const device = result.value.devices.find(({ id }) => !knownDevices.current.has(id));
          if (device) {
            setPairing(null);
            setPaired(device.name);
          }
        },
        () => undefined,
      );
    }, PAIRING_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pairing]);

  async function run<T>(key: Exclude<Busy, null>, action: () => Promise<BackendResult<T>>, fallback: string) {
    setBusy(key);
    setError("");
    try {
      const result = await action();
      if (result.ok) return result.value;
      setError(result.error.message);
    } catch {
      setError(fallback);
    } finally {
      setBusy(null);
    }
    return undefined;
  }

  async function save(enabled: boolean, port: number, publicOrigin: string | undefined, automatic: boolean) {
    const value = await run(
      "save",
      () =>
        window.wisp.saveRemoteAccess({
          enabled,
          port,
          ...(publicOrigin ? { publicOrigin } : {}),
          ...(automatic ? { automatic } : {}),
        }),
      "Remote access could not be changed.",
    );
    if (!value) return;
    setView(value);
    setEditing(false);
    if (!value.enabled) setPairing(null);
  }

  async function pair() {
    knownDevices.current = new Set(view?.devices.map(({ id }) => id));
    setPaired(null);
    const value = await run("pair", () => window.wisp.pairRemoteDevice(), "A pairing code could not be created.");
    if (value) setPairing(value);
  }

  async function revoke(device: PairedDeviceView) {
    const value = await run(
      `revoke:${device.id}`,
      () => window.wisp.revokeRemoteDevice({ deviceId: device.id }),
      "The device could not be revoked.",
    );
    if (value) setView(value);
  }

  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5 [&>*]:max-w-[760px]"
      id="remote-access-settings-panel"
      aria-labelledby="remote-access-settings-title"
    >
      <h2 id="remote-access-settings-title" className="mb-1 mt-0 text-lg font-semibold">
        Remote access
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-dim">
        Use this computer's Wisps from another device, over your private Tailscale network.
      </p>
      {!view ? (
        loadError ? (
          <p role="alert" className="text-xs text-destructive">
            {loadError}
          </p>
        ) : (
          <p role="status" className="text-sm text-dim">
            Loading remote access…
          </p>
        )
      ) : editing || !view.publicOrigin ? (
        <Setup
          key={`${view.publicOrigin}:${view.port}`}
          view={view}
          busy={busy === "save"}
          error={error}
          onSubmit={(port, publicOrigin, automatic) => void save(true, port, publicOrigin, automatic)}
          onCancel={view.publicOrigin ? () => setEditing(false) : undefined}
        />
      ) : (
        <>
          <SettingsCard variant="stacked">
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle>Remote access</SettingsRowTitle>
                <SettingsRowDescription>
                  {view.enabled
                    ? "On. Wisp keeps running in the tray when you close its window; quitting Wisp turns it off until Wisp opens again."
                    : "Off. Other devices cannot reach the Wisps on this computer."}
                </SettingsRowDescription>
              </SettingsRowCopy>
              <ToggleSwitch
                label="Remote access"
                checked={view.enabled}
                disabled={busy !== null}
                onChange={() => void save(!view.enabled, view.port, view.publicOrigin, view.automatic)}
              />
            </SettingsRow>
            <SettingsRow>
              <SettingsRowCopy>
                <SettingsRowTitle>Address</SettingsRowTitle>
                <SettingsRowDescription className="truncate">
                  {view.publicOrigin} · port {view.port}
                  {view.automatic ? " · set up by Wisp with Tailscale Serve" : ""}
                </SettingsRowDescription>
              </SettingsRowCopy>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  setError("");
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            </SettingsRow>
          </SettingsCard>
          {busy === "save" ? (
            <p role="status" className="mt-3 text-xs text-dim">
              {view.enabled ? "Turning remote access off…" : "Checking that the address reaches this computer…"}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-xs leading-relaxed text-destructive">
              <WithLinks text={error} />
            </p>
          ) : null}
          {view.enabled && !view.webAppAvailable ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              This build of Wisp does not include the browser app, so other devices cannot open it. Build it with npm
              run build:web.
            </p>
          ) : null}
          {view.error ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {view.error}
            </p>
          ) : null}

          <SettingsGroup label="Pair a device">
            {paired && view.enabled && !pairing ? (
              <p role="status" className="mb-2 flex items-center gap-1.5 text-xs text-dim">
                <CheckCircle2Icon className="size-3.5 text-emerald-500" aria-hidden="true" />
                {paired} is paired with this computer.
              </p>
            ) : null}
            {pairing && view.enabled ? (
              <PairingCode pairing={pairing} onDone={() => setPairing(null)} />
            ) : (
              <SettingsCard>
                <SettingsRow>
                  <QrCodeIcon className="size-4 flex-none text-dim" aria-hidden="true" />
                  <SettingsRowCopy>
                    <SettingsRowDescription>
                      {view.enabled
                        ? "Show a QR code, then scan it with your phone's camera. Your phone needs the Tailscale app, signed in to the same network."
                        : "Turn on remote access to pair a device."}
                    </SettingsRowDescription>
                  </SettingsRowCopy>
                  <Button type="button" size="sm" disabled={!view.enabled || busy !== null} onClick={() => void pair()}>
                    {busy === "pair" ? "Creating…" : "Show QR code"}
                  </Button>
                </SettingsRow>
              </SettingsCard>
            )}
          </SettingsGroup>
          {view.enabled ? (
            <DeviceList devices={view.devices} busy={busy} onRevoke={(device) => void revoke(device)} />
          ) : null}
        </>
      )}
    </section>
  );
}

/** First setup, or editing the address: share the port with Tailscale Serve, then enter its address. */
interface SetupProps {
  view: RemoteAccessView;
  busy: boolean;
  error: string;
  onSubmit: (port: number, publicOrigin: string | undefined, automatic: boolean) => void;
  onCancel?: () => void;
}

/** Lets Wisp set up Tailscale Serve when Tailscale is ready here; otherwise, or on request, the steps by hand. */
function Setup(props: SetupProps) {
  const { view } = props;
  const ready = view.tailscale?.status === "ready" ? view.tailscale : undefined;
  // An address set up by hand is edited by hand.
  const [byHand, setByHand] = useState(Boolean(view.publicOrigin) && !view.automatic);
  return ready && !byHand ? (
    <AutomaticSetup
      {...props}
      origin={ready.origin}
      httpsEnabled={ready.httpsEnabled}
      onByHand={() => setByHand(true)}
    />
  ) : (
    <SetupSteps {...props} onAutomatic={ready ? () => setByHand(false) : undefined} />
  );
}

function PortField({ port, onChange }: { port: string; onChange: (port: string) => void }) {
  return (
    <label className="mt-3 flex items-center gap-2 text-xs text-dim">
      Port
      <Input
        className="h-7 w-24"
        inputMode="numeric"
        aria-label="Port"
        value={port}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 5))}
      />
      <span>Change it only if another program uses it.</span>
    </label>
  );
}

function AutomaticSetup({
  view,
  busy,
  error,
  onSubmit,
  onCancel,
  origin,
  httpsEnabled,
  onByHand,
}: SetupProps & { origin: string; httpsEnabled: boolean; onByHand: () => void }) {
  const [port, setPort] = useState(String(view.port || DEFAULT_REMOTE_ACCESS_PORT));
  return (
    <form
      aria-label="Set up remote access"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit(Number(port) || DEFAULT_REMOTE_ACCESS_PORT, undefined, true);
      }}
    >
      <SettingsCard className="px-3.5 py-3">
        <p className="m-0 text-sm font-medium">Tailscale is ready on this computer</p>
        <p className="mt-1 text-xs leading-relaxed text-dim">
          Wisp shares the Wisps on this computer at <strong className="text-foreground">{origin}</strong> with Tailscale
          Serve, only to devices on your Tailscale network. It never uses Funnel, and turning remote access off removes
          what it added.
        </p>
        {httpsEnabled ? null : (
          <p className="mt-2 text-xs leading-relaxed text-dim">
            HTTPS certificates are off for your Tailscale network: Tailscale asks you to turn them on first.
          </p>
        )}
        <PortField port={port} onChange={setPort} />
        {error ? (
          <p role="alert" className="mt-3 text-xs leading-relaxed text-destructive">
            <WithLinks text={error} />
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Setting up Tailscale Serve…" : view.enabled ? "Save" : "Turn on remote access"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onByHand}>
            Set it up by hand
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </SettingsCard>
    </form>
  );
}

/** Why Wisp cannot set up Tailscale Serve itself, with what to do about it. */
function TailscaleNotice({ view, onAutomatic }: { view: RemoteAccessView; onAutomatic?: () => void }) {
  const { tailscale } = view;
  if (!tailscale) return null;
  if (tailscale.status === "ready") {
    return onAutomatic ? (
      <button
        type="button"
        className="mb-3 cursor-pointer text-xs text-dim underline underline-offset-2 hover:text-foreground"
        onClick={onAutomatic}
      >
        Let Wisp set up Tailscale Serve instead
      </button>
    ) : null;
  }
  return (
    <p className="mb-3 text-xs leading-relaxed text-dim">
      {tailscale.message}{" "}
      {tailscale.status === "not_installed" ? (
        <>
          <a className="underline" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
            Install Tailscale
          </a>{" "}
          and sign in, and Wisp sets up the rest. Or set it up by hand:
        </>
      ) : (
        "Then Wisp sets up the rest. Or set it up by hand:"
      )}
    </p>
  );
}

function SetupSteps({ view, busy, error, onSubmit, onCancel, onAutomatic }: SetupProps & { onAutomatic?: () => void }) {
  const [port, setPort] = useState(String(view.port || DEFAULT_REMOTE_ACCESS_PORT));
  const [origin, setOrigin] = useState(view.publicOrigin ?? "");
  const [missing, setMissing] = useState("");
  const step = "flex gap-3 px-3.5 py-3";
  const number = "flex size-5 flex-none items-center justify-center rounded-full bg-muted text-2xs font-medium";
  return (
    <form
      aria-label="Set up remote access"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (!origin.trim()) {
          setMissing("Enter the address Tailscale Serve shows, such as https://laptop.tailnet-name.ts.net.");
          return;
        }
        setMissing("");
        onSubmit(Number(port) || DEFAULT_REMOTE_ACCESS_PORT, origin.trim(), false);
      }}
    >
      <TailscaleNotice view={view} onAutomatic={onAutomatic} />
      <SettingsCard variant="stacked">
        <div className={step}>
          <span className={number}>1</span>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-sm font-medium">Share this computer on your Tailscale network</p>
            <p className="mt-1 text-xs leading-relaxed text-dim">
              With Tailscale running on this computer, run this in a terminal. It gives this computer a private HTTPS
              address that only your devices can open. Wisp itself never listens beyond this computer.
            </p>
            <CopyCommand command={`tailscale serve --bg http://127.0.0.1:${port || DEFAULT_REMOTE_ACCESS_PORT}`} />
            <PortField port={port} onChange={setPort} />
          </div>
        </div>
        <div className={step}>
          <span className={number}>2</span>
          <div className="min-w-0 flex-1">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Enter the address it shows</span>
              <span className="text-xs text-dim">
                <code>tailscale serve status</code> shows it again.
              </span>
              <Input
                aria-label="HTTPS address"
                value={origin}
                placeholder="https://laptop.tailnet-name.ts.net"
                onChange={(event) => setOrigin(event.target.value)}
              />
            </label>
          </div>
        </div>
        <div className={step}>
          <span className={number}>3</span>
          <div className="min-w-0 flex-1">
            <p className="m-0 text-xs leading-relaxed text-dim">
              Wisp checks that the address reaches this computer, then turns remote access on.
            </p>
            {missing || error ? (
              <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">
                <WithLinks text={missing || error} />
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Checking the address…" : view.enabled ? "Save" : "Turn on remote access"}
              </Button>
              {onCancel ? (
                <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </SettingsCard>
    </form>
  );
}

function PairingCode({ pairing, onDone }: { pairing: RemoteAccessPairing; onDone: () => void }) {
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const until = formatClockTime(new Date(pairing.expiresAt), timeZone, timeFormat);
  return (
    <SettingsCard className="flex items-start gap-4 p-4 max-[520px]:flex-col">
      <QrCode value={pairing.link} label="QR code that pairs a device with this computer" />
      <div className="min-w-0 flex-1">
        <p className="m-0 text-sm font-medium">Scan this with your phone's camera</p>
        <p className="mt-1 text-xs leading-relaxed text-dim">
          It opens Wisp in the browser, which asks only for a name for the device. Or open{" "}
          {new URL(pairing.link).origin} and enter the code <strong className="font-mono">{pairing.code}</strong>. It
          works once, until {until}.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-dim">
          Anyone with this QR code or code can pair: do not share it or leave it on screen.
        </p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onDone}>
          Done
        </Button>
      </div>
    </SettingsCard>
  );
}

/** Dark modules on a light background with a quiet zone, which phone cameras read in either theme. */
function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { border: 2 });
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-44 flex-none rounded-md bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

function DeviceList({
  devices,
  busy,
  onRevoke,
}: {
  devices: PairedDeviceView[];
  busy: Busy;
  onRevoke: (device: PairedDeviceView) => void;
}) {
  const date = (value: string) => new Date(value).toLocaleDateString([], { dateStyle: "medium" });
  return (
    <SettingsGroup label="Paired devices">
      <SettingsCard variant="stacked">
        {devices.map((device) => (
          <SettingsRow key={device.id} className="flex-wrap">
            <SmartphoneIcon className="size-4 flex-none text-dim" aria-hidden="true" />
            <SettingsRowCopy>
              <SettingsRowTitle>{device.name}</SettingsRowTitle>
              <SettingsRowDescription>
                Paired {date(device.createdAt)}
                {device.lastSeenAt ? ` · Last seen ${date(device.lastSeenAt)}` : ""}
              </SettingsRowDescription>
            </SettingsRowCopy>
            <ConfirmAction
              label="Revoke"
              confirmLabel={`Revoke ${device.name}`}
              pendingLabel="Revoking…"
              pending={busy === `revoke:${device.id}`}
              disabled={busy !== null}
              variant="outline"
              description={`${device.name} is signed out and must pair again to use the Wisps on this computer.`}
              onConfirm={() => onRevoke(device)}
            />
          </SettingsRow>
        ))}
        {devices.length === 0 ? (
          <SettingsRow>
            <SettingsRowDescription>No devices are paired yet.</SettingsRowDescription>
          </SettingsRow>
        ) : null}
      </SettingsCard>
    </SettingsGroup>
  );
}

/** Text with its https links clickable; they open in the browser. */
function WithLinks({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s,]*[^\s,.])/);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a key={index} className="underline" href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
