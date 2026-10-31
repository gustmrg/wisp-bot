import { describe, expect, it } from "vitest";

import microsoftLogo from "@/assets/model-labs/microsoft.svg";
import openrouterLogo from "@/assets/providers/openrouter.svg";
import { providerLogo } from "@/lib/provider-logo";

describe("providerLogo", () => {
  it("shows the service, not the lab whose models it serves", () => {
    expect(providerLogo("azure")).toBe(microsoftLogo);
    expect(providerLogo("openrouter")).toBe(openrouterLogo);
  });

  it("uses one logo for a service's regional and plan variants", () => {
    expect(providerLogo("minimax-cn")).toBe(providerLogo("minimax"));
    expect(providerLogo("xiaomi-token-plan-sgp")).toBe(providerLogo("xiaomi"));
  });

  it("has no logo for a provider this app does not know", () => {
    expect(providerLogo("radius")).toBeUndefined();
    expect(providerLogo("constructor")).toBeUndefined();
  });
});
