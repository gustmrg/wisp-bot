import { useEffect, useId, useState } from "react";

import type { ExecutionMode, SaveWispExecutionRequest, WispExecutionView } from "../../shared/execution";
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

/** The Commands & browser section of a Wisp's settings. */
export function WispExecutionSettings({ conversationId }: { conversationId: string }) {
  return <ExecutionPanel key={conversationId} conversationId={conversationId} />;
}

function ExecutionPanel({ conversationId }: { conversationId: string }) {
  const id = useId();
  const [view, setView] = useState<WispExecutionView | null>(null);
  const [image, setImage] = useState("");
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
        browser: view.browser,
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
  const commands = view.mode === "container";
  return (
    <FieldGroup className="gap-3">
      <FieldDescription>
        Lets this Wisp run commands such as git, builds and tests in its own container on the server. The container sees
        only this Wisp's workspace, can reach the internet, and stops after 30 minutes without a command.
      </FieldDescription>
      {view.runtime.available ? null : <FieldError>{view.runtime.message}</FieldError>}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>Run commands</FieldTitle>
          {view.mode === "container" ? (
            <FieldDescription>
              {view.runtime.available
                ? `${view.runtime.name === "docker" ? "Docker" : "Podman"} ${view.runtime.version} · Container: ${CONTAINER_STATES[view.container]}`
                : `Container: ${CONTAINER_STATES[view.container]}`}
            </FieldDescription>
          ) : null}
        </FieldContent>
        <SegmentedControl
          label="Run commands"
          value={view.mode}
          options={MODES}
          disabled={saving || (!view.runtime.available && view.mode === "off")}
          onChange={(mode) =>
            void save({ mode }, mode === "off" ? "Commands turned off." : "This Wisp can now run commands.")
          }
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>Use a browser</FieldTitle>
          <FieldDescription>
            Opens pages in a browser of its own, in another container, to follow links and fill in forms. It cannot see
            the workspace. Clicking buttons, sending forms and typing passwords ask you first.
          </FieldDescription>
        </FieldContent>
        <ToggleSwitch
          label="Use a browser"
          checked={view.browser}
          disabled={saving || (!view.runtime.available && !view.browser)}
          onChange={() =>
            void save(
              { browser: !view.browser },
              view.browser ? "Browser turned off." : "This Wisp can now use a browser.",
            )
          }
        />
      </Field>
      {commands || view.browser ? (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>Allow local network</FieldTitle>
            <FieldDescription>
              {view.localNetwork
                ? "Commands and the browser can reach devices and services on the server's network, such as a router or a NAS."
                : "Commands and the browser reach the internet through a proxy that blocks the server's network and local addresses. Changing this recreates their containers."}
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
      ) : null}
      {commands ? (
        <>
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
            <FieldTitle>GitHub</FieldTitle>
            <FieldDescription>
              {view.gitHubPlugin
                ? "git reaches github.com through the server, which adds the GitHub plugin's token, so the Wisp can clone and push whatever the token allows without ever seeing it."
                : "To use private repositories, add the GitHub plugin in Settings → Plugins and give this Wisp access to it."}
            </FieldDescription>
          </Field>
          <Field>
            <FieldTitle>GitLab</FieldTitle>
            <FieldDescription>
              {view.gitLabInstance
                ? `git reaches ${view.gitLabInstance} through the server, which adds the GitLab plugin's token, so the Wisp can clone and push whatever the token allows without ever seeing it.`
                : "To use private projects on GitLab.com or your own GitLab, add the GitLab plugin in Settings → Plugins and give this Wisp access to it."}
            </FieldDescription>
          </Field>
        </>
      ) : null}
      <FormStatus error={error} notice={notice} />
    </FieldGroup>
  );
}
