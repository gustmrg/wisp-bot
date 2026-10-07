import { useEffect, useId, useState } from "react";
import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SshConfigHost, TailnetMachine } from "../../../shared/connections";

/** Where OpenSSH connects for an alias, when that says more than the alias. */
export function describeSshConfigHost(host: SshConfigHost): string {
  const target = `${host.user ? `${host.user}@` : ""}${host.hostname ?? host.alias}${host.port && host.port !== 22 ? `:${host.port}` : ""}`;
  return target === host.alias ? "" : target;
}

interface Machine {
  /** What goes into the Host field. */
  host: string;
  name: string;
  detail: string;
}

/**
 * Machines to pick instead of typing a host: the ones in this computer's
 * ~/.ssh/config, then the Linux machines on its tailnet that the config does
 * not name. Shows nothing while loading, or when there are none.
 */
export function MachinePicker({
  selected,
  added,
  onChoose,
}: {
  selected: string;
  /** Hosts that already have a connection. */
  added: ReadonlySet<string>;
  onChoose: (machine: { host: string; name: string }) => void;
}) {
  const [configured, setConfigured] = useState<ReadonlyArray<SshConfigHost>>([]);
  const [tailnet, setTailnet] = useState<ReadonlyArray<TailnetMachine>>([]);

  useEffect(() => {
    let current = true;
    window.wisp
      .listSshHosts()
      .then((result) => {
        if (current && result.ok) setConfigured(result.value);
      })
      .catch(() => undefined);
    window.wisp
      .listTailnetMachines()
      .then((result) => {
        if (current && result.ok) setTailnet(result.value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  // A tailnet machine the config already names is listed once, by its alias.
  const named = new Set(configured.flatMap((host) => [host.alias, host.hostname ?? host.alias]));
  return (
    <>
      <MachineList
        label="From your SSH config"
        machines={configured.map((host) => ({
          host: host.alias,
          name: host.alias,
          detail: describeSshConfigHost(host),
        }))}
        selected={selected}
        added={added}
        onChoose={onChoose}
      />
      <MachineList
        label="On your tailnet"
        machines={tailnet
          .filter((machine) => !named.has(machine.name) && !named.has(machine.dnsName))
          .map((machine) => ({
            host: machine.dnsName,
            name: machine.name,
            detail: [machine.dnsName, machine.online ? "" : "offline"].filter(Boolean).join(" · "),
          }))}
        selected={selected}
        added={added}
        onChoose={onChoose}
      />
    </>
  );
}

function MachineList({
  label,
  machines,
  selected,
  added,
  onChoose,
}: {
  label: string;
  machines: Machine[];
  selected: string;
  added: ReadonlySet<string>;
  onChoose: (machine: { host: string; name: string }) => void;
}) {
  const labelId = useId();
  if (machines.length === 0) return null;
  return (
    <div className="mb-4">
      <p id={labelId} className="mb-[5px] mt-0 text-xs text-dim">
        {label}
      </p>
      <ul
        aria-labelledby={labelId}
        className="m-0 flex max-h-[188px] list-none flex-col gap-0.5 overflow-y-auto rounded-[10px] bg-popover p-1"
      >
        {machines.map((machine) => {
          const exists = added.has(machine.host);
          const chosen = selected === machine.host;
          return (
            <li key={machine.host}>
              <button
                type="button"
                aria-pressed={chosen}
                disabled={exists}
                onClick={() => onChoose({ host: machine.host, name: machine.name })}
                className={cn(
                  "flex w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  chosen ? "bg-muted" : "hover:bg-muted/60",
                  exists && "cursor-default opacity-60 hover:bg-transparent",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{machine.name}</span>
                  {machine.detail ? (
                    <span className="mt-0.5 block truncate text-xs text-dim">{machine.detail}</span>
                  ) : null}
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
