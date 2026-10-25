import { useState } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleStopIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  type LucideIcon,
  MonitorIcon,
  SearchIcon,
  ServerCogIcon,
  SquareTerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { TurnItem } from "../../shared/contracts";
import { describeMcpAlias, getToolMetadata } from "../../shared/tool-catalog";

/** The latest state each background process was seen in, by its ID, across the loaded transcript. */
export type ProcessStates = ReadonlyMap<string, string>;

/** Collects the latest known state of each background process from the steps in `messages`, oldest first. */
export function processStatesOf(
  messages: ReadonlyArray<{ type: string; steps?: ReadonlyArray<TurnItem> }>,
): ProcessStates {
  const states = new Map<string, string>();
  for (const message of messages) {
    for (const step of message.steps ?? []) {
      if (step.type === "background_process" && step.processId && step.state) states.set(step.processId, step.state);
    }
  }
  return states;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return text.includes("\n") ? `${line} …` : line;
}

function toolLabel(toolName: string): string {
  return getToolMetadata(toolName)?.label ?? describeMcpAlias(toolName)?.label ?? toolName;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** How many kinds of work the folded line names; the rest are counted. */
const SUMMARY_PARTS = 2;

/**
 * What a group of steps did, in a few words, naming what changed the
 * workspace first: "Edited 2 files, ran 1 command +2 more".
 */
export function summarizeSteps(steps: ReadonlyArray<TurnItem>): string {
  const read = new Set<string>();
  const edited = new Set<string>();
  let commands = 0;
  let searches = 0;
  let webSearches = 0;
  let pages = 0;
  let processes = 0;
  let browser = false;
  const tools: string[] = [];
  for (const step of steps) {
    switch (step.type) {
      case "file_read":
        for (const path of step.paths) read.add(path);
        break;
      case "file_change":
        edited.add(step.path);
        break;
      case "command_execution":
        commands += 1;
        break;
      case "file_search":
        searches += 1;
        break;
      case "web_search":
        webSearches += 1;
        break;
      case "web_read":
        pages += 1;
        break;
      case "background_process":
        processes += 1;
        break;
      case "browser":
        browser = true;
        break;
      case "tool": {
        const label = toolLabel(step.toolName);
        if (!tools.includes(label)) tools.push(label);
        break;
      }
    }
  }
  const parts = [
    edited.size ? `edited ${plural(edited.size, "file", "files")}` : "",
    commands ? `ran ${plural(commands, "command", "commands")}` : "",
    processes ? `managed ${plural(processes, "background process", "background processes")}` : "",
    read.size ? `read ${plural(read.size, "file", "files")}` : "",
    searches ? `searched the workspace${searches > 1 ? ` ${searches} times` : ""}` : "",
    webSearches ? `searched the web${webSearches > 1 ? ` ${webSearches} times` : ""}` : "",
    pages ? `read ${plural(pages, "web page", "web pages")}` : "",
    browser ? "used the browser" : "",
    ...tools.map((label) => label.charAt(0).toLowerCase() + label.slice(1)),
  ].filter(Boolean);
  const more = parts.length - SUMMARY_PARTS;
  const text = parts.slice(0, SUMMARY_PARTS).join(", ") || plural(steps.length, "step", "steps");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${more > 0 ? ` +${more} more` : ""}`;
}

/**
 * Whether a group of steps ended in failure: its last step or its last
 * command failed. A failure the Wisp went on to fix, such as a test that
 * passed on the next run, does not mark the group.
 */
export function stepsFailed(steps: ReadonlyArray<TurnItem>): boolean {
  const reversed = [...steps].reverse();
  const lastCommand = reversed.find(({ type }) => type === "command_execution");
  return reversed[0]?.status === "failed" || lastCommand?.status === "failed";
}

const BROWSER_ACTIONS: Readonly<Record<string, [string, string]>> = {
  open: ["Opening", "Opened"],
  snapshot: ["Reading the page", "Read the page"],
  click: ["Clicking", "Clicked"],
  type: ["Typing into a field", "Typed into a field"],
  select: ["Choosing an option", "Chose an option"],
  back: ["Going back", "Went back"],
  wait: ["Waiting for the page", "Waited for the page"],
  screenshot: ["Taking a screenshot", "Took a screenshot"],
  close: ["Closing the browser", "Closed the browser"],
};

interface StepView {
  icon: LucideIcon;
  /** The action, such as "Ran" or "Edited". */
  verb: string;
  /** What it acted on, shown in a code font when it is code. */
  subject?: string;
  code?: boolean;
  /** Short facts after the subject, such as `+3 −1` or `exit 1`. */
  facts?: ReadonlyArray<{ text: string; tone?: "added" | "removed" | "error" }>;
  detail?: string;
  output?: { text: string; truncated: boolean };
}

/** How a step reads in the conversation. Diffs are never shown, only their counts. */
export function viewOfStep(step: TurnItem, processStates?: ProcessStates): StepView {
  const running = step.status === "running";
  const verb = (doing: string, done: string) => (running ? doing : done);
  switch (step.type) {
    case "command_execution":
      return {
        icon: SquareTerminalIcon,
        verb: verb("Running", "Ran"),
        subject: firstLine(step.command),
        code: true,
        facts: step.exitCode ? [{ text: `exit ${step.exitCode}`, tone: "error" }] : [],
        ...(step.purpose ? { detail: step.purpose } : {}),
        ...(step.output ? { output: { text: step.output, truncated: Boolean(step.outputTruncated) } } : {}),
      };
    case "background_process": {
      const id = step.processId ? `#${step.processId}` : undefined;
      const state = (step.processId && processStates?.get(step.processId)) || step.state;
      const facts = state && step.action !== "list" ? [{ text: state }] : [];
      const output = step.output ? { output: { text: step.output, truncated: Boolean(step.outputTruncated) } } : {};
      switch (step.action) {
        case "start":
          return {
            icon: ServerCogIcon,
            verb: verb("Starting", "Started"),
            subject: firstLine(step.command ?? ""),
            code: true,
            facts,
            ...(id ? { detail: `Background process ${id}` } : {}),
            ...output,
          };
        case "list":
          return { icon: ServerCogIcon, verb: verb("Listing", "Listed"), subject: "background processes", ...output };
        case "log":
          return {
            icon: ServerCogIcon,
            verb: verb("Reading", "Read"),
            subject: `the log of ${id ?? "a process"}`,
            ...output,
          };
        case "wait":
          return {
            icon: ServerCogIcon,
            verb: verb("Waiting for", "Waited for"),
            subject: id ?? "a process",
            facts,
            ...output,
          };
        case "kill":
          return { icon: ServerCogIcon, verb: verb("Stopping", "Stopped"), subject: id ?? "a process" };
      }
      break;
    }
    case "file_change":
      return {
        icon: FilePenIcon,
        verb: step.toolName === "write" ? verb("Writing", "Wrote") : verb("Editing", "Edited"),
        subject: step.path,
        code: true,
        facts: [
          ...(step.additions ? [{ text: `+${step.additions}`, tone: "added" as const }] : []),
          ...(step.deletions ? [{ text: `−${step.deletions}`, tone: "removed" as const }] : []),
        ],
      };
    case "file_read": {
      const [first = ".", ...rest] = step.paths;
      return {
        icon: FileTextIcon,
        verb: step.toolName === "ls" ? verb("Listing", "Listed") : verb("Reading", "Read"),
        subject: first,
        code: true,
        facts: rest.length ? [{ text: `+${rest.length} more` }] : [],
      };
    }
    case "file_search":
      return {
        icon: SearchIcon,
        verb: verb("Searching for", "Searched for"),
        subject: step.pattern,
        code: true,
        ...(step.path ? { detail: `in ${step.path}` } : {}),
      };
    case "web_search":
      return { icon: SearchIcon, verb: verb("Searching the web for", "Searched the web for"), subject: step.query };
    case "web_read":
      return { icon: GlobeIcon, verb: verb("Reading", "Read"), subject: hostOf(step.url), detail: step.url };
    case "browser": {
      const [doing, done] = BROWSER_ACTIONS[step.action] ?? ["Using the browser", "Used the browser"];
      return {
        icon: MonitorIcon,
        verb: verb(doing, done),
        ...(step.url ? { subject: hostOf(step.url) } : {}),
        ...(step.pageTitle ? { detail: step.pageTitle } : {}),
      };
    }
    case "tool":
      break;
  }
  return { icon: WrenchIcon, verb: toolLabel(step.toolName) };
}

function runningSummary(view: StepView): string {
  return `${view.subject ? `${view.verb} ${view.subject}` : view.verb}…`;
}

function StatusIcon({ status }: { status: TurnItem["status"] }) {
  if (status === "running") return <span className="chat-step-spinner" aria-hidden="true" />;
  if (status === "completed") return <CheckIcon aria-hidden="true" className="message-step-status" />;
  if (status === "cancelled") return <CircleStopIcon aria-hidden="true" className="message-step-status" />;
  return <XIcon aria-hidden="true" className="message-step-status" />;
}

const STATUS_TEXT: Readonly<Record<TurnItem["status"], string>> = {
  running: ", running",
  completed: "",
  failed: ", failed",
  cancelled: ", stopped",
};

function StepRow({ step, processStates }: { step: TurnItem; processStates?: ProcessStates }) {
  const [showOutput, setShowOutput] = useState(false);
  const view = viewOfStep(step, processStates);
  const Icon = view.icon;
  return (
    <li className="message-step" data-status={step.status}>
      <div className="message-step-line">
        <StatusIcon status={step.status} />
        <Icon aria-hidden="true" className="message-step-icon" />
        <span className="message-step-text">
          {view.verb}
          {view.subject ? (
            <>
              {" "}
              {view.code ? <code>{view.subject}</code> : <span className="message-step-subject">{view.subject}</span>}
            </>
          ) : null}
          {view.facts?.map((fact) => (
            <span key={fact.text} className="message-step-fact" data-tone={fact.tone}>
              {fact.text}
            </span>
          ))}
          <span className="sr-only">{STATUS_TEXT[step.status]}</span>
        </span>
        {view.output ? (
          <button
            type="button"
            className="message-step-toggle"
            aria-expanded={showOutput}
            onClick={() => setShowOutput((value) => !value)}
          >
            {showOutput ? "Hide output" : "Output"}
          </button>
        ) : null}
      </div>
      {view.detail ? <p className="message-step-detail">{view.detail}</p> : null}
      {view.output && showOutput ? (
        <pre className="message-step-output" aria-label="Output">
          {view.output.truncated ? "…\n" : ""}
          {view.output.text}
        </pre>
      ) : null}
    </li>
  );
}

/**
 * The steps a reply took between two of its parts, folded into one line that
 * says what they did; opened, one line per step.
 */
export function MessageSteps({
  steps,
  processStates,
}: {
  steps: ReadonlyArray<TurnItem>;
  processStates?: ProcessStates;
}) {
  const [open, setOpen] = useState(false);
  const current = [...steps].reverse().find(({ status }) => status === "running");
  const failed = stepsFailed(steps);
  const failures = steps.filter(({ status }) => status === "failed").length;
  const summary = current ? runningSummary(viewOfStep(current, processStates)) : summarizeSteps(steps);
  return (
    <section
      className="message-steps"
      data-open={open || undefined}
      data-status={current ? "running" : failed ? "failed" : "completed"}
      aria-label="Steps"
    >
      <button
        type="button"
        className="message-steps-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {current ? (
          <span className="chat-step-spinner" aria-hidden="true" />
        ) : (
          <StatusIcon status={failed ? "failed" : "completed"} />
        )}
        <span className="message-steps-label">{summary}</span>
        <span className="message-steps-count">
          <span className="message-steps-total">{plural(steps.length, "step", "steps")}</span>
          {failures ? <span className="message-steps-failures">{`${failures} failed`}</span> : null}
        </span>
        <ChevronRightIcon aria-hidden="true" className="message-steps-chevron" />
      </button>
      {open ? (
        <ol className="message-steps-list">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} processStates={processStates} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
