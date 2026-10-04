import { describe, expect, it } from "vitest";

import type { AiSettingsView } from "../shared/contracts.js";
import { missingModelSetup, missingSetup } from "../shared/setup-status.js";
import { EMPTY_USER_PROFILE } from "../shared/user-profile.js";

function view(selection: AiSettingsView["selection"], credentialConfigured: boolean): AiSettingsView {
  return {
    selection,
    secureStorageAvailable: true,
    providers: [{ id: "openrouter", name: "OpenRouter", credentialConfigured, models: [] }],
    catalogError: null,
  };
}

const selection = { providerId: "openrouter", modelId: "test-model" };

describe("missingSetup", () => {
  it("requires a name, a default model and a saved provider key", () => {
    expect(missingSetup(EMPTY_USER_PROFILE, view(null, false))).toEqual(["profile-name", "default-model"]);
    expect(missingSetup({ ...EMPTY_USER_PROFILE, preferredName: "  " }, view(selection, false))).toEqual([
      "profile-name",
      "provider-credential",
    ]);
    expect(missingSetup({ ...EMPTY_USER_PROFILE, preferredName: "Ada" }, view(selection, true))).toEqual([]);
  });

  it("treats a default whose provider is no longer offered as missing", () => {
    expect(missingModelSetup(view({ providerId: "gone", modelId: "test-model" }, true))).toEqual(["default-model"]);
  });
});
