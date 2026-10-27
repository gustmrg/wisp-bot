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
- SSH connections cannot ask for a password or a key passphrase. Use a key that loads without a prompt, such as one in the OpenSSH agent, and connect once with `ssh` in a terminal first to accept the host key. See [remote server](remote-server.md).
- Running commands in a Wisp's container needs Docker Desktop or Podman.

## Credential storage

Wisp Bot encrypts API keys with Windows DPAPI, tied to your Windows account. Another account on the same computer cannot read them.

## Data location

App data lives in `%APPDATA%\wisp-bot`.
