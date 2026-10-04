# Installing on Linux

Each release ships an x64 `.deb` and an AppImage. Both update in place from Settings → About.

## Debian and Ubuntu (`.deb`)

```bash
sudo apt install ./Wisp-Bot-<version>-linux-amd64.deb
```

The package installs to `/opt/Wisp Bot`, adds a desktop entry, and pulls its runtime dependencies (including `libsecret-1-0`). Updates from the app ask for the administrator password through `pkexec`. Remove the app with `sudo apt remove wisp-bot`.

## Other distributions (AppImage)

```bash
chmod +x Wisp-Bot-<version>-linux-x86_64.AppImage
./Wisp-Bot-<version>-linux-x86_64.AppImage
```

- AppImages need FUSE 2. On Ubuntu 24.04 and later, install `libfuse2t64`. On older releases, install `libfuse2`.
- Some distributions, Ubuntu 24.04 and later among them, use AppArmor to block the unprivileged user namespaces that Chromium's sandbox needs. If the AppImage exits with a sandbox error, use the `.deb` instead. Do not run it with `--no-sandbox`, because that turns off a renderer protection the app depends on.
- Updates replace the AppImage file in place, so keep it somewhere you can write to.

## Credential storage

Wisp Bot encrypts API keys through the desktop secret store: GNOME Keyring, KWallet, or another Secret Service provider. Without one, Electron falls back to `basic_text`, and Wisp Bot will not save credentials. Install and unlock a keyring, for example `gnome-keyring`, before you add a model.

## Data location

App data lives in `~/.config/wisp-bot`.
