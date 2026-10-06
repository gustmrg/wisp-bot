import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordLaunchVersion } from "../electron/backend/launch-version.js";

describe("recordLaunchVersion", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "wisp-launch-version-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reports the previous version only on the first launch after it changes", async () => {
    const file = path.join(directory, "last-launch-version");
    await expect(recordLaunchVersion(file, "1.0.0")).resolves.toBeUndefined();
    await expect(recordLaunchVersion(file, "1.0.0")).resolves.toBeUndefined();
    await expect(recordLaunchVersion(file, "1.1.0")).resolves.toBe("1.0.0");
    await expect(recordLaunchVersion(file, "1.1.0")).resolves.toBeUndefined();
    await expect(readFile(file, "utf8")).resolves.toBe("1.1.0\n");
  });
});
