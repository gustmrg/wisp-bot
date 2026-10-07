import type { ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";

export const SERVER_GUIDE_URL = "https://github.com/gustmrg/wisp-bot/blob/main/docs/remote-server.md";

function Commands({ children }: { children: string }) {
  return (
    <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="pl-1">
      <span className="font-medium text-foreground">{title}</span>
      <div className="mt-1">{children}</div>
    </li>
  );
}

/**
 * The short version of docs/remote-server.md: what to run on a Linux machine
 * so this app can connect to it. Collapsed until asked for.
 */
export function ServerSetupGuide() {
  return (
    <details className="mt-3 rounded-xl border border-border px-3 py-2.5 text-sm text-dim">
      <summary className="cursor-pointer text-base font-medium text-foreground">How to set up a Wisp server</summary>
      <ol className="mt-3 flex list-decimal flex-col gap-3 pl-5 leading-relaxed">
        <Step title="Install it on a Linux machine">
          It needs Node.js 22.19 or later and systemd. One command installs the server, creates its master key, and
          starts it as a service. Keep a copy of the key it reports.
          <Commands>{`npx @gustmrg/wisp-server setup`}</Commands>
          <p className="mt-1.5">
            Or skip the terminal: run <code>ssh myserver</code> once so this computer trusts its host key, add the
            machine here with the SSH option, and save. Then open it with its settings button and choose{" "}
            <span className="text-foreground">Install or update the server</span>. Node.js and npm must be in the PATH
            of non-interactive SSH commands, which a Node.js from nvm or fnm usually is not.
          </p>
        </Step>
        <Step title="Connect">
          <p>
            <span className="text-foreground">Over SSH:</span> run <code>ssh myserver</code> once in a terminal so this
            computer trusts its host key, if you have not yet, then add the server here with the SSH option. Wisp pairs
            by running <code>wispctl pair</code> on the server for you.
          </p>
          <p className="mt-1.5">
            <span className="text-foreground">Over HTTPS</span>, also from a phone: expose the server on your tailnet,
            then tell the server its address. Add the address here or open it in a browser, and enter a code from{" "}
            <code>wispctl pair</code>.
          </p>
          <Commands>{`tailscale serve --bg http://127.0.0.1:8787
wispctl setup --public-origin https://machine.tailnet-name.ts.net`}</Commands>
        </Step>
      </ol>
      <a
        href={SERVER_GUIDE_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-3 mb-0.5 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
      >
        Full guide, with Docker and backups
        <ExternalLinkIcon className="size-3" aria-hidden="true" />
      </a>
    </details>
  );
}
