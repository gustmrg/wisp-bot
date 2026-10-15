import { useEffect, useId, useState } from "react";
import {
  DEFAULT_CONTEXT_POLICY,
  isContextPolicy,
  type ContextCommand,
  type ContextPolicy,
  type ContextView,
} from "../../shared/context-policy";
import { ConfirmAction, SettingsActions } from "@/components/settings/settings-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTransientMessage } from "@/hooks/use-transient-message";

const modes = [
  { value: "idle", label: "After inactivity" },
  { value: "daily", label: "Daily" },
  { value: "both", label: "Inactivity or daily" },
  { value: "none", label: "Manual only" },
];

const renewals = [
  { value: "new_topic", label: "Start a new topic" },
  { value: "compact", label: "Summarize and continue" },
];

/** The Context & memory section of a Wisp's settings. */
export function WispContextSettings({ conversationId }: { conversationId: string }) {
  return <ContextForm key={conversationId} conversationId={conversationId} />;
}

function ContextForm({ conversationId }: { conversationId: string }) {
  const id = useId();
  const [view, setView] = useState<ContextView | null>(null);
  const [policy, setPolicy] = useState<ContextPolicy>({ ...DEFAULT_CONTEXT_POLICY });
  const [memory, setMemory] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useTransientMessage();
  const [loadRequest, setLoadRequest] = useState({ conversationId });
  useEffect(() => {
    let active = true;
    void Promise.all([
      window.wisp.manageContext({ ...loadRequest, command: { action: "get" } }),
      window.wisp.getConversationModel({ conversationId }),
    ])
      .then(([result, model]) => {
        if (!active) return;
        if (model.ok) setWorking(model.value.status === "working");
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setView(result.value);
        setPolicy(result.value.policy);
        setMemory(result.value.memory);
        setError("");
      })
      .catch(() => {
        if (active) setError("Could not load context settings.");
      });
    const unsubscribe = window.wisp.subscribeToAgentEvents((event) => {
      if (event.conversationId !== conversationId) return;
      if (event.type === "conversation_status") setWorking(event.status === "working");
      if (event.type === "conversation_context_renewed") {
        void window.wisp
          .manageContext({ conversationId, command: { action: "get" } })
          .then((result) => {
            if (active && result.ok) setView(result.value);
          })
          .catch(() => undefined);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [conversationId, loadRequest]);

  async function run(command: ContextCommand) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await window.wisp.manageContext({ conversationId, command });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setView(result.value);
      setNotice(
        command.action === "save"
          ? "Context settings saved."
          : command.action === "compact"
            ? "Context summarized. History preserved."
            : "New topic started. History and saved memory preserved.",
      );
    } catch {
      setError("Could not update context. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return (
      <div className="flex flex-col items-start gap-2">
        {error ? (
          <>
            <FieldError>{error}</FieldError>
            <Button variant="outline" size="sm" onClick={() => setLoadRequest({ conversationId })}>
              Retry
            </Button>
          </>
        ) : (
          <FormStatus pending="Loading context…" />
        )}
      </div>
    );
  const disabled = busy || working;
  const dirty = JSON.stringify(policy) !== JSON.stringify(view.policy) || memory !== view.memory;
  return (
    <FieldGroup className="gap-3">
      <FieldDescription>
        Your chat history stays visible. Summaries retain goals, decisions and pending work; the Wisp can search older
        messages when needed.
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor={`${id}-mode`}>Renew context</FieldLabel>
        <Select
          items={modes}
          value={policy.mode}
          disabled={disabled}
          onValueChange={(value) => {
            if (value) setPolicy((current) => ({ ...current, mode: value as ContextPolicy["mode"] }));
          }}
        >
          <SelectTrigger id={`${id}-mode`} className="w-full min-[761px]:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modes.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {mode.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {policy.mode !== "none" ? (
          <FieldDescription>
            Checked when your next message arrives. Small conversations are kept intact. Automatic compression near the
            model limit remains enabled.
          </FieldDescription>
        ) : null}
      </Field>
      {policy.mode !== "none" ? (
        <Field>
          <FieldLabel htmlFor={`${id}-renewal`}>On renewal</FieldLabel>
          <Select
            items={renewals}
            value={policy.renewal}
            disabled={disabled}
            onValueChange={(value) => {
              if (value) setPolicy((current) => ({ ...current, renewal: value as ContextPolicy["renewal"] }));
            }}
          >
            <SelectTrigger id={`${id}-renewal`} className="w-full min-[761px]:w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {renewals.map((renewal) => (
                <SelectItem key={renewal.value} value={renewal.value}>
                  {renewal.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            {policy.renewal === "new_topic"
              ? "The next message starts without earlier context, which uses the fewest tokens. The Wisp can still search older messages."
              : "A summary keeps goals, decisions and pending work. Summarizing uses model tokens."}
          </FieldDescription>
        </Field>
      ) : null}
      <div className="grid gap-3 min-[761px]:grid-cols-2">
        {policy.mode === "idle" || policy.mode === "both" ? (
          <Field>
            <FieldLabel htmlFor={`${id}-idle`}>Inactivity (hours)</FieldLabel>
            <Input
              id={`${id}-idle`}
              type="number"
              min={1}
              max={720}
              value={policy.idleHours}
              disabled={disabled}
              onChange={(event) => setPolicy((current) => ({ ...current, idleHours: Number(event.target.value) }))}
            />
          </Field>
        ) : null}
        {policy.mode === "daily" || policy.mode === "both" ? (
          <Field>
            <FieldLabel htmlFor={`${id}-daily`}>Daily hour (your timezone, 0–23)</FieldLabel>
            <Input
              id={`${id}-daily`}
              type="number"
              min={0}
              max={23}
              value={policy.dailyHour}
              disabled={disabled}
              onChange={(event) => setPolicy((current) => ({ ...current, dailyHour: Number(event.target.value) }))}
            />
          </Field>
        ) : null}
        {policy.mode !== "none" ? (
          <Field>
            <FieldLabel htmlFor={`${id}-tokens`}>Minimum context tokens</FieldLabel>
            <Input
              id={`${id}-tokens`}
              type="number"
              min={1000}
              max={200000}
              step={1000}
              value={policy.minimumTokens}
              disabled={disabled}
              onChange={(event) => setPolicy((current) => ({ ...current, minimumTokens: Number(event.target.value) }))}
            />
          </Field>
        ) : null}
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-memory`}>Saved memory</FieldLabel>
        <Textarea
          id={`${id}-memory`}
          rows={3}
          maxLength={8000}
          value={memory}
          disabled={disabled}
          onChange={(event) => setMemory(event.target.value)}
          placeholder="Preferences and facts to keep across topics"
        />
        <FieldDescription>
          Memory is stored locally and included in model requests. Starting a new topic keeps it.
        </FieldDescription>
      </Field>
      <SettingsActions align="end">
        <Button
          disabled={disabled || !dirty || !isContextPolicy(policy)}
          onClick={() => void run({ action: "save", policy, memory })}
        >
          Save context settings
        </Button>
      </SettingsActions>
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <FieldTitle>Active context: approximately {view.tokens.toLocaleString()} tokens</FieldTitle>
        <SettingsActions>
          <Button
            variant="outline"
            disabled={disabled || view.tokens === 0}
            onClick={() => void run({ action: "compact" })}
          >
            Summarize context
          </Button>
          <ConfirmAction
            label="Start new topic"
            confirmLabel="Start fresh context"
            variant="outline"
            disabled={disabled}
            description="The next message will start without the current conversation context. Chat history and saved memory remain available."
            onConfirm={() => void run({ action: "new_topic" })}
          />
        </SettingsActions>
        {view.summary ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-dim">View continuity summary</summary>
            <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{view.summary}</p>
          </details>
        ) : null}
      </div>
      <FormStatus
        error={error}
        pending={working ? "Available after the Wisp finishes its current work." : busy ? "Updating context…" : ""}
        notice={notice}
      />
    </FieldGroup>
  );
}
