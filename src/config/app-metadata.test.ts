import { describe, expect, it } from "vitest";

import packageMetadata from "../../package.json";
import { APP_METADATA, packageDisplayName } from "@/config/app-metadata";

describe("application metadata", () => {
  it("uses package.json as the build-time source", () => {
    expect(APP_METADATA).toEqual({
      displayName: packageDisplayName(packageMetadata.name),
      packageName: packageMetadata.name,
      version: packageMetadata.version,
    });
  });

  it("formats package identifiers for display", () => {
    expect(packageDisplayName("example_desktop-app")).toBe("Example Desktop App");
  });
});
