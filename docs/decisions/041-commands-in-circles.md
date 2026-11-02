# ADR 041: Commands in circles

- Status: Accepted
- Date: 2026-11-01
- Decision owners: Wisp maintainer, backend and security boundary
- Scope: How a circle's members run commands in its shared workspace
- Related: [ADR 011](011-circles.md), [ADR 017](017-container-execution.md),
  [ADR 026](026-claude-code-runtime.md), [security](../security.md)

## Context

A circle's members share one workspace, but none of them can run commands
there. Commands run only in a Wisp's own conversation
(`ExecutionService.getSnapshot`), because a Wisp's container mounts only its
own workspace. So a circle cannot build, test, or push: one member cannot
finish development and have another push the branch and open the pull request.
The GitHub plugin works in a circle and can open a pull request, but only for
a branch that already reached GitHub.

Adding the circle's workspace to a Wisp's existing container is not an option.
That container also serves the Wisp's own conversation, which would then reach
the files of every circle the Wisp is in.

## Decision

**Commands in a circle run in one container per member, each mounting the
circle's workspace.** Nothing runs outside a container.

- **Turning it on:** a member runs commands only when its **Run commands**
  setting is on and the circle allows commands. The circle's setting, in its
  **Workspace** tab, is off by default, so existing circles do not gain commands
  in an update. It is a file in the circle's config directory, outside the
  workspace, so a member cannot change it and the database does not change. A
  turn in progress holds its tools, so each call reads the setting again.
- **What comes from the Wisp:** **Image**, **Allow local network**, the git
  access of the plugins it can use, and its Block rules.
- **What comes from the circle:** the files, mounted at `/workspace`, and the
  workspace size.
- **The container:** one per pair of circle and member, created on that member's
  first command there, with the confinement of ADR 017. It is separate from the
  Wisp's own container: a repository cloned in the Wisp's own conversation does
  not appear in the circle, and the circle's work happens in one clone there.
- **Home folder:** each member has its own under `/workspace/.home`, so git
  configuration and installed tools do not collide. It keeps work apart and is
  not a security boundary.
- **Removed when idle:** after 30 minutes without a command, the container and
  its network are removed rather than stopped. This loses nothing a stop would
  keep, since the root is read-only and `/tmp` and processes end either way, and
  it stops idle pairs from holding networks, of which Docker's default address
  pools allow a limited number. Containers left stopped when the server stopped
  are removed at its next start, since the timers ended with it.
- **Package cache:** the circle's members share one, such as `/workspace/.cache`,
  so each one does not download the same packages. It counts toward the
  workspace size.
- **Cleanup:** removing a member, deleting a circle, or turning the circle's
  setting off removes the containers and networks involved, through
  `ContainerManager.reconcile`, and changing a Wisp's container settings removes
  all of its containers. A Wisp's own containers are not recreated by this.
- **Turns stay sequential:** this ADR changes nothing in ADR 011's turn order.

## Consequences

- A circle can do development work, with one member committing and another
  pushing from the same clone.
- Each member keeps its own limits in normal use: a member without access to the
  GitHub plugin cannot push.
- **Accepted risk:** the separate containers do not isolate members from each
  other, because they share files. A member can leave a script or git hook that
  runs with another member's git and network access when that member runs it.
  People in a circle with commands trust its members with each other's access.
  The circle's setting says so when it is turned on.
- Commands are not reviewed like file changes, so a member can change or delete
  another's work without a card; git history is the main protection.
- A background process keeps running during later turns and can change files.
  One Wisp at a time no longer means one writer in the workspace.
- The first command after an idle period takes longer, because the container and
  its network are created again.

## Deferred

- **Revisit one container for the whole circle.** The maintainer wants to review
  this choice later. One container is simpler and lets members share dev servers
  and installed tools. Look at it again once real use shows how many containers
  and networks circles hold, how much memory they use, and whether members need
  different images or network access. See the rejected alternative below for what
  it costs today.
- **Members working at the same time.** Per-member containers are ready for it,
  which would need a limit on how many run at once. It also requires its own
  decision, since ADR 011 keeps turns sequential.
- **A project folder shared across conversations**, for continuing the same work
  in a Wisp's own conversation and in a circle.

## Decisions taken with the user

- One container per member, not one for the circle, to be reviewed later.
- Idle containers and networks are removed, the package cache is shared, and
  simultaneous work will have a limit once it exists.

## Rejected alternatives

- **One container for the whole circle (for now; see Deferred):** it costs fewer
  containers and networks and caps memory at one limit, with the same
  confinement, and **Run commands** and Block rules would still apply per Wisp.
  But a container has one image and one network, so **Image** and **Allow local
  network** would become the circle's settings, against ADR 011's rule that a
  Wisp keeps its own permissions. The git gateway tells Wisps apart by their
  network, so telling it which token to use before each command would be the only
  way to keep tokens apart, which background processes and simultaneous work
  defeat.
- **Running commands directly in the workspace, on the server:** ADR 017 forbids
  it.
- **Adding the circle's workspace to the Wisp's own container:** see Context.
- **A circle using a Wisp's workspace:** it would expose that Wisp's private
  files, and deleting the Wisp would affect the circle.
