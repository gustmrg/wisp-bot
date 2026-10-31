# ADR 040: Wisp templates

- Status: Accepted
- Date: 2026-10-27
- Decision owners: Wisp maintainer, backend and renderer
- Scope: Saving, sharing and reusing a Wisp's complete setup as a template
- Related: [ADR 008](008-wisp-skills.md), [ADR 010](010-wisp-entity.md),
  [ADR 023](023-wisp-permissions.md), [security](../security.md), SWE-232

## Context

A Wisp started from one of six starting souls, and everything else was set
up by hand, Wisp by Wisp: skills, model, look, workspace, commands, and
access to plugins and MCP servers. Someone building a team repeated that
work for every Wisp and had nowhere to keep a setup that worked.
**Share as template** copied only the name, role, soul and model as JSON
to the clipboard, to paste into the creation dialog.

## Decision

**A template is a complete starting point for a Wisp, kept per environment,
and it never grants access by itself.**

- **Format.** Version 2 of the `wisp-template` JSON format
  (`shared/wisp-template.ts`) adds a description, the look and color, skills
  as complete `SKILL.md` files, the workspace size and commands, and the
  access the template asks for: file change rules, risk mode, plugins and MCP
  servers. Version 1 templates still read. A template that uses nothing new
  is still written as version 1, so older apps read what this one shares. A
  newer version asks for an update. The same parser checks templates in the
  app and on the server; a broken skill rejects the template and says which.
- **Where templates live.** Six built-in templates, one per starting soul,
  ship in `shared/builtin-wisp-templates.ts`. They are read-only and change
  with the app. Saved templates are one
  file each in the server's `wisp-templates/` folder (`WispTemplateStore`),
  at most 200, stored as parsed so unknown fields never reach the disk. Each
  environment, **This computer** and every Wisp server, keeps its own; a
  template moves between them only when the person exports and imports it.
- **The section.** **Settings → Templates** lists the built-in and saved
  templates as cards, with search and a filter, and previews everything a
  template sets up before it is used. The **Templates** button in the creation
  dialog opens it too; the dialog keeps its **Import template** paste field. It
  reads as a gallery, so built-in
  templates offer only **Use**. Saved templates can be duplicated, renamed,
  deleted, exported as one `.wisp-template.json` file, and imported from one.
  The app reads an imported file and sends its text, never a path.
- **Creating from a template.** **Use** creates the Wisp at once and opens
  its conversation, because someone who picks a prepared Wisp does not want to
  create or configure one. What cannot be used here falls back to the default,
  with a notice: a model without a key, a workspace too large for the disk or
  unlimited, and commands without a container program. Without a default model
  nothing is created, and the notice leads to **AI Model**. A second Wisp from
  one template gets a number, as in **Atlas 2**. Skills are added through the
  operation the Wisp's settings use. Built-in skills come with the app; a saved
  template with skills opens its preview first, and using it there is the
  person's approval ADR 008 requires.
- **Saving a Wisp as a template.** **Save as template** reads the Wisp's
  setup through those operations: its look, soul, its own model (one
  following the global model keeps following it), skills, workspace,
  commands and access.

## Consequences

- A template carries no credentials and cannot widen what a Wisp may do.
  Plugins and MCP servers are named by ID: a template from elsewhere can ask
  for them, and only the person can turn them on, in the Wisp's **Access** tab.
- Nothing can be changed before the Wisp exists. Its name, soul, and model are
  changed afterward in its settings, and a template to reuse is made by saving
  that Wisp as one.
- Built-in templates improve with the app; a person who duplicated one keeps
  their copy as it was.
- The six starting souls stay in the soul picker as before; their text is
  shared with the built-in templates.

## Deferred

- Marking on a Wisp which template it came from and what changed since.
  That needs a new field on the Wisp record and a store upgrade.
- Starting memory and sample files in the workspace.
- Capturing an unlimited workspace size in a template. Using one never applies
  it, since unlimited is only chosen by hand after a note on what it means for
  the disk.

## Decisions taken with the user

- Templates are kept per environment, on the server, not on the device.
- Access from a template always starts off and needs the person to turn it on.
- **Use** creates the Wisp in one click, like a gallery of prepared Wisps, with
  no creation dialog and no step to review.
- Starting memory and sample files are left out of the first version.
- The section lives in Settings, as in the plan the user approved, and its
  look follows a card gallery the user shared.

## Rejected alternatives

- **Opening the creation dialog filled in:** it asked people who chose a
  prepared Wisp to review and configure it, which is what they wanted to skip.
- **Templates on the device**, in the app's preferences: they would not
  follow the person to the browser app or a phone, and would sit beside an
  environment they were not made for.
- **Copying built-in templates to the data directory on first run:** they
  would stop improving with the app, and the copies would look editable
  while meant as defaults.
- **Applying a template's access with the Wisp:** a template from someone
  else could then grant tools or skip approvals. Access is only asked for.
- **Capturing a Wisp on the server:** the app already reads every part of a
  Wisp's setup through existing operations, and the server checks the result
  when it is saved, so a new operation would add a second path to the same
  data.
