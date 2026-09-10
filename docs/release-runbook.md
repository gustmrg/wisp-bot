# Desktop release runbook

Wisp Bot ships macOS 14 x64/arm64 DMG and ZIP artifacts. GitHub Releases hosts the download artifacts and update channels. The workflow creates drafts only; publishing or promoting a release is always a separate, explicitly authorized action.

## Environment & Signing

Builds are packaged unsigned for macOS using ad-hoc identity (`CSC_IDENTITY_AUTO_DISCOVERY: false`). Because binaries are not notarized through an Apple Developer account, Gatekeeper will require users to right-click -> Open or run `xattr -cr "/Applications/Wisp Bot.app"`.

## Stage a release

1. Set `package.json` to the intended version and merge all quality gates.
2. Create and push the matching tag, such as `v0.1.0`.
3. Run **Desktop release** on that tag with `publish_draft` disabled. The workflow performs clean builds, audit and SBOM generation, unsigned packaging, checksums, and artifact uploads.
4. Download the retained artifacts and verify `SHA256SUMS.txt`.
5. To stage on GitHub Releases, rerun with `publish_draft` enabled. Inspect the draft and its artifacts before publishing.

The updater never downloads automatically. It accepts only artifacts authenticated by the platform signing chain and `electron-updater`; a verification failure remains an error and cannot enter the install-ready state.

## Promotion and rollback

Promote beta metadata gradually only after telemetry and the manual checks are clean. To halt a rollout, leave the draft unpublished or remove the affected channel metadata. To roll back, fix forward with a newly signed version greater than the affected version; downgrades are disabled so persisted schema compatibility remains monotonic. Retain the previous installers and untouched persistence migration backup until adoption is proven.

Record artifact hashes, workflow run, signing identities, smoke-test evidence, rollout percentage, and rollback decision in the release notes. Never paste credentials or raw provider responses into notes or logs.
