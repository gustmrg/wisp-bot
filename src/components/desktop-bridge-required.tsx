import { MonitorCogIcon } from "lucide-react";

function DesktopBridgeRequired() {
  return (
    <main className="flex h-full min-h-0 items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm" role="alert">
        <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-muted">
          <MonitorCogIcon aria-hidden="true" className="size-5" />
        </div>
        <h1 className="text-lg font-semibold">Open Wisp in the desktop app</h1>
        <p className="mt-2 text-sm leading-6 text-dim">
          This browser tab only contains the renderer. It cannot access Wisp&apos;s secure Electron backend.
        </p>
        <p className="mt-4 text-sm text-dim">
          From the project directory, run{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">npm run dev</code>, then use the
          Electron window that opens.
        </p>
      </section>
    </main>
  );
}

export { DesktopBridgeRequired };
