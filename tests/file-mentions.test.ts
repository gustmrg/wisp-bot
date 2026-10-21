import { describe, expect, it } from "vitest";

import { fileMentionRanges, fileMentionText, rankFilePaths } from "../shared/file-mentions.js";

function mentioned(text: string) {
  return fileMentionRanges(text).map(({ start, end, path }) => [text.slice(start, end), path]);
}

describe("file mentions", () => {
  it("finds the files a message mentions, leaving out the punctuation that closes its sentence", () => {
    expect(mentioned("Compare @docs/plan.md with @notes.txt.")).toEqual([
      ["@docs/plan.md", "docs/plan.md"],
      ["@notes.txt", "notes.txt"],
    ]);
    expect(mentioned("(see @LICENSE), then @src/app.ts!")).toEqual([
      ["@LICENSE", "LICENSE"],
      ["@src/app.ts", "src/app.ts"],
    ]);
  });

  it("reads a quoted path with spaces whole", () => {
    expect(mentioned('Read @"inbox/meeting notes.md".')).toEqual([
      ['@"inbox/meeting notes.md"', "inbox/meeting notes.md"],
    ]);
  });

  it("ignores an @ inside a word or with nothing after it", () => {
    expect(mentioned("Mail ada@example.com, or @ me, or @.")).toEqual([]);
  });

  it("quotes only paths with spaces", () => {
    expect(fileMentionText("docs/plan.md")).toBe("docs/plan.md");
    expect(fileMentionText("inbox/meeting notes.md")).toBe('"inbox/meeting notes.md"');
  });

  it("ranks paths by file name, then by path, then by anything they hold", () => {
    const paths = ["docs/plan.md", "planning/notes.md", "src/airplane.ts", "plan.md", "other.md"];
    expect(rankFilePaths(paths, "plan")).toEqual(["docs/plan.md", "plan.md", "planning/notes.md", "src/airplane.ts"]);
    expect(rankFilePaths(paths, '"PLAN', 2)).toEqual(["docs/plan.md", "plan.md"]);
  });
});
