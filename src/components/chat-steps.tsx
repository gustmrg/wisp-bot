import { useState } from "react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

import type { ToolStepDetail } from "../../shared/contracts";
import { describeMcpAlias, getToolMetadata } from "../../shared/tool-catalog";
import type { ToolActivityView } from "@/lib/conversation-stream";

/** How many of the turn's steps show while the Wisp works; older ones fold into a count. */
const VISIBLE_STEPS = 4;

function stepLabel(toolName: string): string {
  return getToolMetadata(toolName)?.label ?? describeMcpAlias(toolName)?.label ?? toolName;
}

/** What a step worked on: its path, search or page, or for a command what it was for. */
function stepTarget(detail: ToolStepDetail | undefined): string | undefined {
  return detail?.target ?? detail?.purpose ?? detail?.commandOutline;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = durationMs / 1_000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** How a command ended, such as `exit 1 · 2.4 s`. */
function stepResult(detail: ToolStepDetail | undefined): string | undefined {
  const result = detail?.commandResult;
  if (!result) return undefined;
  const parts = [
    result.stopped === "timeout" ? "timed out" : result.stopped === "aborted" ? "stopped" : undefined,
    result.exitCode === undefined ? undefined : `exit ${result.exitCode}`,
    result.durationMs === undefined ? undefined : formatDuration(result.durationMs),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function StepRow({ step }: { step: ToolActivityView }) {
  const target = stepTarget(step.detail);
  const result = stepResult(step.detail);
  // A command's purpose shows; the programs it ran are a hover away.
  const outline = step.detail?.purpose && step.detail.commandOutline ? step.detail.commandOutline : undefined;
  const phase = step.phase === "completed" ? (step.isError ? "failed" : "completed") : "running";
  const line = (
    <>
      {step.phase !== "completed" ? (
        <span className="chat-step-spinner" aria-hidden="true" />
      ) : step.isError ? (
        <XIcon aria-hidden="true" />
      ) : (
        <CheckIcon aria-hidden="true" />
      )}
      <span className="chat-step-label">{stepLabel(step.toolName)}</span>
      {target ? (
        <span
          className="chat-step-target"
          // A path or search is code; a command's purpose is prose.
          data-prose={!step.detail?.target && step.detail?.purpose ? true : undefined}
          title={outline ?? target}
        >
          {target}
        </span>
      ) : null}
      {result ? <span className="chat-step-result">{result}</span> : null}
      {step.phase !== "completed" ? (
        <span className="sr-only">, running</span>
      ) : step.isError ? (
        <span className="sr-only">, failed</span>
      ) : null}
    </>
  );
  const command = step.detail?.command;
  const output = step.detail?.output;
  if (!command && !output) {
    return (
      <li className="chat-step" data-phase={phase}>
        {line}
      </li>
    );
  }
  // Verbose steps (ADR 029) open to the command as written and the end of its output.
  return (
    <li className="chat-step chat-step-verbose" data-phase={phase}>
      <details>
        <summary>{line}</summary>
        <pre className="chat-step-console">
          {command ? <span className="chat-step-command">{`$ ${command}`}</span> : null}
          {command && output ? "\n" : null}
          {output}
        </pre>
      </details>
    </li>
  );
}

interface ChatStepsProps {
  steps: ReadonlyArray<ToolActivityView>;
  /** The Wisp, or the circle, the steps belong to. */
  name: string;
  /** While the turn runs, its newest steps show; after it, they fold under a count. */
  working: boolean;
}

/** The tools the Wisp used in its latest turn, with what each worked on. */
export function ChatSteps({ steps, name, working }: ChatStepsProps) {
  const [expanded, setExpanded] = useState(false);
  if (!steps.length) return null;
  const label = `What ${name} has done so far`;
  if (!working && !expanded) {
    return (
      <button type="button" className="chat-steps-toggle" aria-expanded={false} onClick={() => setExpanded(true)}>
        <ChevronDownIcon aria-hidden="true" />
        {steps.length === 1 ? "1 step" : `${steps.length} steps`}
      </button>
    );
  }
  const hidden = expanded ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
  return (
    <div className="chat-steps-group">
      {!working ? (
        <button type="button" className="chat-steps-toggle" aria-expanded onClick={() => setExpanded(false)}>
          <ChevronDownIcon aria-hidden="true" />
          {steps.length === 1 ? "1 step" : `${steps.length} steps`}
        </button>
      ) : null}
      <ol className="chat-steps" aria-label={label}>
        {hidden ? (
          <li className="chat-step chat-step-more">
            <button type="button" onClick={() => setExpanded(true)}>{`+${hidden} earlier`}</button>
          </li>
        ) : null}
        {steps.slice(hidden).map((step) => (
          <StepRow key={step.toolCallId} step={step} />
        ))}
      </ol>
    </div>
  );
}
