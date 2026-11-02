import { useEffect, useState } from "react";

import type { CircleExecutionView } from "../../shared/execution";
import type { Wisp } from "@/chat-data";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldTitle } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTransientMessage } from "@/hooks/use-transient-message";

/** Whether a circle's members may run commands in its workspace (ADR 041). */
export function CircleExecutionSettings({
  conversationId,
  members,
}: {
  conversationId: string;
  members: ReadonlyArray<Wisp>;
}) {
  const [view, setView] = useState<CircleExecutionView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useTransientMessage();

  useEffect(() => {
    let active = true;
    setError("");
    void Promise.resolve()
      .then(() => window.wisp.getCircleExecution({ conversationId }))
      .then((result) => {
        if (!active) return;
        if (result.ok) setView(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (active) setError("Could not load command settings.");
      });
    return () => {
      active = false;
    };
  }, [conversationId]);

  async function toggle(current: CircleExecutionView) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await window.wisp.saveCircleExecution({ conversationId, commands: !current.commands });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setView(result.value);
      setNotice(result.value.commands ? "Members can now run commands here." : "Commands turned off in this circle.");
    } catch {
      setError("Could not save command settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!view) return error ? <FieldError>{error}</FieldError> : <FormStatus pending="Loading command settings…" />;
  const able = members.filter(({ id }) => view.memberIdsWithCommands.includes(id)).map(({ name }) => name);
  return (
    <FieldGroup className="gap-3">
      {view.runtime.available ? null : <FieldError>{view.runtime.message}</FieldError>}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldTitle>Run commands</FieldTitle>
          <FieldDescription>
            Lets members run commands such as git, builds and tests in this workspace, each in a container of its own.
          </FieldDescription>
        </FieldContent>
        <ToggleSwitch
          label="Run commands in this circle"
          checked={view.commands}
          disabled={saving || (!view.runtime.available && !view.commands)}
          onChange={() => void toggle(view)}
        />
      </Field>
      <FieldDescription>
        Turn this on only for Wisps you trust together. They share these files, so a script one of them leaves here runs
        with the git and network access of whichever member runs it.
      </FieldDescription>
      {view.commands ? (
        <FieldDescription>
          {able.length
            ? `Can run commands here: ${able.join(", ")}.`
            : "No member can run commands yet. Turn on Run commands in each Wisp's settings."}
        </FieldDescription>
      ) : null}
      <FormStatus error={error} notice={notice} />
    </FieldGroup>
  );
}
