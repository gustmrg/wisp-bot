import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SshPromptView } from "../../../shared/connections";

/**
 * Asks what OpenSSH needs to know while connecting: to trust a host key the
 * first time, a password, or the passphrase of a key. Closing it declines.
 */
export function SshPromptDialog({ prompt }: { prompt: SshPromptView }) {
  // A new question starts empty.
  return <SshPromptForm key={prompt.id} prompt={prompt} />;
}

function SshPromptForm({ prompt }: { prompt: SshPromptView }) {
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState(false);
  const asksText = prompt.kind !== "host_key" && prompt.kind !== "confirm";

  function send(value?: string) {
    if (sent) return;
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
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : send())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
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
          <DialogFooter>
            <Button type="button" variant="outline" disabled={sent} onClick={() => send()}>
              Cancel
            </Button>
            <Button type="submit" disabled={sent || (asksText && answer.length === 0)}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
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
