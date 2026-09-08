# Wisp for Android and iOS

The native app bundles the same React interface as the web client and connects to a Wisp server through its **HTTPS Tailscale Serve URL**. Connect the phone to the same tailnet before pairing. SSH tunnels belong to the desktop application.

## Build

From the repository root, use Node 24.18 or later, install dependencies with `npm ci`, then run:

```sh
npm run mobile:sync
```

The native projects and custom credential plugins are checked in. Sync copies the current local UI assets and updates the native Capacitor dependencies; it does not download an interface from a remote server.

Android requires JDK 21, Android SDK platform 36, and build tools 35/36. With `JAVA_HOME` and `ANDROID_HOME` configured:

```sh
cd mobile/android
./gradlew assembleDebug
```

The installable development APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Install it on a test phone with `adb install -r` and that path, or open the project in Android Studio. Production signing and store publication are separate operations.

iOS requires macOS, Xcode 26 with its iOS platform and a simulator runtime installed. Open `mobile/ios/App/App.xcodeproj`, or compile a simulator build:

```sh
xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
```

Install the resulting `App.app` in a booted simulator using `xcrun simctl install booted /path/to/App.app`. Installing on a physical iPhone requires selecting your Apple development team and provisioning the app in Xcode. The repository contains no signing certificates or provisioning secrets.

## Server and pairing

Enable HTTPS with Tailscale Serve as documented in [remote-server](../docs/remote-server.md). Configure the exact WebView origins on the server:

```sh
WISP_ALLOWED_ORIGINS='capacitor://localhost,https://localhost'
```

`capacitor://localhost` is the iOS origin and `https://localhost` is the Android origin. These origins authorize bearer-token requests for the native client; browser sessions remain same-origin cookies with CSRF protection. Do not use wildcard CORS, turn on cleartext traffic, or bypass certificate validation.

Generate a single-use pairing code with `wispctl pair --data-dir <server-data-directory> --json`, enter the Serve URL, device name, and code in the mobile application. The server's device list allows revoking a lost phone. Saved provider API keys are never returned to the mobile client. Entering a new key in model settings sends it over authenticated HTTPS to server-side encrypted storage.

Session credentials are stored with `WispSecureSession`, a native plugin included in these projects:

- iOS: a non-synchronizing Keychain item, `WhenUnlockedThisDeviceOnly`.
- Android: AES-256-GCM encrypted session bytes in private preferences, using a non-exportable Android Keystore key. App backup and cleartext traffic are disabled.

Credentials never use Capacitor Preferences or browser local/session storage. A storage failure stops pairing with a visible error. “Forget the saved connection” removes the local protected session; use another authenticated device to revoke the server record if the phone cannot connect.

## Behavior and validation

The app revalidates its session and loads a fresh server snapshot when returning to the foreground or regaining connectivity. Sending is disabled during this synchronization. The server keeps running agents while the app is suspended or closed. Wi-Fi/cellular transitions and losing the VPN use the same reconnection path. No commands are queued automatically while offline.

The phone layout switches between conversation list, chat and full-width settings. Android Back closes settings or returns to the list. The composer avoids opening the virtual keyboard on navigation, respects composition input, and preserves drafts separately for each server. Sign-out can clear those drafts. Safe-area padding and the dynamic viewport keep controls visible around device insets and the keyboard.

Before distributing to physical devices, verify:

1. Pair using the server's Serve URL with Tailscale active; send and receive on two devices.
2. Suspend the app while a response is running; return and see the completed response once.
3. Switch Wi-Fi/cellular; disable and restore Tailscale; verify reconnect and draft retention.
4. Revoke the phone on the server; confirm it must pair again and cannot send.
5. Open the keyboard, edit multiline/IME text, and navigate list/chat/settings in portrait and landscape.
6. Sign out; verify the native session is removed and optional per-server drafts are cleared.

Automated checks cover both Chromium and WebKit against the real server through a local TLS proxy, including two-client synchronization, reconnect, cookie/CSRF boundaries, mobile layout, and the PWA cache. Native device VPN transitions, physical keyboard behavior, and operating-system suspension still require device validation; browser tests cannot emulate a real Tailscale tunnel or the iOS lifecycle.
