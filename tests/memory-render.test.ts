import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  exportMemoryMarkdown,
  MemoryStore,
  renderMemoryForPrompt,
  splitLegacyMemory,
} from "../backend/memory/index.js";

function storeWith(user: string[], wisp: string[]) {
  const store = MemoryStore.open(new DatabaseSync(":memory:"), { now: () => new Date("2026-10-23T12:00:00.000Z") });
  const context = { wispId: "lumi", source: "owner" } as const;
  store.apply(
    [
      ...user.map((text) => ({ op: "add" as const, scope: "user" as const, text })),
      ...wisp.map((text) => ({ op: "add" as const, scope: "wisp" as const, text })),
    ],
    context,
  );
  return store;
}

describe("renderMemoryForPrompt", () => {
  it("shows USER.md then MEMORY.md, with IDs and each scope's use", () => {
    const store = storeWith(["Prefers short answers."], ["Main project is Wisp Bot.", "Ships on Fridays."]);
    expect(renderMemoryForPrompt(store.active("lumi"), store.usage("lumi"))).toBe(
      [
        "### USER.md · 1% of 1,500 characters",
        "- [m1] Prefers short answers.",
        "",
        "### MEMORY.md · 1% of 4,000 characters",
        "- [m2] Main project is Wisp Bot.",
        "- [m3] Ships on Fridays.",
      ].join("\n"),
    );
  });

  it("still shows both blocks when memory is empty", () => {
    const store = storeWith([], []);
    expect(renderMemoryForPrompt(store.active("lumi"), store.usage("lumi"))).toBe(
      ["### USER.md · 0% of 1,500 characters", "(empty)", "", "### MEMORY.md · 0% of 4,000 characters", "(empty)"].join(
        "\n",
      ),
    );
  });

  it("gives the same text for the same memory", () => {
    const store = storeWith(["A"], ["B"]);
    const render = () => renderMemoryForPrompt(store.active("lumi"), store.usage("lumi"));
    expect(render()).toBe(render());
  });
});

describe("exportMemoryMarkdown", () => {
  it("writes one scope as a file without IDs", () => {
    const store = storeWith(["Prefers short answers."], ["Main project is Wisp Bot."]);
    expect(exportMemoryMarkdown("user", store.active("lumi"))).toBe("# USER.md\n\n- Prefers short answers.\n");
    expect(exportMemoryMarkdown("wisp", store.active("lumi"))).toBe("# MEMORY.md\n\n- Main project is Wisp Bot.\n");
    expect(exportMemoryMarkdown("wisp", [])).toBe("# MEMORY.md\n");
  });
});

describe("splitLegacyMemory", () => {
  it("makes an entry of each line or bullet, without markers, blanks or repeats", () => {
    expect(
      splitLegacyMemory(
        "Prefers pt-BR.\r\n\n- Uses Debian.\n  * Has a Raspberry Pi.\n1. First.\n2) Second.\n• Dot.\n+ Plus.\nPrefers pt-BR.\n",
      ),
    ).toEqual(["Prefers pt-BR.", "Uses Debian.", "Has a Raspberry Pi.", "First.", "Second.", "Dot.", "Plus."]);
  });

  it("drops invisible characters but keeps text that only looks like a marker", () => {
    expect(splitLegacyMemory("zero\u200Bwidth\n-5 degrees outside\n2026 was busy")).toEqual([
      "zerowidth",
      "-5 degrees outside",
      "2026 was busy",
    ]);
  });

  it("gives nothing for empty text", () => {
    expect(splitLegacyMemory("")).toEqual([]);
    expect(splitLegacyMemory("\n  \n")).toEqual([]);
  });
});
