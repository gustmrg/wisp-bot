import { useState, type ReactNode } from "react";
import {
  ArrowUpCircleIcon,
  BanIcon,
  ChevronRightIcon,
  CircleXIcon,
  CopyIcon,
  InfoIcon,
  KeyRoundIcon,
  LaptopIcon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  WifiOffIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APP_METADATA } from "@/config/app-metadata";
import { cn } from "@/lib/utils";
import {
  LOCAL_CONNECTION_ID,
  type ConnectionFailure,
  type ConnectionProfileView,
  type ConnectionProgress,
  type ConnectionsView,
} from "../../../shared/connections";
import { WISP_SERVER_PACKAGE } from "../../../shared/server-package";
import { ConnectionSteps, formatDuration, hostOf, useNow } from "./connection-steps";
import { ConnectionsPanel } from "./connections-panel";
import { UpdateServerDialog, compareVersions } from "./update-server-dialog";

export function activeProfile(view: ConnectionsView): ConnectionProfileView | undefined {
  return view.profiles.find((profile) => profile.id === view.activeId);
}

export function activeName(view: ConnectionsView): string {
  return activeProfile(view)?.name ?? "the server";
}

/** Whether this client can leave the active server for the Wisps on this computer. */
export function canUseThisComputer(view: ConnectionsView): boolean {
  return (
    view.canManage !== false &&
    view.activeId !== LOCAL_CONNECTION_ID &&
    view.profiles.some(({ kind }) => kind === "local")
  );
}

/** Where the profile points: user@host over SSH, or the server's address. */
export function addressOf(profile: ConnectionProfileView): string {
  if (profile.kind === "ssh") return `${profile.user ? `${profile.user}@` : ""}${profile.host}`;
  if (profile.kind === "url") return hostOf(profile.url);
  return "Wisps run on this computer";
}

const KIND_TAGS: Record<ConnectionProfileView["kind"], string> = { local: "This computer", ssh: "SSH", url: "HTTPS" };

/** Which connection the screen is about: its name, kind, address, and the server version last reached. */
export function ServerChip({
  profile,
  serverVersion,
  onSwitch,
}: {
  profile: ConnectionProfileView;
  serverVersion?: string | undefined;
  onSwitch?: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-[10px] bg-muted px-2.5 py-2 text-sm">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-card text-dim">
        {profile.kind === "local" ? (
          <LaptopIcon aria-hidden="true" className="size-4" />
        ) : (
          <ServerIcon aria-hidden="true" className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-medium">
          <span className="truncate">{profile.name}</span>
          <span className="shrink-0 rounded-full border border-input px-1.5 text-2xs leading-[18px] font-medium text-dim">
            {KIND_TAGS[profile.kind]}
          </span>
        </span>
        <span className="block truncate font-mono text-xs text-dim">
          {addressOf(profile)}
          {serverVersion ? ` · server ${serverVersion}` : ""}
        </span>
      </span>
      {onSwitch ? (
        <Button type="button" size="xs" variant="ghost" className="shrink-0" onClick={onSwitch}>
          Switch
        </Button>
      ) : null}
    </div>
  );
}

type Tone = "info" | "warn" | "error" | "neutral";

const TONES: Record<Tone, string> = {
  info: "[--tone:var(--blue)]",
  warn: "[--tone:var(--warning-solid)]",
  error: "[--tone:var(--destructive)]",
  neutral: "[--tone:var(--text-dim)]",
};

type ActionResult = { ok: true } | { ok: false; error: { message: string } };

function failureTitle(failure: ConnectionFailure | undefined, name: string): string {
  switch (failure) {
    case "unreachable":
      return `Cannot reach ${name}`;
    case "auth":
      return `Could not sign in to ${name}`;
    case "host_key":
      return `${name}'s SSH host key is not trusted`;
    case "not_installed":
      return `Wisp is not installed on ${name}`;
    case "not_running":
      return `The Wisp server is not running on ${name}`;
    case "node":
      return `Node.js is missing on ${name}`;
    case "version":
      return `${name} runs another version of Wisp`;
    case "wrong_server":
      return `${name} is not the server this device paired with`;
    default:
      return `Cannot use ${name}`;
  }
}

function FailureIcon({ failure }: { failure: ConnectionFailure | undefined }) {
  const className = "size-5";
  if (failure === "unreachable") return <WifiOffIcon aria-hidden="true" className={className} />;
  if (failure === "auth" || failure === "host_key") return <KeyRoundIcon aria-hidden="true" className={className} />;
  if (failure === "not_installed" || failure === "not_running") {
    return <ServerIcon aria-hidden="true" className={className} />;
  }
  return <CircleXIcon aria-hidden="true" className={className} />;
}

/**
 * The bar on top of the card: filled up to the steps done, with a shimmer
 * over the one running, so it shows how far connecting or a setup has come.
 */
function ProgressBar({ progress }: { progress: ConnectionProgress }) {
  const total = progress.steps.length;
  if (total === 0) return null;
  const done = progress.steps.filter(({ state }) => state === "done").length;
  const running = progress.steps.some(({ state }) => state === "active");
  const share = 100 / total;
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-[color-mix(in_srgb,var(--tone)_14%,transparent)]"
    >
      <div
        className="h-full bg-[var(--tone)] transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${done * share}%` }}
      />
      {running ? (
        <div
          className="connection-progress-step absolute inset-y-0"
          style={{ left: `${done * share}%`, width: `${share}%` }}
        />
      ) : null}
    </div>
  );
}

/**
 * Shown while the chosen server is connecting, being set up, needs pairing,
 * or cannot be used. One card for every state: which server, what is
 * happening step by step, what went wrong, and what the person can do.
 */
export function ConnectionScreen({ view }: { view: ConnectionsView }) {
  const { status } = view;
  const profile = activeProfile(view);
  const name = activeName(view);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [manage, setManage] = useState<{ open: boolean; editing: string | null }>({ open: false, editing: null });
  const [updating, setUpdating] = useState(false);
  const progress = status.progress;
  const retry = status.retry;
  const running = status.phase === "connecting" && Boolean(progress?.steps.some(({ state }) => state === "active"));
  const now = useNow(running || Boolean(retry?.nextAttemptAt));

  async function act(action: () => Promise<ActionResult>) {
    setBusy(true);
    setActionError("");
    try {
      const result = await action();
      if (!result.ok) setActionError(result.error.message);
    } catch {
      setActionError("Wisp could not change the connection.");
    } finally {
      setBusy(false);
    }
  }

  const canManage = view.canManage !== false;
  const remote = profile !== undefined && profile.kind !== "local";
  const ssh = profile?.kind === "ssh" ? profile : undefined;
  const setup = progress && progress.kind !== "connect" ? progress : undefined;
  const fromVersion = setup?.fromVersion ?? status.serverVersion;
  const install = () => act(() => window.wisp.installServer({ id: view.activeId }));
  const retryNow = () => act(() => window.wisp.retryConnection());
  const cancel = () =>
    act(() => (status.installing ? window.wisp.cancelServerInstall() : window.wisp.cancelConnection()));
  const editConnection = () => setManage({ open: true, editing: view.activeId });

  const useLocal = canUseThisComputer(view) ? (
    <Button
      type="button"
      variant="ghost"
      disabled={busy}
      onClick={() => void act(() => window.wisp.activateConnection({ id: LOCAL_CONNECTION_ID }))}
    >
      <LaptopIcon aria-hidden="true" />
      Use this computer instead
    </Button>
  ) : null;
  const editButton =
    canManage && remote ? (
      <Button type="button" variant="outline" disabled={busy} onClick={editConnection}>
        <Settings2Icon aria-hidden="true" />
        Edit connection
      </Button>
    ) : null;

  let tone: Tone;
  let icon: ReactNode;
  // Whether the card shows how far the steps have come; only the running step spins.
  let showProgress = false;
  let title: string;
  let text: ReactNode = status.message;
  let body: ReactNode = null;
  let actions: ReactNode;
  let aside: ReactNode = null;
  const waitingForAnswer = Boolean(view.sshPrompt);
  const steps = progress ? (
    <ConnectionSteps
      className="mt-4"
      progress={progress}
      {...(profile ? { profile } : {})}
      {...(status.failure ? { failure: status.failure } : {})}
      waitingForAnswer={waitingForAnswer && status.phase === "connecting"}
      now={now}
    />
  ) : null;
  const details = status.details ? (
    <Disclosure label={setup ? "Setup output" : "Technical details"}>{status.details}</Disclosure>
  ) : null;

  if (status.phase === "pairing_required") {
    tone = "neutral";
    icon = <KeyRoundIcon aria-hidden="true" className="size-5" />;
    title = `Pair with ${name}`;
    body = (
      <form
        className="mt-4 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void act(() => window.wisp.activateConnection({ id: view.activeId, pairingCode: code }));
        }}
      >
        <Input
          aria-label="Pairing code"
          className="w-44 font-mono uppercase"
          placeholder="ABCDE-FGHJK"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button type="submit" disabled={busy || code.trim().length === 0}>
          Pair
        </Button>
        {ssh ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void retryNow()}>
            Pair over SSH
          </Button>
        ) : null}
      </form>
    );
    actions = useLocal;
  } else if (setup && status.phase === "connecting") {
    // Setting the server up, or connecting to it right after.
    const update = setup.kind === "update";
    tone = "info";
    icon = <ArrowUpCircleIcon aria-hidden="true" className="size-5" />;
    showProgress = true;
    title = update ? `Updating ${name}` : `Setting up Wisp on ${name}`;
    text = `${update && fromVersion ? `${fromVersion} → ${APP_METADATA.version}. ` : ""}This can take a few minutes; keep this app open.`;
    body = steps;
    actions = (
      <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
        {update ? "Cancel update" : "Cancel setup"}
      </Button>
    );
  } else if (setup && status.phase === "error" && status.failure === "cancelled") {
    const update = setup.kind === "update";
    // Cancelled before anything was installed, the server is as it was.
    const untouched = setup.steps.find(({ id }) => id === "download")?.state !== "done";
    tone = "neutral";
    icon = <BanIcon aria-hidden="true" className="size-5" />;
    title = update ? "Update cancelled" : "Setup cancelled";
    text = untouched
      ? update && fromVersion
        ? `${name} still runs ${fromVersion}. Nothing was changed on the server.`
        : `Nothing was changed on ${name}.`
      : `The server on ${name} may be partly ${update ? "updated" : "set up"}. ${update ? "Update" : "Set it up"} again to finish.`;
    body = steps;
    actions = (
      <>
        {update && fromVersion ? (
          <Button type="button" disabled={busy} onClick={() => void retryNow()}>
            Continue with {fromVersion}
          </Button>
        ) : null}
        <Button
          type="button"
          variant={update && fromVersion ? "outline" : "default"}
          disabled={busy}
          onClick={() => void install()}
        >
          <RefreshCwIcon aria-hidden="true" />
          {update ? "Update again" : "Set up again"}
        </Button>
      </>
    );
    aside = useLocal;
  } else if (setup && status.phase === "error") {
    const update = setup.kind === "update";
    tone = "error";
    icon = <CircleXIcon aria-hidden="true" className="size-5" />;
    title = update ? `Could not update ${name}` : `Could not set up Wisp on ${name}`;
    text = update && fromVersion ? `The server was not updated from ${fromVersion}.` : undefined;
    body = (
      <>
        {steps}
        <Guidance message={status.message} />
        {details}
      </>
    );
    actions = (
      <>
        <Button type="button" disabled={busy} onClick={() => void install()}>
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
        {update && fromVersion ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void retryNow()}>
            Continue with {fromVersion}
          </Button>
        ) : null}
      </>
    );
    aside = useLocal;
  } else if (status.phase === "error" && status.failure === "cancelled") {
    tone = "neutral";
    icon = <BanIcon aria-hidden="true" className="size-5" />;
    title = "Connection cancelled";
    text = `Wisp stopped connecting to ${name}.`;
    body = steps;
    actions = (
      <Button type="button" disabled={busy} onClick={() => void retryNow()}>
        <RefreshCwIcon aria-hidden="true" />
        Try again
      </Button>
    );
    aside = useLocal;
  } else if (status.phase === "error" || (status.phase === "connecting" && retry && retry.attempt > 0)) {
    // Failed: for good, or for now while Wisp keeps trying.
    const retrying = status.phase === "connecting";
    const offerInstall = ssh && canManage && (status.failure === "not_installed" || status.failure === "not_running");
    const offerUpdate =
      ssh &&
      canManage &&
      status.failure === "version" &&
      status.serverVersion !== undefined &&
      compareVersions(status.serverVersion, APP_METADATA.version) < 0;
    tone = "error";
    icon = <FailureIcon failure={status.failure} />;
    title = failureTitle(status.failure, name);
    text = retrying ? <RetryLine retry={retry} now={now} /> : undefined;
    body = (
      <>
        {steps}
        <Guidance message={status.message} />
        {offerInstall && ssh ? (
          <Note icon={<InfoIcon aria-hidden="true" className="size-3.5" />} title="Wisp can set it up for you">
            Wisp runs the setup of <code>{WISP_SERVER_PACKAGE}</code> on {ssh.host} over SSH. It installs the server in{" "}
            <code>~/.local/lib/wisp-server</code>, creates a master key in <code>~/.config/wisp</code>, and starts a
            systemd user service. The machine needs Node.js 22.19 or later and internet access.
          </Note>
        ) : null}
        {details}
      </>
    );
    actions = (
      <>
        {offerInstall && ssh ? (
          <Button type="button" disabled={busy} onClick={() => void install()}>
            <ArrowUpCircleIcon aria-hidden="true" />
            Install on {ssh.host}
          </Button>
        ) : offerUpdate ? (
          <Button type="button" disabled={busy} onClick={() => setUpdating(true)}>
            <ArrowUpCircleIcon aria-hidden="true" />
            Update server
          </Button>
        ) : null}
        <Button
          type="button"
          variant={offerInstall || offerUpdate ? "outline" : "default"}
          disabled={busy}
          onClick={() => void retryNow()}
        >
          <RefreshCwIcon aria-hidden="true" />
          {retrying ? "Try again now" : "Try again"}
        </Button>
        {retrying && canManage ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : null}
        {editButton}
      </>
    );
    aside = useLocal;
  } else if (waitingForAnswer) {
    tone = "warn";
    icon = <KeyRoundIcon aria-hidden="true" className="size-5" />;
    title = `${name} needs your answer`;
    text = "OpenSSH is asking a question. Answer it to continue.";
    body = steps;
    actions = canManage ? (
      <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
        Cancel
      </Button>
    ) : null;
  } else {
    tone = "info";
    icon =
      profile?.kind === "local" ? (
        <LaptopIcon aria-hidden="true" className="size-5" />
      ) : (
        <ServerIcon aria-hidden="true" className="size-5" />
      );
    showProgress = true;
    title = profile?.kind === "local" ? "Starting Wisps on this computer" : `Connecting to ${name}`;
    text = "This usually takes a few seconds.";
    body = steps;
    actions = (
      <>
        {canManage ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </Button>
        ) : null}
      </>
    );
    aside = useLocal;
  }

  return (
    <main className="flex h-full min-h-0 items-start justify-center overflow-y-auto bg-background p-6 text-foreground max-[760px]:p-3">
      <div className="my-auto w-full max-w-lg">
        <section
          className={cn("relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm", TONES[tone])}
          aria-labelledby="connection-title"
        >
          {showProgress && progress ? <ProgressBar progress={progress} /> : null}
          <div className="p-6 max-[760px]:px-4 max-[760px]:py-[18px]">
            {profile ? (
              <ServerChip
                profile={profile}
                serverVersion={status.serverVersion}
                {...(canManage
                  ? { onSwitch: () => setManage((current) => ({ open: !current.open, editing: null })) }
                  : {})}
              />
            ) : null}
            <div className="mt-[18px] flex items-start gap-3.5">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--tone)_14%,transparent)] text-[var(--tone)]">
                {icon}
              </div>
              <div className="min-w-0">
                <h1 id="connection-title" className="m-0 text-lg leading-snug font-semibold">
                  {title}
                </h1>
                {text ? (
                  <p
                    role={tone === "error" ? "alert" : "status"}
                    className="mt-1 mb-0 text-base leading-relaxed text-dim"
                  >
                    {text}
                  </p>
                ) : null}
              </div>
            </div>
            {body}
            {actions || aside ? (
              <div className="mt-5 flex flex-wrap items-center gap-2 max-[760px]:flex-col max-[760px]:items-stretch">
                {actions}
                {aside}
              </div>
            ) : null}
            {actionError ? (
              <p role="alert" className="mt-3 mb-0 text-sm text-destructive">
                {actionError}
              </p>
            ) : null}
          </div>
          {canManage ? (
            <button
              type="button"
              aria-label="Manage connections"
              aria-expanded={manage.open}
              className="flex w-full items-center gap-2 border-t border-border bg-[color-mix(in_srgb,var(--muted)_40%,var(--card))] px-6 py-2.5 text-left text-sm text-dim outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-[760px]:px-4"
              onClick={() => setManage((current) => ({ open: !current.open, editing: null }))}
            >
              <Settings2Icon aria-hidden="true" className="size-4" />
              Connections
              <span className="ml-auto flex items-center gap-1 text-xs font-medium">
                {manage.open ? "Hide" : "Manage"}
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn("size-3.5 transition-transform", manage.open && "rotate-90")}
                />
              </span>
            </button>
          ) : null}
        </section>
        {canManage && manage.open ? (
          <section className="mt-4 rounded-2xl border border-border bg-card p-4" aria-label="Connections">
            <ConnectionsPanel key={manage.editing ?? "list"} view={view} initialEditing={manage.editing} />
          </section>
        ) : null}
      </div>
      {updating && ssh && status.serverVersion ? (
        <UpdateServerDialog
          name={name}
          host={ssh.host}
          serverVersion={status.serverVersion}
          onConfirm={() => {
            setUpdating(false);
            void install();
          }}
          onCancel={() => setUpdating(false)}
        />
      ) : null}
    </main>
  );
}

function RetryLine({ retry, now }: { retry: ConnectionsView["status"]["retry"]; now: number }) {
  if (!retry) return null;
  const next = retry.nextAttemptAt ? Math.max(0, Math.ceil((retry.nextAttemptAt - now) / 1000)) : undefined;
  return (
    <>
      {retry.attempt} failed {retry.attempt === 1 ? "attempt" : "attempts"} ·{" "}
      {next === undefined ? "trying again now…" : `trying again in ${next}s`}
      {retry.since ? <span className="text-faint"> · failing for {formatDuration(now - retry.since)}</span> : null}
    </>
  );
}

/**
 * What to do about a failure. The messages name commands in backticks, which
 * show as code; a command on its own can be copied.
 */
function Guidance({ message }: { message: string | undefined }) {
  if (!message) return null;
  const parts = message.split(/(`[^`]+`)/g);
  const command = parts.find((part) => /^`.+`$/.test(part) && /\s/.test(part))?.slice(1, -1);
  return (
    <Note tone="error" title="What to do">
      <p className="m-0">
        {parts.map((part, index) =>
          /^`.+`$/.test(part) ? <code key={index}>{part.slice(1, -1)}</code> : <span key={index}>{part}</span>,
        )}
      </p>
      {command ? <CopyCommand command={command} /> : null}
    </Note>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-card py-1 pr-1 pl-2.5 text-xs">
      <code className="min-w-0 flex-1 [overflow-wrap:anywhere]">{command}</code>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() =>
          void navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        <CopyIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

function Note({
  title,
  icon,
  tone = "neutral",
  children,
}: {
  title: string;
  icon?: ReactNode;
  tone?: "neutral" | "error";
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-4 rounded-[10px] border px-3.5 py-3 text-sm leading-relaxed",
        tone === "error"
          ? "border-destructive/30 bg-[color-mix(in_srgb,var(--destructive)_6%,var(--card))]"
          : "border-border bg-popover",
      )}
    >
      <h2 className="m-0 mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </div>
  );
}

function Disclosure({ label, children }: { label: string; children: string }) {
  return (
    <details className="group mt-3 text-sm">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-dim [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <pre className="mt-2 mb-0 max-h-40 overflow-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-dim [overflow-wrap:anywhere]">
        {children}
      </pre>
    </details>
  );
}
