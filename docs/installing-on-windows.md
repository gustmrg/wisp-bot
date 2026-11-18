# Installing on Windows

Each release ships an x64 installer, `Wisp-Bot-<version>-win-x64.exe`, for Windows 10 and 11. It updates in place from **Settings → About**. There is no arm64 build.

## First install

The installer is not code-signed ([ADR 031](decisions/031-unsigned-windows-release.md)), so Windows warns before it runs:

1. If the browser warns that the file is not commonly downloaded, keep it. In Edge, open the download's **…** menu and choose **Keep**, then **Show more → Keep anyway**.
2. Open the installer. When SmartScreen shows "Windows protected your PC", choose **More info**, check that the app is `Wisp-Bot-<version>-win-x64.exe`, and choose **Run anyway**.
3. Follow the installer. It installs for your user only, in `%LOCALAPPDATA%\Programs\wisp-bot`, and needs no administrator rights.

Check the download against `SHA256SUMS.txt` from the same release before you run it:

```powershell
Get-FileHash .\Wisp-Bot-<version>-win-x64.exe -Algorithm SHA256
```

## Updates

**Settings → About** downloads an update, checks it against the SHA-512 in the release's update feed, and installs it when you restart. Updates do not show the SmartScreen warning again.

## Removing the app

Remove **Wisp Bot** from **Settings → Apps → Installed apps**. Your data stays in place.

## Known limitations

- **Launch at login** is not available yet.
- SSH connections cannot ask for a password or a key passphrase. Set up a key first, as in [SSH on Windows](#ssh-on-windows).
- Running commands in a Wisp's container needs Docker Desktop or Podman.

## SSH on Windows

Wisp uses the OpenSSH client that comes with Windows. On Windows it cannot
ask for a password, a key passphrase, or whether to trust a host key yet. Set
up a key once in PowerShell before you add an SSH connection:

1. Create a key, if `%USERPROFILE%\.ssh` has none. Press Enter at the
   passphrase prompt to leave it empty, or see step 4.

   ```powershell
   ssh-keygen -t ed25519
   ```

2. Add it to the server. Windows has no `ssh-copy-id`; this does the same.
   You type the server's password once:

   ```powershell
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@host "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ```

   Add `-p <port>` after `ssh` when SSH does not listen on port 22. This also
   asks you to trust the server's host key the first time.
3. Check that it works the way Wisp connects. It should print nothing and ask
   nothing:

   ```powershell
   ssh -o BatchMode=yes user@host true
   ```

4. For a key with a passphrase, start the **OpenSSH Authentication Agent**
   service (set it to **Automatic** in **Services**) and load the key with
   `ssh-add`. Wisp can then use it without asking.

When a server turns the key away, the connection screen shows these commands
for your key and server.

## Credential storage

Wisp Bot encrypts API keys with Windows DPAPI, tied to your Windows account. Another account on the same computer cannot read them.

## Data location

App data lives in `%APPDATA%\wisp-bot`.
