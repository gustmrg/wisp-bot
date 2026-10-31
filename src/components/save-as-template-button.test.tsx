import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { DEFAULT_WISP_APPEARANCE } from "../../shared/wisp-appearance";
import { parseWispTemplate } from "../../shared/wisp-template";
import { SaveAsTemplateButton } from "./save-as-template-button";

const wisp = { id: "w1", name: "Atlas", role: "Research", soul: "# Atlas", appearance: DEFAULT_WISP_APPEARANCE };
const unsupported = async () => ({ ok: false as const, error: { code: "unsupported", message: "x" } });

function install(saveWispTemplate: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "wisp", {
    configurable: true,
    value: {
      getConversationModel: unsupported,
      listSkills: unsupported,
      getWorkspace: unsupported,
      getWispExecution: unsupported,
      getWispToolPolicy: unsupported,
      getWispPluginAccess: unsupported,
      getWispMcpAccess: unsupported,
      getMcpSettings: unsupported,
      saveWispTemplate,
    },
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "wisp");
});

it("saves the Wisp among the templates and says so", async () => {
  const user = userEvent.setup();
  const saveWispTemplate = vi.fn(async () => ({ ok: true as const, value: {} }));
  install(saveWispTemplate);
  render(<SaveAsTemplateButton conversationId="c1" wisp={wisp} />);

  await user.click(screen.getByRole("button", { name: "Save as template" }));

  expect(await screen.findByRole("status")).toHaveTextContent("Atlas was saved as a template.");
  expect(screen.getByRole("button", { name: "Saved to Templates" })).toBeVisible();
  const [request] = saveWispTemplate.mock.calls[0] as unknown as [{ contents: string }];
  expect(parseWispTemplate(request.contents)).toEqual({
    ok: true,
    template: { name: "Atlas", role: "Research", soul: "# Atlas", appearance: DEFAULT_WISP_APPEARANCE },
  });
});

it("reports a server that refuses the template", async () => {
  const user = userEvent.setup();
  install(
    vi.fn(async () => ({
      ok: false as const,
      error: { code: "invalid_request", message: "You can keep at most 200 templates.", retryable: false },
    })),
  );
  render(<SaveAsTemplateButton conversationId="c1" wisp={wisp} className="row" />);
  await user.click(screen.getByRole("button", { name: "Save as template" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("You can keep at most 200 templates.");
  expect(screen.getByRole("button", { name: "Could not save template" })).toBeVisible();
});
