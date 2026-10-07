import { useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, ChevronLeftIcon, LoaderCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ConnectionsView, SshConnectionProfile, SshServerCheck } from "../../../shared/connections";
import { InstallServerAction } from "./install-server-action";
import { SshPromptCard } from "./ssh-prompt-card";

type Step =
  | { kind: "checking" }
  | { kind: "failed"; message: string }
  | { kind: "checked"; check: SshServerCheck }
  | { kind: "connecting" };

/**
 * The second step of adding a server over SSH: connects once, answering
 * OpenSSH's questions here, then connects to the Wisp server there, or
 * offers to install or update it first.
 */
export function SshServerSetup({
  view,
  profile,
  onBack,
  onDone,
}: {
  view: ConnectionsView;
  profile: SshConnectionProfile;
  /** Back to the connection's settings, to correct them. */
  onBack: () => void;
  /** Connected, or connecting: back to the list of connections. */
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const checking = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving while a check waits for an answer stops it. Strict mode remounts at once, which does not count.
      setTimeout(() => {
        if (!mounted.current && checking.current) void window.wisp.cancelSshCheck();
      });
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries the check; connect only uses the profile.
  useEffect(() => {
    // One check at a time is all the main process allows; strict mode runs effects twice.
    if (checking.current) return;
    checking.current = true;
    setStep({ kind: "checking" });
    void window.wisp
      .checkSshServer({ id: profile.id })
      .then(async (result) => {
        checking.current = false;
        if (!mounted.current) return;
        if (!result.ok) setStep({ kind: "failed", message: result.error.message });
        else if (result.value.installedVersion === result.value.appVersion) await connect();
        else setStep({ kind: "checked", check: result.value });
      })
      .catch(() => {
        checking.current = false;
        if (mounted.current) setStep({ kind: "failed", message: "The connection could not be checked." });
      });
  }, [profile.id, attempt]);

  async function connect() {
    setStep({ kind: "connecting" });
    const result = await window.wisp.activateConnection({ id: profile.id });
    if (result.ok) onDone();
    else setStep({ kind: "failed", message: result.error.message });
  }

  const check = step.kind === "checked" ? step.check : undefined;
  return (
    <div className="animate-tab-forward">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2"
        onClick={() => {
          if (checking.current) void window.wisp.cancelSshCheck();
          onBack();
        }}
      >
        <ChevronLeftIcon aria-hidden="true" />
        {profile.name}
      </Button>
      <h3 className="mb-3 mt-0 text-md font-medium">Connect to {profile.name}</h3>
      {step.kind === "checking" || step.kind === "connecting" ? (
        <>
          {step.kind === "checking" && view.sshPrompt ? <SshPromptCard prompt={view.sshPrompt} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <LoaderCircleIcon className="size-4 animate-spin text-dim" aria-hidden="true" />
            <p role="status" className="m-0 text-sm text-dim">
              {step.kind === "checking"
                ? `Connecting to ${profile.host} over SSH…`
                : `Connecting to the Wisp server on ${profile.host}…`}
            </p>
            {step.kind === "checking" && !view.sshPrompt ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => void window.wisp.cancelSshCheck()}>
                Cancel
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {step.kind === "failed" ? (
        <>
          <p role="alert" className="mb-3 mt-0 text-sm leading-relaxed text-destructive">
            {step.message}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setAttempt((count) => count + 1)}>
              Try again
            </Button>
            <Button type="button" variant="outline" onClick={onBack}>
              Change settings
            </Button>
          </div>
        </>
      ) : null}
      {check ? (
        <>
          <p className="mb-3 mt-0 flex items-start gap-2 text-sm leading-relaxed">
            <CheckCircle2Icon className="mt-0.5 size-4 flex-none text-emerald-500" aria-hidden="true" />
            <span>
              Signed in to {profile.host}.
              {check.addedKey
                ? " Wisp added its own key there, so it connects without the password from now on."
                : null}
            </span>
          </p>
          <p className="mb-3 mt-0 text-sm leading-relaxed text-dim">
            {check.installedVersion
              ? `Wisp server ${check.installedVersion} is installed there. Update it to ${check.appVersion}, the version of this app?`
              : `The Wisp server is not installed on ${profile.host} yet. If it runs another way, such as in Docker, connect anyway.`}
          </p>
          <InstallServerAction
            view={view}
            profileId={profile.id}
            host={profile.host}
            label={check.installedVersion ? "Update and connect" : "Install the Wisp server"}
            checked
            onInstalled={onDone}
          />
          <Button type="button" variant="ghost" size="sm" className="mt-2 -ml-2" onClick={() => void connect()}>
            {check.installedVersion ? "Connect without updating" : "Connect anyway"}
          </Button>
        </>
      ) : null}
    </div>
  );
}
