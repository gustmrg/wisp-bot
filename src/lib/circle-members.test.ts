import { describe, expect, it } from "vitest";

import type { ChatCollection } from "@/chat-data";
import { migrateLegacyChats } from "@/lib/circle-members";

function legacyChats(memberIds?: string[]): ChatCollection {
  return {
    chief: {
      id: "chief",
      name: "Chief",
      label: "Assistant",
      description: "Coordinates work",
      shape: "circle",
      isCircle: false,
      notifyOnUpdatesEnabled: true,
      preview: "Ready",
      timestamp: "Now",
      messages: [],
    },
    offsite: {
      id: "offsite",
      name: "Offsite",
      label: "Channel",
      description: "Legacy circle",
      shape: "circle",
      isCircle: undefined,
      isGroup: true,
      memberIds,
      notifyOnUpdatesEnabled: true,
      preview: "Planning",
      timestamp: "Now",
      messages: [],
    },
  } as unknown as ChatCollection;
}

describe("migrateLegacyChats", () => {
  it("migrates isGroup records and supplies bundled legacy members", () => {
    const migrated = migrateLegacyChats(legacyChats());

    expect(migrated.offsite).toMatchObject({
      isCircle: true,
      label: "Circle",
      memberIds: ["chief"],
    });
    expect(migrated.offsite).not.toHaveProperty("isGroup");
  });

  it("preserves an explicitly empty circle", () => {
    expect(migrateLegacyChats(legacyChats([])).offsite?.memberIds).toEqual([]);
  });
});
