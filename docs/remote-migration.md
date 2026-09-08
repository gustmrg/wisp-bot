# Moving an instance and recovering backups

Transfers are administrative commands, not browser uploads. Close the local desktop before an offline export. Wait for server requests to finish before exporting/importing/backing up; maintenance rejects new mutations. Imports require an empty destination, never replace existing conversations/files, and reject duplicate archives. Export leaves the source unchanged.

Create a private 32-byte archive key separately from the server's credential master key:

```sh
wispctl keygen --output /private/location/transfer.key
wispctl export-local --source /path/to/desktop/userData/backend \
  --output /private/location/history.wisp --key-file /private/location/transfer.key --dry-run
wispctl export-local --source /path/to/desktop/userData/backend \
  --output /private/location/history.wisp --key-file /private/location/transfer.key
```

Transfer both files using a trusted encrypted channel, retaining restrictive permissions. On the server, start an empty instance and run:

```sh
wispctl import --input /private/location/history.wisp --key-file /private/location/transfer.key --dry-run
wispctl import --input /private/location/history.wisp --key-file /private/location/transfer.key
```

The archive preserves conversation/session identities, complete message history, circle membership, context policy/memory, model selection, tool policy, Pi JSONL sessions and workspaces. Only structured Pi session metadata paths are rebased; message/tool text is never rewritten. Model credentials are intentionally excluded from migration because desktop `safeStorage` ciphertext belongs to the original OS account. Configure provider credentials on the destination. The archive records the source timezone. For an offline desktop export, the CLI uses its current timezone; pass `--time-zone America/Fortaleza` when the desktop originally ran in that timezone on another machine. Create the destination with the same `--time-zone`: import rejects a mismatch before changing data, preserving daily context behavior. Owner identity is chosen when creating the destination.

`wispctl export` performs the corresponding server-to-server migration. `wispctl backup` includes SQLite, server credential ciphertext and instance state; keep the **original server master key** separately to decrypt provider credentials after restore:

```sh
wispctl backup --output /private/location/instance.wisp --key-file /private/location/transfer.key
# Offline operation, does not need a running destination server:
wispctl restore --input /private/location/instance.wisp \
  --target /path/to/new-data-directory --key-file /private/location/transfer.key --dry-run
wispctl restore --input /private/location/instance.wisp \
  --target /path/to/new-data-directory --key-file /private/location/transfer.key
```

Point the stopped service at the restored directory and original master key. Restore checks SQLite integrity, rebases Pi metadata, invalidates event cursors, expires pending approvals and revokes all historical device sessions. Pair devices again. The prior data directory remains available for rollback. Never run the old and restored instance simultaneously against the same external workload.

Archives use authenticated AES-256-GCM encryption with a random nonce, bounded gzip payload, per-file SHA-256 manifests and strict path validation. Symlinks, traversal, special files, duplicate files and missing referenced sessions are rejected. Current limits are 10,000 files, 64 MiB of file contents and 128 MiB of uncompressed archive JSON; split/clean nonessential workspace artifacts before transferring a larger instance. A dry run performs validation and reports counts without writing destination data. Restore dry runs also validate the SQLite contents in a private temporary directory, then discard them. A dry run does not guarantee a later export sees unchanged input; keep the source quiescent. An import recovery journal reconciles file moves with the committed SQLite import marker after a process crash; startup removes uncommitted imported files or completes cleanup without deleting the source archive.

Do not include archive keys, master keys or archives in Git. Test restore periodically into an isolated directory and verify a representative conversation and Pi session before relying on a backup.
