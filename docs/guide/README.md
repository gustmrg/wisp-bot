# Wisp guide

These pages are the guide Wisps read when someone asks them about the app:
where a setting lives, what a feature does, how to configure it. Each file is
one topic of the `wisp_help` tool. They are written for the person using the
app, not for developers; the rest of `docs/` covers how Wisp is built.

- Each topic starts with `title` and `summary` front matter. The summary is
  what a Wisp reads to choose a topic, so say what the topic answers.
- Point to screens with app links, which open them from a reply:
  `wisp://settings/<panel>` for the settings dialog and `wisp://wisp/<page>`
  for the settings of the Wisp in the conversation. The valid names are in
  `shared/app-links.ts`; the tests reject any other, and expect every panel
  and page to be linked from some topic.
- Use the labels the app shows, in bold, so people find them on screen.
- After editing, run `npm run guide` to regenerate `backend/app-guide-content.ts`.
