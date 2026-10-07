import { useState } from "react";
import { ExternalLinkIcon, KeyRoundIcon, ShieldQuestionIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SshPrompt } from "../../../shared/connections";

/**
 * A question from OpenSSH while Wisp checks a server: whether to trust an
 * unknown host key, or a password to sign in once. Shown by whoever started
 * the check, so it appears once.
 */
export function SshPromptCard({ prompt }: { prompt: SshPrompt }) {
  // A new question starts empty, never with the answer to the last one.
  return <PromptCard key={prompt.id} prompt={prompt} />;
}

function PromptCard({ prompt }: { prompt: SshPrompt }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function answer(value: string | undefined) {
    setBusy(true);
    try {
      await window.wisp.answerSshPrompt(value === undefined ? { id: prompt.id } : { id: prompt.id, answer: value });
    } finally {
      setBusy(false);
    }
  }

  const frame =
    "my-3 flex flex-col gap-2.5 rounded-[10px] border border-border bg-muted/40 p-3 text-xs leading-relaxed";

  if (prompt.kind === "hostKey") {
    // OpenSSH names the host and its address: "pi (100.64.0.1)", or "[pi]:2222 ([pi]:2222)" twice over.
    const [, host = prompt.host, address] = /^(.*?)(?: \((.*)\))?$/.exec(prompt.host) ?? [];
    return (
      <div role="group" aria-label={`Trust ${host}?`} className={frame}>
        <p className="m-0 flex items-center gap-2 text-sm font-medium text-foreground">
          <ShieldQuestionIcon className="size-4 text-dim" aria-hidden="true" />
          Is this {host}?
        </p>
        <p className="m-0 text-dim">
          This computer has not connected to {host}
          {address && address !== host ? ` (${address})` : ""} before. Trust it only if its{" "}
          {prompt.keyType ? `${prompt.keyType} ` : ""}key fingerprint is:
        </p>
        {prompt.fingerprint ? (
          <code className="block break-all rounded-lg bg-muted px-2.5 py-2 font-mono text-xs">
            {prompt.fingerprint}
          </code>
        ) : (
          <pre className="m-0 whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-2 font-mono text-xs">
            {prompt.message}
          </pre>
        )}
        <p className="m-0 text-dim">
          To compare, run <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on that machine. Wisp remembers
          the key in your known_hosts, as ssh does.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => void answer("yes")}>
            Trust and continue
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void answer(undefined)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (prompt.kind === "browser") {
    // The page comes from the server's SSH banner: shown in full, and opened only when the person asks.
    return (
      <div role="group" aria-label="Approve in the browser" className={frame}>
        <p className="m-0 text-foreground">{prompt.message}</p>
        <p className="m-0 break-all text-dim">{prompt.url}</p>
        <div className="flex flex-wrap gap-2">
          <a href={prompt.url} target="_blank" rel="noreferrer" className={buttonVariants()}>
            Open the approval page
            <ExternalLinkIcon aria-hidden="true" />
          </a>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void answer(undefined)}>
            Cancel
          </Button>
        </div>
        <p className="m-0 text-dim">Wisp goes on by itself once you approve.</p>
      </div>
    );
  }

  if (prompt.kind === "confirm") {
    return (
      <div role="group" aria-label="SSH confirmation" className={frame}>
        <p className="m-0 whitespace-pre-wrap text-foreground">{prompt.message}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy} onClick={() => void answer("yes")}>
            Allow
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void answer(undefined)}>
            Deny
          </Button>
        </div>
      </div>
    );
  }

  // Not a <form>: the card can appear inside the connection form.
  return (
    <div role="group" aria-label="SSH sign-in" className={frame}>
      <label className="flex flex-col gap-[5px]">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <KeyRoundIcon className="size-4 text-dim" aria-hidden="true" />
          {prompt.message.replace(/:\s*$/, "")}
        </span>
        <Input
          type="password"
          autoComplete="off"
          autoFocus
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (!busy) void answer(secret);
          }}
        />
      </label>
      <p className="m-0 text-dim">Wisp passes it to OpenSSH and does not keep it.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => void answer(secret)}>
          Continue
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void answer(undefined)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
