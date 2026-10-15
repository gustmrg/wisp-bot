import type { TailscaleRunner } from "../../electron/local-server/tailscale.js";

/**
 * The Tailscale CLI in memory, answering as version 1.104 does, so tests never
 * run, or change, the real Tailscale of the computer they run on.
 */
export class FakeTailscale {
  installed = true;
  running = true;
  httpsEnabled = true;
  /** Serving waits for the person to consent in a browser, as on a tailnet that never used Serve. */
  needsConsent = false;
  /** Changing serve settings is refused, as on Linux without `tailscale set --operator`. */
  denied = false;
  readonly host = "laptop.tailnet.ts.net";
  /** What `https://<host>/` forwards to. */
  handler: string | undefined;
  readonly calls: string[][] = [];

  readonly locate = (): string | undefined => (this.installed ? "/usr/bin/tailscale" : undefined);

  /** Someone ran `tailscale serve --bg <port>` by hand. */
  serveByHand(port: number): void {
    this.handler = `http://127.0.0.1:${port}`;
  }

  readonly run: TailscaleRunner = async (_executable, args) => {
    this.calls.push([...args]);
    const command = args.join(" ");
    if (command === "status --json") {
      if (!this.running) return { code: 1, output: "Tailscale is stopped.\n" };
      return {
        code: 0,
        output: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: `${this.host}.`, HostName: "laptop" },
          CertDomains: this.httpsEnabled ? [this.host] : null,
        }),
      };
    }
    if (command === "serve status --json") {
      if (!this.handler) return { code: 0, output: "{}\n" };
      return {
        code: 0,
        output: JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: { [`${this.host}:443`]: { Handlers: { "/": { Proxy: this.handler } } } },
        }),
      };
    }
    if (args[0] === "serve" && this.denied) {
      return { code: 1, output: "Access denied: serve config denied\n" };
    }
    if (command.startsWith("serve --bg --yes --https=443 ")) {
      if (this.needsConsent) {
        return {
          code: null,
          output: `Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123\n`,
        };
      }
      this.httpsEnabled = true;
      this.handler = args[args.length - 1];
      return {
        code: 0,
        output: `Available within your tailnet:\n\nhttps://${this.host}/\n|-- proxy ${this.handler}\n`,
      };
    }
    if (command === "serve --yes --https=443 --set-path=/ off") {
      this.handler = undefined;
      return { code: 0, output: "" };
    }
    return { code: 1, output: `unexpected command: ${command}\n` };
  };

  /** Stands in for Tailscale Serve itself: requests to the host go where its handler forwards. */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "stale.tailnet.ts.net") return new Response("Bad Gateway", { status: 502 });
    if (url.hostname !== this.host || !this.running) throw new TypeError("fetch failed");
    if (!this.handler) return new Response("Not Found", { status: 404 });
    return fetch(`${this.handler}${url.pathname}`, init).catch(() => new Response("Bad Gateway", { status: 502 }));
  }) as typeof fetch;
}
