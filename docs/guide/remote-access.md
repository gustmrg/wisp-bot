---
title: Remote access and using Wisp on a phone
summary: Using this computer's Wisps from a phone or browser, turning on remote access with Tailscale, pairing a device with a QR code, revoking devices, and installing the browser app on a phone.
---
# Remote access and using Wisp on a phone

[Remote access](wisp://settings/remote-access) lets your phone or another
device use the Wisps on this computer. (To make this app use Wisps on a
server instead, see *Connections and Wisp servers*.)

1. Install Tailscale on this computer and on the phone, signed in to the same
   tailnet. With Tailscale ready, turning remote access on takes one click;
   otherwise the panel says what to fix, or **Set it up by hand** walks
   through it.
2. Under **Pair a device**, select **Show QR code** and scan it with the
   phone. The code works once and lasts 10 minutes.
3. On the phone, add the page to the home screen (**Share → Add to Home
   Screen** in Safari, **Install app** in Chrome) to open it like an app.

While remote access is on, the app keeps running in the tray with its windows
closed. **Paired devices** lists the devices; **Revoke** signs one out.
A Wisp server can be opened in a browser the same way, after pairing with a
code from `wispctl pair` on the server.
