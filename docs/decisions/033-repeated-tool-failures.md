# ADR 033: Turns stop when a tool keeps failing the same way

- Status: Accepted
- Date: 2026-10-26
- Decision owners: Wisp maintainer, backend
- Scope: When a Wisp's turn ends because one tool keeps failing, and which
  members a circle hands the task to after a failure
- Related: [ADR 001](001-agent-runtime.md), [ADR 011](011-circles.md),
  [ADR 026](026-claude-code-runtime.md), SWE-239

## Context

Nothing stopped a turn in which the model called the same tool and got the
same error again and again: a revoked token, a server that is down, a file
that is not there. Each attempt is one more model call over the whole
context, and the turn goes on until the model gives up or the request's
ten-minute limit ends it.

Circles have a related waste. A member whose turn failed in a round can be
handed the task again by another member's mention, and it most likely fails
the same way. The limit of three handoffs (ADR 011) bounds a round, but not
this.

OpenMausBot's runtime contract stops a turn after three identical errors, or
after two continuations with no tool succeeding.

## Decision

**A Wisp's turn stops when the same tool fails with the same error three
times in a row.** The reply fails with a message that names the tool and the
error, and no further model call is made.

- `ToolLoopGuard` (`backend/tool-loop-guard.ts`) counts the turn's tool
  results. A failure of the same tool with the same error text adds one; a
  success, another tool, or another error starts the count over, since the
  model is then trying something different. A call that ended without a
  result, as when a turn is stopped, is ignored.
- `WispConversationAgent` feeds it the session's `tool_execution_end` events,
  which Pi sessions and Claude Code sessions both emit, and resets it with
  each message. At `MAX_REPEATED_TOOL_FAILURES` (3), it reports the failure
  as the turn's error and aborts the session.
- `PiEventTranslator` keeps a turn that already reported an error failed when
  the abort arrives, so it does not show as stopped by the person.
- The error is not retryable: asking again repeats the failure until the
  person fixes what the error names, such as a plugin's connection.

### Circles

**A member whose turn failed in a round is not handed the task again in that
round.** A later reply that mentions it skips it, without using one of the
three handoffs, and other mentioned members still answer. The member's failed
reply, already in the circle, says why; a second notice would repeat it.

## Consequences

- A Wisp stuck on a broken integration stops after three attempts, and the
  person reads what failed instead of waiting for the model to give up.
- A model that tries a tool three times with different inputs, getting the
  same error each time, is stopped as well. That error does not depend on the
  input, so a fourth try would not help.
- Parallel calls of one tool count in the order they end, so three of them
  failing the same way in one step also stop the turn.

## Deferred

- Job runs. Their sessions do not expose tool events yet; a run that loops is
  bounded by its 15-minute limit.
- Stopping after several model calls in which no tool succeeds, whatever the
  errors, as OpenMausBot does.
- Telling the model about the repeated failure and letting it answer once
  more, without tools, instead of ending the turn with an error.

## Decisions taken with the user

- Ship this part of SWE-239 on its own. The other part, not retrying a job
  run that acted outside Wisp, is held back: it counts every MCP call as an
  outside action, and the person's jobs only read through MCP, so they would
  lose their retries without being protected from anything.

## Rejected alternatives

- **Comparing the tool's input too.** A revoked token fails the same way for
  every input, and that is the common case.
- **A notice when a circle skips a handoff.** The member's failed reply is
  already there, and the notices the conversation shows are about the current
  turn.
- **Stopping only Pi sessions.** Claude Code sessions emit the same events, so
  the guard covers both at once.
