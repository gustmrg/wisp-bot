import { useEffect, useId, useState } from "react";
import {
  DEFAULT_CONTEXT_POLICY,
  isContextPolicy,
  type ContextCommand,
  type ContextPolicy,
  type ContextView,
} from "../../shared/context-policy";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const modes = [
  { value: "idle", label: "After inactivity" },
  { value: "daily", label: "Daily" },
  { value: "both", label: "Inactivity or daily" },
  { value: "none", label: "Manual only" },
];

export function WispContextSettings({ conversationId }: { conversationId: string }) {
  const [visited, setVisited] = useState(false);
  return (
    <Accordion
      className="mt-4"
      onValueChange={(values) => {
        if (values.length) setVisited(true);
      }}
    >
      <AccordionItem value="context">
        <AccordionTrigger>Context & memory</AccordionTrigger>
        <AccordionContent keepMounted>
          {visited ? <ContextForm key={conversationId} conversationId={conversationId} /> : null}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function ContextForm({ conversationId }: { conversationId: string }) {
  const id = useId();
  const [view, setView] = useState<ContextView | null>(null);
  const [policy, setPolicy] = useState<ContextPolicy>({ ...DEFAULT_CONTEXT_POLICY });
  const [memory, setMemory] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmNew, setConfirmNew] = useState(false);
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
      setConfirmNew(false);
    } catch {
      setError("Could not update context. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return (
      <div className="space-y-2 text-xs">
        <p role={error ? "alert" : "status"}>{error || "Loading context…"}</p>
        {error ? (
          <Button variant="outline" onClick={() => setLoadRequest({ conversationId })}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  const disabled = busy || working;
  const dirty = JSON.stringify(policy) !== JSON.stringify(view.policy) || memory !== view.memory;
  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        Your chat history stays visible. Summaries retain goals, decisions and pending work; the Wisp can search older
        messages when needed.
      </p>
      <label htmlFor={`${id}-mode`}>Renew context</label>
      <Select
        items={modes}
        value={policy.mode}
        disabled={disabled}
        onValueChange={(value) => {
          if (value) setPolicy((current) => ({ ...current, mode: value as ContextPolicy["mode"] }));
        }}
      >
        <SelectTrigger id={`${id}-mode`} className="w-full">
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
      {policy.mode === "idle" || policy.mode === "both" ? (
        <label className="block">
          Inactivity (hours)
          <Input
            type="number"
            min={1}
            max={720}
            value={policy.idleHours}
            disabled={disabled}
            onChange={(event) => setPolicy((current) => ({ ...current, idleHours: Number(event.target.value) }))}
          />
        </label>
      ) : null}
      {policy.mode === "daily" || policy.mode === "both" ? (
        <label className="block">
          Daily hour (local time, 0–23)
          <Input
            type="number"
            min={0}
            max={23}
            value={policy.dailyHour}
            disabled={disabled}
            onChange={(event) => setPolicy((current) => ({ ...current, dailyHour: Number(event.target.value) }))}
          />
        </label>
      ) : null}
      {policy.mode !== "none" ? (
        <>
          <label className="block">
            Minimum context tokens
            <Input
              type="number"
              min={1000}
              max={200000}
              step={1000}
              value={policy.minimumTokens}
              disabled={disabled}
              onChange={(event) => setPolicy((current) => ({ ...current, minimumTokens: Number(event.target.value) }))}
            />
          </label>
          <p className="text-muted-foreground">
            Checked when your next message arrives. Small conversations are kept intact. Summaries use model tokens.
            Automatic compression near the model limit remains enabled.
          </p>
        </>
      ) : null}
      <label className="block">
        Saved memory
        <Textarea
          rows={3}
          maxLength={8000}
          value={memory}
          disabled={disabled}
          onChange={(event) => setMemory(event.target.value)}
          placeholder="Preferences and facts to keep across topics"
        />
      </label>
      <p className="text-muted-foreground">
        Memory is stored locally and included in model requests. Starting a new topic keeps it.
      </p>
      <Button
        className="w-full"
        disabled={disabled || !dirty || !isContextPolicy(policy)}
        onClick={() => void run({ action: "save", policy, memory })}
      >
        Save context settings
      </Button>
      <div className="border-t border-border pt-3 space-y-2">
        <p>Active context: approximately {view.tokens.toLocaleString()} tokens</p>
        <Button
          className="w-full"
          variant="outline"
          disabled={disabled || view.tokens === 0}
          onClick={() => void run({ action: "compact" })}
        >
          Summarize context
        </Button>
        <Button className="w-full" variant="outline" disabled={disabled} onClick={() => setConfirmNew(true)}>
          Start new topic
        </Button>
        {confirmNew ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p>
              The next message will start without the current conversation context. Chat history and saved memory remain
              available.
            </p>
            <Button disabled={disabled} onClick={() => void run({ action: "new_topic" })}>
              Start fresh context
            </Button>
            <Button variant="ghost" onClick={() => setConfirmNew(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {view.summary ? (
          <details>
            <summary className="cursor-pointer">View continuity summary</summary>
            <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{view.summary}</p>
          </details>
        ) : null}
      </div>
      {working ? <p role="status">Available after the Wisp finishes its current work.</p> : null}
      {busy ? <p role="status">Updating context…</p> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
