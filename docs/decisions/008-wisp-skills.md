# ADR 008: Per-Wisp skills

- Status: Accepted
- Date: 2026-10-04
- Decision owners: Wisp product and security boundary
- Scope: Reusable procedures a Wisp saves at the user's request and follows later
- Related: [Context and memory](../context-and-memory.md), [security](../security.md)

## Decision

Each Wisp can keep its own skills: reusable procedures in the
[Agent Skills](https://agentskills.io/specification) folder format
(`<name>/SKILL.md` with `name` and `description` frontmatter). A skill is
created only when the user asks the Wisp to save a workflow, and only after the
user approves its exact content. Skills are never shared between Wisps, and the
Wisp never saves one on its own initiative.

Pi's own skill discovery stays disabled (`noSkills: true`). Pi would tell the
model to load a skill with the `read` tool, which cannot reach outside the
workspace, and putting skills inside the workspace would let ordinary file
edits, including auto-approved ones, rewrite standing instructions.

## Storage

Skills live in `pi-config/<sessionId>/skills/`, beside the Wisp's other
configuration and outside its workspace. File tools cannot reach them. Writes
go through the backend `SkillStore`, which validates names (lowercase letters,
numbers, single hyphens, up to 64 characters), descriptions (up to 1,024
characters), and instructions (up to 16,000 characters), and caps a Wisp at 50
skills. Files the user edits by hand are read again on every run; malformed,
oversized, or symlinked skills are skipped.

## Runtime

- The system prompt explains skills and tells the Wisp to save one only when
  asked, writing general steps rather than a transcript.
- Before each run, an index of the Wisp's skills (name and description) is
  appended to the system prompt, so saved and edited skills apply from the next
  message without a session rebuild.
- `use_skill` returns a skill's full instructions, labeled as user-provided
  context subject to the operating boundaries. Skills never grant tools; the
  `allowed-tools` field is ignored.
- `save_skill` creates or replaces a skill under the `save_skill` category.
  It always asks: policy rules and auto-review cannot allow it, and the approval
  card offers only **Allow once** or **Deny**. The card shows the exact
  instructions that will be saved.

## User controls

**Wisp settings → General → Skills** lists the skills with their instructions,
deletes them after confirmation, and opens the skills folder for hand editing.

## Deferred

Suggesting skills when the Wisp notices a repeated workflow, periodic review of
existing skills, skills shared between Wisps, and bundled scripts or reference
files inside a skill folder.
