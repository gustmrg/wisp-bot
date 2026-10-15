---
title: Skills
summary: Saving a workflow as a skill, importing a SKILL.md file, how Wisps use skills, and managing them.
---
# Skills

A skill is a reusable procedure a Wisp follows when a request matches it.
Each Wisp has its own skills.

- **Save a workflow** — ask the Wisp to turn something you did together into
  a skill. It drafts general instructions, and an approval card shows exactly
  what will be saved.
- **Import a file** — attach a `SKILL.md` and ask the Wisp to save it; it is
  saved as written after your approval. Skills follow the Agent Skills format:
  a `SKILL.md` with `name` and `description` front matter.
- **Manage** — the Wisp's [Skills](wisp://wisp/skills) settings list its
  skills, show their instructions, import a file, delete one, open the folder
  that holds them, and reload them after editing by hand.

The Wisp sees the name and description of each skill and loads the full
instructions when one applies. Skills never grant tools or permissions.
Jobs can load skills in every run (see the *Jobs* topic).
