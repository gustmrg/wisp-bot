---
title: Getting started and creating Wisps
summary: First-run setup, creating a Wisp (appearance, soul, model, workspace, templates), sharing a Wisp as a template, and deleting one.
---
# Getting started and creating Wisps

## First run

Before the workspace opens, Wisp asks only for what is missing: your
preferred name, a default model, and an API key for that model's provider.
A new installation also asks **Where should your Wisps run?**: on this
computer (recommended) or on a Wisp server (see the *Connections and Wisp
servers* topic). Change these later in [General](wisp://settings/general),
[AI Model](wisp://settings/model) and [Connections](wisp://settings/connections).

## Creating a Wisp

Select **Create Wisp** in the sidebar. The dialog has sections for:

- **Appearance and name** — its look, color, name and an optional role.
- **Soul and behavior** — the soul: who the Wisp is and how it behaves,
  written in Markdown. **Start from a template** offers ready-made souls.
- **Model** — keep **Use global model** or choose a provider and model for
  this Wisp. The model is chosen here and cannot be changed later for now.
- **Workspace and commands** — the size of its private folder, and whether it
  can run commands in a container.

**Import template** fills the dialog from a template someone copied with
**Share as template**.

A Wisp needs a usable model: the global default with a saved provider key, or
its own model whose provider has a saved key.

## Sharing and deleting

In the Wisp's [Profile](wisp://wisp/profile) (on the desktop, the bottom of
the **General** tab), **Share as template** copies its soul and model so it
can be pasted into **Import template**. **Delete Wisp** permanently deletes
it with its history and settings; its workspace files are kept as an archive
in [Storage](wisp://settings/storage) until you delete them there.

Each Wisp has its own conversation. Your profile in
[General](wisp://settings/general) (preferred name, about you, response
preferences) is shared with every Wisp.
