# ADR 029: Verbose steps

- Status: Accepted
- Date: 2026-10-21
- Decision owners: Wisp product and security boundary
- Scope: What the steps in the chat show of a Wisp's commands and tool output
- Related: [ADR 003](003-wisp-session-report.md), [ADR 017](017-container-execution.md)

## Context

The chat shows each step of a turn with a summary built under the session
report's boundary (ADR 003): the workspace path, search or page a tool works
on, and for commands their purpose, the programs they ran, the exit code and
the duration. Command arguments and tool output never cross the bridge.

That is enough to follow a Wisp, not to work with one. A Wisp that builds,
tests or clones code (ADR 017) is debugged from what it ran and what came
back: which test failed, why `git push` was refused, what an edit did not
find. Without that, the person asks the Wisp to repeat its output, which costs
a turn and is only as good as the Wisp's retelling.

Others make the same trade with a switch. OpenClaw's `/verbose on` sends each
tool call with its arguments to the chat; Hermes Agent's `tool_progress`
setting chooses how much tool progress its gateway sends.

## Decision

Each Wisp has a **Verbose steps** choice, off by default, in its **Model** tab
under **In the chat**. While it is on, the steps of that Wisp's turns also
carry:

- for `run_command` and `process`, the command as the Wisp wrote it, without
  control characters and capped at 2,000 characters;
- when such a command ends, the end of its output: its last 40 lines, at most
  4,000 characters, without terminal escapes;
- when any step fails, the end of its error the same way.

The output of other tools that succeed, such as a file `read`, still never
crosses the bridge: verbose steps show what ran and what went wrong, not file
contents. Nothing is stored: the details live in the chat's state of the
latest turn and are gone after a restart. The session report keeps ADR 003's
boundary whatever the choice.

The choice applies to the Wisp's running agents, circles included, from the
next step on, without reloading their sessions. It is stored with the Wisp
(store version 14).

## Consequences

- Commands can carry secrets the Wisp was given, such as a token in a `git`
  URL. With verbose steps they show in the chat, on every device paired with
  the app. The setting says so; it is off unless chosen, and only for the Wisp
  it is chosen for.
- Output is cut to its end, which is where errors and summaries usually are.
  Anything longer is still the Wisp's to read and summarize.

## Alternatives considered

- **Always show commands and output:** simplest, but turns every Wisp's chat
  into a log and drops ADR 003's guarantee for people who never asked.
- **One switch for the whole app:** one Wisp for development and others for
  everyday questions is the common case; a per-Wisp choice keeps the others
  quiet.
- **Store the details with the reply:** the conversation would keep, and
  search, secrets and output that matter only while the turn is fresh and
  that the Wisp can produce again by rerunning the command.
