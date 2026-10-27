import { getToolMetadata } from "../shared/tool-catalog.js";
import { resultText, type ToolCallResult } from "./turn-items.js";

/** Failures in a row of one tool with the same error after which a Wisp's turn stops (ADR 033). */
export const MAX_REPEATED_TOOL_FAILURES = 3;
const MAX_ERROR_CHARACTERS = 300;

/** A tool that kept failing with the same error. */
export interface RepeatedToolFailure {
  toolName: string;
  error: string;
}

/**
 * Counts a turn's tool results that fail in a row with the same tool and the
 * same error. Any other result starts over: a success, another tool, or
 * another error, which means the model is trying something different.
 */
export class ToolLoopGuard {
  private last: RepeatedToolFailure | undefined;
  private count = 0;

  reset(): void {
    this.last = undefined;
    this.count = 0;
  }

  /** Records a tool's result; returns the failure once it has repeated `MAX_REPEATED_TOOL_FAILURES` times. */
  record(event: { toolName: string; isError: boolean; result?: unknown }): RepeatedToolFailure | undefined {
    // A call that ended without a result, as when a turn is stopped, says nothing about the tool.
    if (event.isError && event.result === undefined) return undefined;
    if (!event.isError) {
      this.reset();
      return undefined;
    }
    const error = errorText(event.result);
    if (this.last?.toolName === event.toolName && this.last.error === error) this.count += 1;
    else {
      this.last = { toolName: event.toolName, error };
      this.count = 1;
    }
    return this.count >= MAX_REPEATED_TOOL_FAILURES ? this.last : undefined;
  }
}

/** What the person reads when a turn stopped on a repeated failure. */
export function repeatedFailureMessage(failure: RepeatedToolFailure): string {
  const label = getToolMetadata(failure.toolName)?.label ?? failure.toolName;
  const stopped = `"${label}" failed ${MAX_REPEATED_TOOL_FAILURES} times in a row with the same error, so the Wisp stopped instead of trying again.`;
  return failure.error ? `${stopped} The error: ${failure.error}` : stopped;
}

function errorText(result: unknown): string {
  const text = resultText(result as ToolCallResult)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  return text.length > MAX_ERROR_CHARACTERS ? `${text.slice(0, MAX_ERROR_CHARACTERS)}…` : text;
}
