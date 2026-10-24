import { expect, it } from "vitest";

import type { MemoryEntryView } from "../../shared/memory";
import { describeMemoryTextEdit, memoryTextLines, planMemoryTextEdit } from "./memory-text-edit";

function entry(id: string, text: string, scope: "user" | "wisp" = "wisp"): MemoryEntryView {
  return {
    id,
    scope,
    wispId: scope === "wisp" ? "lumi" : null,
    text,
    source: "owner",
    status: "active",
    replaces: null,
    observedAt: "2026-10-23T12:00:00.000Z",
    expiresAt: null,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
  };
}

const active = [entry("m1", "Uses Debian."), entry("m2", "Works on Wisp Bot."), entry("m3", "Shared.", "user")];

it("keeps unchanged lines, so they keep their IDs", () => {
  expect(planMemoryTextEdit("wisp", active, "Uses Debian.\nWorks on Wisp Bot.\n")).toEqual({
    operations: [],
    added: 0,
    removed: 0,
  });
});

it("turns an edited line into a removal and an addition, removals first", () => {
  const plan = planMemoryTextEdit("wisp", active, "Uses Debian.\nWorks on Wisp Bot and Aura.\nShips on Fridays.");
  expect(plan.operations).toEqual([
    { op: "remove", id: "m2" },
    { op: "add", scope: "wisp", text: "Works on Wisp Bot and Aura." },
    { op: "add", scope: "wisp", text: "Ships on Fridays." },
  ]);
  expect(describeMemoryTextEdit(plan)).toBe("2 added, 1 removed");
});

it("removes missing lines and touches only its own scope", () => {
  const plan = planMemoryTextEdit("wisp", active, "Works on Wisp Bot.");
  expect(plan.operations).toEqual([{ op: "remove", id: "m1" }]);
  expect(describeMemoryTextEdit(plan)).toBe("1 removed");
});

it("ignores blank lines, surrounding spaces and repeats", () => {
  expect(memoryTextLines("  a  \r\n\n b\na\n\n")).toEqual(["a", "b"]);
  const plan = planMemoryTextEdit("wisp", active, "Uses Debian.\n\n  Works on Wisp Bot.  \nUses Debian.");
  expect(plan.operations).toEqual([]);
  expect(describeMemoryTextEdit(plan)).toBe("No changes");
});
