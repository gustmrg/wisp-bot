# ADR 024: Wisps that manage Wisps, and Chief

- Status: Accepted
- Date: 2026-10-18
- Decision owners: Wisp product, backend and security boundary
- Scope: Tools that create, change and delete Wisps; the Wisp created at
  onboarding; what an empty conversation offers
- Related: [ADR 008](008-wisp-skills.md), [ADR 010](010-wisp-entity.md),
  [ADR 019](019-scheduled-jobs.md), [ADR 023](023-wisp-permissions.md),
  [security](../security.md), SWE-175

## Context

After onboarding the app was empty: the person had to open the create form
once per Wisp and write each soul themselves. People who do not yet know what
a Wisp is good for have no help deciding which ones to make.

A Wisp could not act on other Wisps. Its only app-owned tools were workspace
files, skills and jobs.

## Decision

**Every Wisp can manage the person's Wisps, the person approves every change,
and onboarding starts the person with Chief, an ordinary Wisp whose soul
builds the team.**

### Wisp tools for every Wisp

Managing Wisps is part of the app, like skills and jobs, not an external
integration, so it needs no grant. Every Wisp gets:

- `list_wisps`: names, roles and IDs, or one Wisp's soul in full;
- `create_wisp`: name, role, soul, and optionally a palette color and a body;
- `update_wisp`: only the fields that change;
- `delete_wisp`: the Wisp, its conversation, files, skills and jobs.

A new Wisp gets its own conversation with notifications on and the app's
default model, as the create form's defaults do.

### The person approves every change

The changes go through a new category, `manage_wisp`, treated like
`save_skill` and `schedule_job`:

- it always asks: no rule, auto-review setting or **Allow everything**
  allows it, and its card offers only allowing once or denying;
- the card shows the name, role and soul of a new Wisp, or what an update
  changes; a deletion's card repeats the warning of **Delete Wisp** in the
  Wisp's settings and its button says **Confirm deletion**;
- job runs never get the tools, and an unattended run refuses the category.

A soul becomes another agent's standing instructions, so a Wisp misled by
content it read must not be able to rewrite one unseen; and a deletion cannot
be undone.

A Wisp cannot change or delete itself. Either would rebuild or remove the
session answering the request; the person does it in the Wisp's settings.

### Every device sees the change

`createWisp`, `updateWisp` and `deleteWisp` push the Wisps and every
conversation's summary (`wispsChanged`) to every connected device. A Wisp
made by another Wisp, or on another device, appears without reloading.

### Chief

Chief is not a type, a flag or a column: it is a Wisp with a soul written for
building the team. When onboarding finishes and the person has no Wisps,
the app creates Chief and opens its conversation. It is created once per
onboarding, so one the person deleted is not created again, and a person
who already has Wisps never gets one.

### What an empty conversation offers

An empty conversation shows the Wisp's avatar, name and role, then up to four
suggested first messages that send when tapped. The suggestions are fixed in
the app, in English like the rest of the interface; the reply's language
follows the person's profile. When the person has a single Wisp, as right
after onboarding, the first two suggest building a team of Wisps or creating
an assistant Wisp. The soul's first paragraph is no longer shown there.

An empty circle shows its members, name and description in a neutral color,
with suggestions of its own, also fixed in the app. The Wisp suggestions do
not fit there: a circle has no jobs, only one member answers a question about
connecting a service, and the person still has to learn who answers. So the
circle's suggestions ask what the team can do, mention a member other than the
lead, ask where to start when the circle has a description, and ask to split a
task. None mentions every member, since one tap would pay for a reply from
each. A new circle starts with no messages, like a Wisp. Circles created
earlier keep a stored line that marks their beginning, which the introduction
replaces until the first message.

## Consequences

- A new person can describe what they need and get a team of Wisps with
  written souls, approving each one.
- Any Wisp can propose Wisps, and every change costs one card.
- Suggestions are the same for every Wisp. Per-Wisp suggestions would need
  storage, and a section in the soul would make the soul carry text for a
  screen the model never sees.

## Rejected alternatives

- **A Chief type, flag or column, with tools only it has:** Chief would be a
  special case the person cannot recreate or reproduce, and every Wisp is
  equally able to write a soul.
- **A per-Wisp grant for the Wisp tools:** grants gate external services;
  these tools change only the person's own app, and the card already gates
  every change.
- **Deleting without a card when the person asked in the chat:** the request
  in the chat is model input; only the card is the person's decision.
- **Suggestions in the soul or in a file per Wisp:** both store text that only
  the empty conversation shows.
