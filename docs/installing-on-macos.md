# Installing on macOS (unsigned builds)

Current macOS artifacts are **ad-hoc signed, not notarized** — the release
pipeline packages them without a Developer ID certificate
(`CSC_IDENTITY_AUTO_DISCOVERY: false`) because there is no Apple Developer
account ([ADR 007](decisions/007-release-automation.md)). When you open a
downloaded build for the first time, Gatekeeper may report that the app
"is damaged and can't be opened" and suggest moving it to the Trash. The app
is not damaged; Gatekeeper refuses quarantined downloads without a valid
notarized signature.

## Allowing the app to run

Remove the quarantine attribute that the downloading browser added:

```bash
xattr -dr com.apple.quarantine "/Applications/Wisp Bot.app"
```

Then open the app normally. `xattr -cr` (clearing all extended attributes)
works too.

Notes:

- Right-click → **Open** is **not** sufficient for the "damaged" error; that
  workaround only applies to the "unidentified developer" dialog.
- The command must be repeated for every newly downloaded release, because
  each download is quarantined again.
- You can confirm a build is ad-hoc signed with
  `codesign -dv "/Applications/Wisp Bot.app"` (`Signature=adhoc`,
  `TeamIdentifier=not set`).

The same goes for updates. Ad-hoc builds cannot install updates themselves,
so Settings → About opens the releases page. Download the new DMG, replace the
app in `/Applications`, and run the `xattr` command again.

This step will go away once macOS builds are Developer ID signed and
notarized.
