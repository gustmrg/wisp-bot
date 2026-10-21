# ADR 029: Files in a Wisp's replies

- Status: Accepted
- Date: 2026-10-21
- Decision owners: Wisp renderer, server API and security boundary
- Scope: How a Wisp shows workspace files in the conversation, and how they are served
- Related: [ADR 009](009-headless-server.md), [ADR 017](017-container-execution.md),
  [ADR 028](028-wisp-browser.md), [security](../security.md); Linear SWE-177

## Context

A Wisp writes files into its workspace (charts, reports, pages it built, the
browser's screenshots), but its reply could only name them: the person had to
open the workspace folder, which a phone or a browser on another computer
cannot do. Showing them needs the files to reach the device, which reaches the
server with its own sign-in (an access token, or a browser's HttpOnly cookies),
and must not turn a reply into a way to read the rest of the workspace.

## Decision

**A reply shows a workspace file when it writes `<media src="path" />` or a
Markdown image `![](path)` with a workspace path. The app fetches the file
itself and shows it as an image, an audio or video player, or a file card;
the server serves only files the Wisp's own message in that conversation
refers to.**

- **In the reply:** a path without a scheme is a workspace path: relative to
  the workspace, or under the container's `/workspace`. Images show inline and
  open full size; audio and video get players; HTML and Markdown files get a
  card that opens a preview; any other file gets a card that downloads it. Web
  addresses stay ordinary images, and tags inside code are left as written.
  The system prompt tells every Wisp how to show a file.
- **Serving:** `GET /api/v1/media?conversationId&messageId&path[&maxBytes]`
  answers the raw bytes. The server reads the named message, requires it to be
  the Wisp's (incoming) message in that conversation, requires the path to be
  one the message shows, and resolves it inside the conversation's workspace,
  following links, refusing anything outside it, and opening it without
  following a final link. The bytes go out as `application/octet-stream`,
  `attachment`, `nosniff`, `no-store` and a sandboxing policy, so a browser
  that opened the address would only save the file. A refusal is a
  `BackendResult` in JSON.
- **The app fetches:** the desktop app's main process fetches through its
  session with the server (`readConversationMedia` over IPC); the browser app
  fetches with its cookie session. The renderer holds the bytes as a blob, so
  no tab ever opens a server address without the app's sign-in. A reply still
  being written is not fetched until it is stored.
- **Limits:** files up to 16 MiB are shown; a larger one gets a card, and
  **Download** saves files up to 512 MiB. Markdown above 2 MiB is shown as
  plain text. A failed load says why and offers **Retry**.
- **HTML previews:** the app loads `media-preview.html`, a static page shipped
  with the app, in a frame with `sandbox="allow-scripts allow-popups
  allow-popups-to-escape-sandbox"`, so it has an opaque origin: it cannot read
  the app's storage or cookies, reach the app's page, or send forms. The page
  asks for the document, which the app sends once, and writes it in its place.
  Its own policy (`MEDIA_PREVIEW_CONTENT_SECURITY_POLICY`, sent as a header by
  the server and as a meta tag in the app) lets the document's scripts and
  styles run and web images, styles, fonts and media load, and blocks
  `fetch`, XHR and WebSockets (`connect-src 'none'`), form posts, frames and
  workers. Other workspace files the document names are not served: they
  resolve to the app's files or to nothing, and the media route needs the
  message and the sign-in a sandboxed frame does not have, so pages must embed
  them. Links open in a new window (the system browser on the desktop), where
  the address answers for itself. The app's own policies allow frames only
  from the app (`frame-src 'self'`) and media from blobs.
- **Browser screenshots:** the `browser` tool saves each screenshot in the
  workspace under `browser-screenshots/`, within the workspace's size, and
  tells the Wisp the `<media>` tag that shows it, so even a model that cannot
  see images can show the page to the person.

## Consequences

- A Wisp can show charts, screenshots, recordings and generated pages in the
  conversation on every device, including phones on a remote server.
- A file shown in a reply stays readable through that message while it is in
  the workspace; deleting the file removes it from the conversation.
- A preview page's scripts run with the person watching, without network
  access from scripts; they can still load web images and styles, which tells
  those servers the page was opened.

## Rejected alternatives

- **Serving the workspace by path:** any page or device with the address
  could read any file; tying the file to the message keeps the person's view
  to what the Wisp chose to show.
- **`srcdoc` or blob frames:** they inherit the app's policy, which allows no
  inline scripts, so a page's scripts would never run; a static page with its
  own policy avoids that without loosening the app's.
- **Loading the HTML from the media route in the frame:** the desktop app's
  renderer has no sign-in of its own for the server, and the frame would need
  one.
