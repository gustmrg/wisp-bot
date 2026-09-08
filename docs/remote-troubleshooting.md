# Remote connection diagnostics

| Symptom | Check and resolution |
| --- | --- |
| Server refuses startup | Check Node 24.18+, private 32-byte master key, directory ownership, timezone and whether another service owns the directory. `instance-lock.sqlite` holds the OS lock; never remove it while any instance is running. `server.lock` is diagnostic only, and reused or stale PIDs do not prevent restart. |
| SSH permission denied | Test `ssh USER@HOST` from the same client account. Load the correct key into `ssh-agent`; verify authorized_keys or Tailscale SSH policy. Wisp does not accept/store SSH passwords. |
| Unknown/changed SSH host key | Compare the server fingerprint out of band. Never bypass host key checking. Confirm a legitimate host replacement before trusting a new key. |
| `wispctl` unavailable through SSH | Check the noninteractive SSH PATH. Install the fixed wrapper there; ensure it uses the owning account/data directory and Node 24. |
| Tailscale SSH check required | Use the explicit authentication action in Connections and complete the identity check, then reconnect. Network grants and SSH policy are independent. |
| HTTPS unavailable | Check both devices are online in Tailscale, `tailscale serve status`, network grants, exact HTTPS origin and loopback readiness. Serve is distinct from Funnel. |
| Pairing rejected | Generate a fresh single-use code on the server. Check that the profile points to the intended server. Codes and session tokens are separate from Tailscale identity. |
| Native mobile CORS rejected | Allow exactly `capacitor://localhost,https://localhost` on the server, use HTTPS, and pair as a native bearer device. Do not add wildcard origins or cookies to native requests. |
| Server identity changed | Verify deployment/restore target before removing and re-pairing the profile. A hostname or tunnel port alone is not a persistent identity. |
| Request outcome uncertain | Reconnect and reconcile the durable request by ID. Do not automatically create a new request; tools may already have affected external systems. |
| Stale settings or approval conflict | Reload shared state. Another device may have edited settings or decided the approval first. |
| Cursor expired | The client fetches a new consistent snapshot. Restores and event retention invalidate old cursors by design. |
| Import refused | Use an empty instance, finish active work and run a dry run. Credentials are reconfigured separately for migration. |
| Restored provider credentials fail | Supply the original server master key, not the archive key or desktop safeStorage material. |

Diagnostics may contain server/device IDs and timestamps, but should never include conversations, pairing codes, bearer tokens, provider credentials or private keys. For service problems inspect `journalctl --user -u wisp` and `wispctl status`. Run `npm test`, `npm run test:e2e`, `npm run dist:server` and the native build commands to reproduce the automated checks in a development checkout.
