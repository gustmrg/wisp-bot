import { useEffect, useId, useState } from "react";

import type { ExecutionMode, SaveWispExecutionRequest, WispExecutionView } from "../../shared/execution";
import { ConfirmAction } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTransientMessage } from "@/hooks/use-transient-message";

const MODES: ReadonlyArray<{ value: ExecutionMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "container", label: "In a container" },
];

const CONTAINER_STATES = { absent: "Not created yet", stopped: "Stopped", running: "Running" } as const;

/** The Commands section of a Wisp's settings. */
export function WispExecutionSettings({ conversationId }: { conversationId: string }) {
  return <ExecutionPanel key={conversationId} conversationId={conversationId} />;
}

function ExecutionPanel({ conversationId }: { conversationId: string }) {
  const id = useId();
  const [view, setView] = useState<WispExecutionView | null>(null);
  const [image, setImage] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useTransientMessage();
  const [loadRequest, setLoadRequest] = useState({ conversationId });

  useEffect(() => {
    let active = true;
    setError("");
    void window.wisp
      .getWispExecution(loadRequest)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setView(result.value);
        setImage(result.value.image ?? "");
      })
      .catch(() => {
        if (active) setError("Could not load command settings.");
      });
    return () => {
      active = false;
    };
  }, [loadRequest]);

  async function save(changes: Partial<Omit<SaveWispExecutionRequest, "conversationId">>, done: string) {
    if (!view) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await window.wisp.saveWispExecution({
        conversationId,
        mode: view.mode,
        image: view.image,
        localNetwork: view.localNetwork,
        ...changes,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setView(result.value);
      setImage(result.value.image ?? "");
      setNotice(done);
    } catch {
      setError("Could not save command settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!view) {
    return error ? (
      <div className="flex flex-col items-start gap-2">
        <FieldError>{error}</FieldError>
        <Button variant="outline" size="sm" onClick={() => setLoadRequest({ conversationId })}>
          Retry
        </Button>
      </div>
    ) : (
      <FormStatus pending="Loading command settings…" />
    );
  }
  const trimmedImage = image.trim();
  const imageChanged = (trimmedImage || null) !== view.image;
  return (
    <FieldGroup className="gap-3">
      <FieldDescription>
        Lets this Wisp run commands such as git, builds and tests in its own container on the server. The container sees
        only this Wisp's workspace, can reach the internet, and stops after 30 minutes without a command.
      </FieldDescription>
      {view.runtime.available ? null : <FieldError>{view.runtime.message}</FieldError>}
      <Field>
        <SegmentedControl
          label="Run commands"
          value={view.mode}
          options={MODES}
          disabled={saving || (!view.runtime.available && view.mode === "off")}
          onChange={(mode) =>
            void save({ mode }, mode === "off" ? "Commands turned off." : "This Wisp can now run commands.")
          }
        />
        {view.mode === "container" ? (
          <FieldDescription>
            {view.runtime.available
              ? `${view.runtime.name === "docker" ? "Docker" : "Podman"} ${view.runtime.version} · Container: ${CONTAINER_STATES[view.container]}`
              : `Container: ${CONTAINER_STATES[view.container]}`}
          </FieldDescription>
        ) : null}
      </Field>
      {view.mode === "container" ? (
        <>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Allow local network</FieldTitle>
              <FieldDescription>
                {view.localNetwork
                  ? "Commands can reach devices and services on the server's network, such as a router or a NAS."
                  : "Commands reach the internet through a proxy that blocks the server's network and local addresses. Changing this recreates the container."}
              </FieldDescription>
            </FieldContent>
            <ToggleSwitch
              label="Allow local network"
              checked={view.localNetwork}
              disabled={saving}
              onChange={() =>
                void save(
                  { localNetwork: !view.localNetwork },
                  view.localNetwork ? "Local network blocked." : "Local network allowed.",
                )
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-image`}>Image</FieldLabel>
            <div className="flex gap-2">
              <Input
                id={`${id}-image`}
                className="min-w-0"
                value={image}
                placeholder="Wisp sandbox (Debian)"
                disabled={saving}
                onChange={(event) => setImage(event.currentTarget.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={saving || !imageChanged}
                onClick={() => void save({ image: trimmedImage || null }, "Image saved. The container is recreated.")}
              >
                Save
              </Button>
            </div>
            <FieldDescription>
              Leave empty for the Wisp sandbox image. Changing it recreates the container; the workspace is kept.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-token`}>GitHub token</FieldLabel>
            <div className="flex gap-2">
              <Input
                id={`${id}-token`}
                className="min-w-0"
                type="password"
                autoComplete="new-password"
                value={token}
                placeholder={view.hasGitToken ? "Saved — enter a replacement" : "Fine-grained token"}
                disabled={saving}
                onChange={(event) => setToken(event.currentTarget.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={saving || !token.trim()}
                onClick={() => void save({ gitToken: token.trim() }, "Token saved.").then(() => setToken(""))}
              >
                Save
              </Button>
            </div>
            <FieldDescription>
              Used by git for github.com. The Wisp can do whatever the token allows, including pushing, so limit it to
              the repositories and permissions it needs. It is stored encrypted.
            </FieldDescription>
            {view.hasGitToken ? (
              <ConfirmAction
                label="Remove token"
                confirmLabel="Remove token"
                variant="outline"
                className="w-full"
                disabled={saving}
                description="Git commands in this Wisp's container lose access to private repositories on github.com until you save a new token."
                onConfirm={() => void save({ gitToken: null }, "Token removed.")}
              />
            ) : null}
          </Field>
        </>
      ) : null}
      <FormStatus error={error} notice={notice} />
    </FieldGroup>
  );
}
