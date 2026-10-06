import type { ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";

export const SERVER_GUIDE_URL = "https://github.com/gustmrg/wisp-bot/blob/main/docs/remote-server.md";

function Commands({ children }: { children: string }) {
  return (
    <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed">
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
    <details className="mt-3 rounded-xl border border-border px-3 py-2.5 text-[12px] text-dim">
      <summary className="cursor-pointer text-[13px] font-medium text-foreground">How to set up a Wisp server</summary>
      <ol className="mt-3 flex list-decimal flex-col gap-3 pl-5 leading-relaxed">
        <Step title="Build the server package">
          On a computer with a checkout of Wisp, then copy it to a Linux machine with Node.js 22.19 or later:
          <Commands>{`npm ci && npm run package:server
ssh myserver mkdir -p .local/lib
scp -r release/server myserver:.local/lib/wisp`}</Commands>
        </Step>
        <Step title="Install it on the server">
          The master key encrypts the API keys you save on the server. Keep a copy somewhere safe.
          <Commands>{`cd ~/.local/lib/wisp && npm install --omit=dev
mkdir -p ~/.config/wisp ~/.local/bin && chmod 700 ~/.config/wisp
node server/cli.js keygen --output ~/.config/wisp/master.key
install -m 755 deploy/wispctl ~/.local/bin/wispctl`}</Commands>
        </Step>
        <Step title="Keep it running">
          Replace USER in server.env with your user name. Linger keeps Wisps working after you log out.
          <Commands>{`cp deploy/systemd/server.env.example ~/.config/wisp/server.env
chmod 600 ~/.config/wisp/server.env
mkdir -p ~/.config/systemd/user
cp deploy/systemd/wisp.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now wisp
sudo loginctl enable-linger "$USER"`}</Commands>
        </Step>
        <Step title="Connect">
          <p>
            <span className="text-foreground">Over SSH:</span> run <code>ssh myserver</code> once in a terminal so this
            computer trusts its host key, then add the server here with the SSH option. Wisp pairs by running{" "}
            <code>wispctl pair</code> on the server for you.
          </p>
          <p className="mt-1.5">
            <span className="text-foreground">Over HTTPS</span>, also from a phone: expose the server on your tailnet,
            set <code>WISP_PUBLIC_ORIGIN</code> in server.env to the address it shows, and restart the server. Then add
            the address here or open it in a browser, and enter a code from <code>wispctl pair</code>.
          </p>
          <Commands>{`tailscale serve --bg http://127.0.0.1:8787
tailscale serve status`}</Commands>
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
