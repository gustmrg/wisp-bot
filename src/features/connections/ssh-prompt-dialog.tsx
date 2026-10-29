import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SshPromptView } from "../../../shared/connections";
import { CONNECTION_BACKDROP } from "./connection-steps";

/**
 * How long an answered question stays on screen. OpenSSH asks the next one,
 * such as a password after the host key, a moment after the answer, so it
 * replaces the question in place instead of the question closing and another
 * one opening.
 */
export const SSH_PROMPT_HOLD_MS = 400;

/** OpenSSH's current question, or the one just answered while Wisp waits to see whether another follows. */
export interface HeldSshPrompt {
  prompt: SshPromptView;
  answered: boolean;
}

/** Keeps the last question for `SSH_PROMPT_HOLD_MS` after OpenSSH stops asking it. */
export function useHeldSshPrompt(prompt: SshPromptView | undefined): HeldSshPrompt | undefined {
  const [held, setHeld] = useState<HeldSshPrompt>();
  if (prompt && (held?.prompt !== prompt || held.answered)) setHeld({ prompt, answered: false });
  else if (!prompt && held && !held.answered) setHeld({ prompt: held.prompt, answered: true });
  useEffect(() => {
    if (!held?.answered) return;
    const timer = setTimeout(() => setHeld(undefined), SSH_PROMPT_HOLD_MS);
    return () => clearTimeout(timer);
  }, [held]);
  return held;
}

/**
 * Asks OpenSSH's questions over the app, as when reconnecting or setting up
 * a server from Settings. One dialog stays open across the questions of a
 * sign-in and changes its content. Closing it declines.
 */
export function SshPromptDialog({ question }: { question: HeldSshPrompt | undefined }) {
  // What the dialog shows, kept while it animates closed.
  const [shown, setShown] = useState<HeldSshPrompt>();
  const [dismissed, setDismissed] = useState<string>();
  // An answered question opens nothing: it was asked elsewhere, such as on the connection screen.
  const open =
    question !== undefined &&
    question.prompt.id !== dismissed &&
    (!question.answered || shown?.prompt.id === question.prompt.id);
  if (open && shown !== question) setShown(question);
  const content = open ? question : shown;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || !content) return;
        setDismissed(content.prompt.id);
        if (!content.answered) decline(content.prompt);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setShown(undefined);
      }}
    >
      {content ? (
        <DialogContent backdropClassName={CONNECTION_BACKDROP}>
          <SshPromptForm key={content.prompt.id} question={content} layout="dialog" />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * One question from OpenSSH and the field to answer it. In a dialog it has
 * its own header and a Cancel button; in the connection screen's card the
 * card's own Cancel stops connecting, which declines the question.
 */
export function SshPromptForm({ question, layout }: { question: HeldSshPrompt; layout: "dialog" | "card" }) {
  const { prompt, answered } = question;
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState(false);
  const asksText = prompt.kind !== "host_key" && prompt.kind !== "confirm";
  const waiting = sent || answered;

  function send(value?: string) {
    if (waiting) return;
    setSent(true);
    void window.wisp
      .answerSshPrompt({ id: prompt.id, ...(value === undefined ? {} : { answer: value }) })
      .then((result) => {
        if (!result.ok) setSent(false);
      })
      .catch(() => setSent(false));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    send(prompt.kind === "host_key" ? "yes" : prompt.kind === "confirm" ? "" : answer);
  }

  const { title, description, action } = copy(prompt);
  const submitButton = (
    <Button type="submit" disabled={waiting || (asksText && answer.length === 0)}>
      {waiting ? "Checking…" : action}
    </Button>
  );
  const fields = (
    <>
      {prompt.kind === "password" && prompt.keys?.length ? (
        <ul aria-label="Keys to add" className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-xs text-dim">
          {prompt.keys.map((key) => (
            <li key={key} className="break-all">
              {key}
            </li>
          ))}
        </ul>
      ) : null}
      {asksText ? (
        <Field>
          <FieldLabel htmlFor="ssh-prompt-answer">{prompt.message || "Answer"}</FieldLabel>
          <Input
            id="ssh-prompt-answer"
            type="password"
            autoComplete="off"
            autoFocus
            disabled={waiting}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          {prompt.retry ? (
            <FieldDescription role="alert" className="text-destructive">
              That was not accepted. Try again.
            </FieldDescription>
          ) : null}
        </Field>
      ) : (
        <pre className="m-0 whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
          {prompt.message}
        </pre>
      )}
    </>
  );

  if (layout === "card") {
    return (
      <form
        className="mt-4 flex animate-tab-forward flex-col gap-3 rounded-[10px] border border-border bg-muted/40 p-4"
        aria-labelledby="ssh-prompt-title"
        onSubmit={submit}
      >
        <div>
          <h2 id="ssh-prompt-title" className="m-0 text-base font-semibold">
            {title}
          </h2>
          <p className="mt-1 mb-0 text-sm leading-relaxed text-dim">{description}</p>
        </div>
        {fields}
        <div className="flex justify-end">{submitButton}</div>
      </form>
    );
  }
  return (
    <div className="grid animate-tab-forward gap-5">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {fields}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={waiting} />}>Cancel</DialogClose>
          {submitButton}
        </DialogFooter>
      </form>
    </div>
  );
}

/** Declines a question without answering it, as closing its dialog does. */
function decline(prompt: SshPromptView): void {
  void window.wisp.answerSshPrompt({ id: prompt.id }).catch(() => undefined);
}

function copy(prompt: SshPromptView): { title: string; description: string; action: string } {
  switch (prompt.kind) {
    case "host_key":
      return {
        title: `Trust ${prompt.host}?`,
        description: `This computer has not connected to ${prompt.host} over SSH before. Trust it only if the fingerprint matches the server's key.`,
        action: "Trust and connect",
      };
    case "password":
      return {
        title: `Sign in to ${prompt.host}`,
        description:
          "Wisp uses this password once, to add this computer's SSH key to the server. After that it connects with the key, and the password is not kept.",
        action: "Add key and connect",
      };
    case "passphrase":
      return {
        title: "Unlock your SSH key",
        description: "To stop being asked each time Wisp connects, add the key to ssh-agent with `ssh-add`.",
        action: "Unlock",
      };
    case "confirm":
      return {
        title: "Allow this SSH key?",
        description: `OpenSSH asks before using it for ${prompt.host}.`,
        action: "Allow",
      };
    default:
      return { title: `${prompt.host} asks`, description: "The server needs an answer to continue.", action: "Send" };
  }
}
