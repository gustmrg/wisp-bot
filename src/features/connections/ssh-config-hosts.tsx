import { useEffect, useState } from "react";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SshConfigHost } from "../../../shared/connections";

/** Where OpenSSH connects for an alias, when that says more than the alias. */
export function describeSshConfigHost(host: SshConfigHost): string {
  const target = `${host.user ? `${host.user}@` : ""}${host.hostname ?? host.alias}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
  return target === host.alias ? "" : target;
}

/**
 * The machines of this computer's ~/.ssh/config, to pick instead of typing a
 * host. Shows nothing while loading, or when there are none.
 */
export function SshConfigHosts({
  selected,
  added,
  onChoose,
}: {
  selected: string;
  /** Hosts that already have a connection. */
  added: ReadonlySet<string>;
  onChoose: (host: SshConfigHost) => void;
}) {
  const [hosts, setHosts] = useState<ReadonlyArray<SshConfigHost>>([]);

  useEffect(() => {
    let current = true;
    window.wisp
      .listSshHosts()
      .then((result) => {
        if (current && result.ok) setHosts(result.value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  if (hosts.length === 0) return null;
  return (
    <div className="mb-4">
      <p id="ssh-config-hosts-label" className="mb-[5px] mt-0 text-xs text-dim">
        From your SSH config
      </p>
      <ul
        aria-labelledby="ssh-config-hosts-label"
        className="m-0 flex max-h-[188px] list-none flex-col gap-0.5 overflow-y-auto rounded-[10px] bg-popover p-1"
      >
        {hosts.map((host) => {
          const exists = added.has(host.alias);
          const chosen = selected === host.alias;
          const detail = describeSshConfigHost(host);
          return (
            <li key={host.alias}>
              <button
                type="button"
                aria-pressed={chosen}
                disabled={exists}
                onClick={() => onChoose(host)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  chosen ? "bg-muted" : "hover:bg-muted/60",
                  exists && "cursor-default opacity-60 hover:bg-transparent",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{host.alias}</span>
                  {detail ? <span className="mt-0.5 block truncate text-xs text-dim">{detail}</span> : null}
                </span>
                {exists ? (
                  <span className="flex-none text-2xs text-dim">Added</span>
                ) : chosen ? (
                  <CheckIcon className="size-4 flex-none text-primary" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
