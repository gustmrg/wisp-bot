import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CircleResponderPicker } from "@/components/circle-responder-picker";
import type { AuxiliaryModelView } from "../../shared/contracts";

function setUp(decision?: AuxiliaryModelView) {
  const getAiSettings = vi.fn(async () => ({
    ok: true as const,
    value: { auxiliary: { imageUnderstanding: { selection: null, unavailable: null }, decision } },
  }));
  Object.defineProperty(window, "wisp", { configurable: true, value: { getAiSettings } });
}

const JEV = { providerId: "typesafe", modelId: "jev-latest" };

describe("CircleResponderPicker", () => {
  it("offers the decision model once one can be used", async () => {
    setUp({ selection: JEV, unavailable: null });
    const onChange = vi.fn();
    render(<CircleResponderPicker value="lead" onChange={onChange} />);
    const option = screen.getByRole("radio", { name: "Decision model" });

    await waitFor(() => expect(option).toBeEnabled());
    await userEvent.setup().click(option);

    expect(onChange).toHaveBeenCalledWith("auto");
    expect(screen.queryByText(/Choose a decision model/)).not.toBeInTheDocument();
  });

  it("points to settings while no decision model is chosen", async () => {
    setUp({ selection: null, unavailable: null });
    render(<CircleResponderPicker value="lead" onChange={vi.fn()} />);

    expect(await screen.findByText(/Choose a decision model in Settings → AI Model/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Decision model" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Lead" })).toBeChecked();
  });

  it("says the lead answers when a circle's decision model stopped being usable, and lets it go back", async () => {
    setUp({ selection: JEV, unavailable: "missing_key" });
    const onChange = vi.fn();
    render(<CircleResponderPicker value="auto" onChange={onChange} />);

    expect(await screen.findByText(/No decision model can be used now, so the lead answers/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Decision model" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Lead" })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Lead" }));

    expect(onChange).toHaveBeenCalledWith("lead");
  });

  it("does not offer it on a server without decision models", async () => {
    setUp();
    render(<CircleResponderPicker value="lead" onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: "Decision model" })).toBeDisabled());
  });
});
