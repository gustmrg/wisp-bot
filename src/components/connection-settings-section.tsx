import { ConnectionsPanel } from "@/features/connections/connections-panel";
import { useConnections } from "@/features/connections/connection-gate";

export function ConnectionSettingsSection() {
  const [view, error] = useConnections();
  return (
    <section
      className="overflow-y-auto px-[30px] py-6 max-[620px]:px-4 max-[620px]:py-5"
      id="connection-settings-panel"
      aria-labelledby="connection-settings-title"
    >
      <h2 id="connection-settings-title" className="mb-1 mt-0 text-[17px]">
        Connections
      </h2>
      <p className="mb-4 text-[11.5px] leading-relaxed text-dim">
        Choose where your Wisps run. On a Wisp server they keep working while this app is closed, and every paired
        device sees the same conversations. Settings, credentials, and approvals belong to the server you use.
      </p>
      {view ? (
        <ConnectionsPanel view={view} />
      ) : error ? (
        <p role="alert" className="text-[11.5px] text-destructive">
          {error}
        </p>
      ) : (
        <p role="status" className="text-xs text-dim">
          Loading connections…
        </p>
      )}
    </section>
  );
}
