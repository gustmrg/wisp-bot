import { useEffect, useId, useState } from "react";

import type { ExecutionMode, SaveWispExecutionRequest, WispExecutionView } from "../../shared/execution";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";

const MODES: ReadonlyArray<{ value: ExecutionMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "container", label: "In a container" },
];

const CONTAINER_STATES = { absent: "Not created yet", stopped: "Stopped", running: "Running" } as const;

export function WispExecutionSettings({ conversationId }: { conversationId: string }) {
  const [visited, setVisited] = useState(false);
  return (
    <Accordion
      className="mt-4"
      onValueChange={(values) => {
        if (values.length) setVisited(true);
      }}
    >
      <AccordionItem value="commands">
        <AccordionTrigger>Commands</AccordionTrigger>
        <AccordionContent keepMounted>
          {visited ? <ExecutionPanel key={conversationId} conversationId={conversationId} /> : null}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function ExecutionPanel({ conversationId }: { conversationId: string }) {
  const id = useId();
  const [view, setView] = useState<WispExecutionView | null>(null);
  const [image, setImage] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void window.wisp
      .getWispExecution({ conversationId })
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
  }, [conversationId]);

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
    return (
      <p className="text-sm" role={error ? "alert" : "status"}>
        {error || "Loading…"}
      </p>
    );
  }
  const trimmedImage = image.trim();
  const imageChanged = (trimmedImage || null) !== view.image;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-dim">
        Lets this Wisp run commands such as git, builds and tests in its own container on the server. The container sees
        only this Wisp's workspace, can reach the internet, and stops after 30 minutes without a command.
      </p>
      {view.runtime.available ? null : <p className="text-destructive">{view.runtime.message}</p>}
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
        <>
          <p className="text-dim">
            {view.runtime.available
              ? `${view.runtime.name === "docker" ? "Docker" : "Podman"} ${view.runtime.version} · Container: ${CONTAINER_STATES[view.container]}`
              : `Container: ${CONTAINER_STATES[view.container]}`}
          </p>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-image`}>Image</label>
            <div className="flex gap-2">
              <Input
                id={`${id}-image`}
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
            <p className="text-dim">
              Leave empty for the Wisp sandbox image. Changing it recreates the container; the workspace is kept.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-token`}>GitHub token</label>
            <div className="flex gap-2">
              <Input
                id={`${id}-token`}
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
            <p className="text-dim">
              Used by git for github.com. The Wisp can do whatever the token allows, including pushing, so limit it to
              the repositories and permissions it needs. It is stored encrypted.
            </p>
            {view.hasGitToken ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={saving}
                onClick={() => void save({ gitToken: null }, "Token removed.")}
              >
                Remove token
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      <div aria-live="polite">
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : notice ? (
          <p className="text-dim">{notice}</p>
        ) : null}
      </div>
    </div>
  );
}
