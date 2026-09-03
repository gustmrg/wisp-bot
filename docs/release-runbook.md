# Desktop release runbook

Wisp Bot ships Windows 11 x64 NSIS installers and macOS 14 x64/arm64 DMG and ZIP artifacts. GitHub Releases hosts the `beta` and `latest` update channels. The workflow creates drafts only; publishing or promoting a release is always a separate, explicitly authorized action.

## Protected environment

Configure the `release` GitHub environment with required reviewers and these values:

- Azure variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `WINDOWS_PUBLISHER_NAME`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_PROFILE`, and `AZURE_TRUSTED_SIGNING_ACCOUNT`.
- Apple secrets: `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- Pi smoke values: `WISP_PI_SMOKE_PROVIDER`, `WISP_PI_SMOKE_MODEL`, and secret `WISP_PI_SMOKE_API_KEY`.

Azure authentication uses GitHub OIDC. Signing credentials stay in the protected environment and are never written into the repository or uploaded as artifacts.

## Stage a release

1. Set `package.json` to the intended version and merge all quality gates.
2. Create and push the matching tag, such as `v0.1.0`.
3. Run **Desktop release** on that tag with `publish_draft` disabled. The workflow performs clean builds, audit and SBOM generation, native signing verification, install/launch/uninstall smoke tests, checksums, and the protected real-agent smoke test.
4. Download the retained artifacts and verify `SHA256SUMS.txt`. Exercise the installed app with an existing profile copy: confirm migration, one fake-agent conversation, update check, offline recovery, download, restart/install, and post-update data integrity.
5. To stage on GitHub, rerun with `publish_draft` enabled. Inspect the draft and its channel metadata. Do not publish it without explicit authorization.

The updater never downloads automatically. It accepts only artifacts authenticated by the platform signing chain and `electron-updater`; a verification failure remains an error and cannot enter the install-ready state.

## Promotion and rollback

Promote beta metadata gradually only after telemetry and the manual checks are clean. To halt a rollout, leave the draft unpublished or remove the affected channel metadata. To roll back, fix forward with a newly signed version greater than the affected version; downgrades are disabled so persisted schema compatibility remains monotonic. Retain the previous installers and untouched persistence migration backup until adoption is proven.

Record artifact hashes, workflow run, signing identities, smoke-test evidence, rollout percentage, and rollback decision in the release notes. Never paste credentials or raw provider responses into notes or logs.
