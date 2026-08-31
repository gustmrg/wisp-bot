import { describe, expect, it } from "vitest";

import { sanitizeBackendError, WispBackendError } from "../electron/backend/backend-error.js";

describe("sanitizeBackendError", () => {
  it("preserves intentional public backend errors", () => {
    expect(sanitizeBackendError(new WispBackendError(
      "invalid_configuration",
      "Choose a supported model.",
    ))).toEqual({
      code: "invalid_configuration",
      message: "Choose a supported model.",
      retryable: false,
    });
  });

  it("does not expose unknown error messages or secrets", () => {
    const result = sanitizeBackendError(new Error("Provider failed with secret-api-key"));
    expect(result).toEqual({
      code: "internal_error",
      message: "The backend could not complete the request.",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-api-key");
  });
});
