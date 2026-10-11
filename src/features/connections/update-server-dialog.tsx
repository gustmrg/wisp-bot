import { ArrowUpCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_METADATA } from "@/config/app-metadata";
import { WISP_SERVER_PACKAGE } from "../../../shared/server-package";

/** A lighter backdrop for the connection dialogs, so the connection screen stays readable behind them. */
export const CONNECTION_BACKDROP = "bg-black/30";

/** Compares dotted version numbers; anything after a `-` is ignored. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) => (version.split("-")[0] ?? "").split(".").map((part) => Number(part) || 0);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * Asks before updating the Wisp server behind an SSH connection to this
 * app's version: it changes another computer, keeps its data, and
 * interrupts what its Wisps are doing.
 */
export function UpdateServerDialog({
  name,
  host,
  serverVersion,
  onConfirm,
  onCancel,
}: {
  name: string;
  host: string;
  serverVersion: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const appVersion = APP_METADATA.version;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent backdropClassName={CONNECTION_BACKDROP}>
        <DialogHeader>
          <DialogTitle>
            Update {name} to {appVersion}?
          </DialogTitle>
          <DialogDescription>
            The server runs {serverVersion}, older than this app. Some features need both on the same version.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-[10px] border border-border bg-popover px-3.5 py-3 text-sm leading-relaxed">
          <h2 className="m-0 mb-1.5 text-sm font-semibold">What happens</h2>
          <ul className="m-0 flex flex-col gap-1 pl-4">
            <li>
              Wisp runs the setup of <code>{WISP_SERVER_PACKAGE}</code> on {host} over SSH, then reconnects.
            </li>
            <li>
              <strong className="font-medium">Kept:</strong> Wisps, conversations and the master key in{" "}
              <code>~/.config/wisp</code>.
            </li>
            <li>
              <strong className="font-medium">Interrupted:</strong> anything a Wisp is doing on the server right now.
            </li>
          </ul>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Not now
          </Button>
          <Button type="button" onClick={onConfirm}>
            <ArrowUpCircleIcon aria-hidden="true" />
            Update and reconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
