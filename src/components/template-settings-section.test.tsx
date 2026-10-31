import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_WISP_TEMPLATES } from "../../shared/builtin-wisp-templates";
import { parseWispTemplate, type WispTemplateEntry } from "../../shared/wisp-template";
import { TemplateSettingsSection } from "./template-settings-section";

const builtIns: WispTemplateEntry[] = BUILTIN_WISP_TEMPLATES.map(({ id, template }) => ({
  id,
  builtIn: true,
  template,
  updatedAt: null,
}));
const saved: WispTemplateEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  builtIn: false,
  updatedAt: "2026-10-27T12:00:00.000Z",
  template: {
    name: "Release Manager",
    role: "Releases",
    soul: "# Identity\nYou cut releases.",
    description: "Cuts the tag, writes the notes, and watches the rollout.",
    skills: [{ contents: "---\nname: write-notes\ndescription: Writes release notes.\n---\n1. Read the log.\n" }],
    access: {
      plugins: [{ pluginId: "linear", access: "write" }],
      mcpServers: [{ serverId: "github", name: "GitHub", access: "allow_all" }],
      allowEverything: true,
    },
  },
};

function install(overrides: Record<string, unknown> = {}) {
  const api = {
    listWispTemplates: vi.fn(async () => ({ ok: true as const, value: [...builtIns, saved] })),
    saveWispTemplate: vi.fn(async ({ contents, id }: { contents: string; id?: string }) => {
      const parsed = parseWispTemplate(contents);
      if (!parsed.ok) throw new Error(parsed.error);
      return {
        ok: true as const,
        value: {
          id: id ?? "22222222-2222-4222-8222-222222222222",
          builtIn: false,
          template: parsed.template,
          updatedAt: "now",
        },
      };
    }),
    deleteWispTemplate: vi.fn(async () => ({ ok: true as const, value: {} })),
    ...overrides,
  };
  Object.defineProperty(window, "wisp", { configurable: true, value: api });
  return api;
}

afterEach(() => {
  Reflect.deleteProperty(window, "wisp");
});

it("lists built-in and saved templates as cards, filtered by search and by who made them", async () => {
  const user = userEvent.setup();
  install();
  render(<TemplateSettingsSection />);

  expect(await screen.findByRole("button", { name: "Preview Atlas" })).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(builtIns.length + 1);
  expect(screen.getByText("Built in · Research · 1 skill")).toBeInTheDocument();
  expect(screen.getByText("Yours · Releases · 1 skill")).toBeInTheDocument();

  await user.type(screen.getByRole("textbox", { name: "Search templates" }), "rollout");
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  await user.clear(screen.getByRole("textbox", { name: "Search templates" }));

  await user.click(screen.getByRole("radio", { name: "Yours" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  await user.click(screen.getByRole("radio", { name: "Built in" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(builtIns.length);
});

it("previews everything a template sets up, saying the access it asks for is not granted", async () => {
  const user = userEvent.setup();
  install();
  render(<TemplateSettingsSection />);
  await user.click(await screen.findByRole("button", { name: "Preview Release Manager" }));

  expect(screen.getByRole("heading", { name: "Release Manager" })).toBeInTheDocument();
  expect(screen.getByText("You cut releases.")).toBeInTheDocument();
  expect(screen.getByText("write-notes")).toBeInTheDocument();
  expect(screen.getByText("Linear: read and write")).toBeInTheDocument();
  expect(screen.getByText("GitHub: use without asking")).toBeInTheDocument();
  expect(screen.getByText("Allow everything (risk mode)")).toBeInTheDocument();
  expect(screen.getByText(/Nothing here is granted by the template/)).toBeInTheDocument();
  expect(screen.getByText("Your default model", { exact: false })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "All templates" }));
  expect(screen.getByRole("textbox", { name: "Search templates" })).toBeInTheDocument();
});

it("keeps a built-in template to its preview, without saved templates' actions", async () => {
  const user = userEvent.setup();
  install();
  render(<TemplateSettingsSection />);
  await user.click(await screen.findByRole("button", { name: "Preview Atlas" }));

  for (const name of ["Duplicate", "Export", "Delete", "Rename"]) {
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  }
  expect(screen.queryByRole("textbox", { name: "Template name" })).not.toBeInTheDocument();
});

it("duplicates a saved template into an editable copy", async () => {
  const user = userEvent.setup();
  const api = install();
  render(<TemplateSettingsSection />);
  await user.click(await screen.findByRole("button", { name: "Preview Release Manager" }));
  await user.click(screen.getByRole("button", { name: "Duplicate" }));

  const [request] = api.saveWispTemplate.mock.calls[0]!;
  expect(request.id).toBeUndefined();
  expect(parseWispTemplate(request.contents)).toMatchObject({ ok: true, template: { name: "Release Manager copy" } });
  expect(await screen.findByRole("heading", { name: "Release Manager copy" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Template name" })).toHaveValue("Release Manager copy");
});

it("offers Import only among the person's own templates", async () => {
  const user = userEvent.setup();
  install();
  render(<TemplateSettingsSection />);
  await screen.findByRole("button", { name: "Preview Atlas" });
  expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("radio", { name: "Yours" }));
  expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
});

it("renames and deletes a saved template", async () => {
  const user = userEvent.setup();
  const api = install();
  render(<TemplateSettingsSection />);
  await user.click(await screen.findByRole("button", { name: "Preview Release Manager" }));

  const name = screen.getByRole("textbox", { name: "Template name" });
  await user.clear(name);
  await user.type(name, "Shipper");
  await user.click(screen.getByRole("button", { name: "Rename" }));
  expect(api.saveWispTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id }));
  expect(await screen.findByRole("heading", { name: "Shipper" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Delete" }));
  await user.click(screen.getByRole("button", { name: "Delete Shipper" }));
  expect(api.deleteWispTemplate).toHaveBeenCalledWith({ id: saved.id });
  expect(await screen.findByRole("textbox", { name: "Search templates" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Preview Shipper" })).not.toBeInTheDocument();
});

it("imports a template file as text and opens it, and reports one the server refuses", async () => {
  const user = userEvent.setup();
  const api = install();
  const { container } = render(<TemplateSettingsSection />);
  await screen.findByRole("button", { name: "Preview Atlas" });
  await user.click(screen.getByRole("radio", { name: "Yours" }));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

  const contents = JSON.stringify({ format: "wisp-template", version: 1, name: "Imported", role: "", soul: "" });
  await user.upload(input, new File([contents], "imported.wisp-template.json", { type: "application/json" }));
  expect(api.saveWispTemplate).toHaveBeenCalledWith({ contents });
  expect(await screen.findByRole("heading", { name: "Imported" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "All templates" }));
  api.saveWispTemplate.mockResolvedValueOnce({
    ok: false,
    error: { code: "invalid_request", message: "This is not a valid Wisp template.", retryable: false },
  } as never);
  // The grid, and its file input, is drawn again on the way back.
  await user.upload(
    container.querySelector<HTMLInputElement>('input[type="file"]')!,
    new File(["{"], "broken.json", { type: "application/json" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("This is not a valid Wisp template.");
});

it("exports a template as a file", async () => {
  const user = userEvent.setup();
  install();
  const createObjectURL = vi.fn(() => "blob:template");
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  try {
    render(<TemplateSettingsSection />);
    await user.click(await screen.findByRole("button", { name: "Preview Release Manager" }));
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(click).toHaveBeenCalledOnce();
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe("release-manager.wisp-template.json");
    const blob = (createObjectURL.mock.calls as unknown as [[Blob]])[0][0];
    expect(parseWispTemplate(await blob.text())).toEqual({ ok: true, template: saved.template });
  } finally {
    click.mockRestore();
  }
});

describe("Use", () => {
  const created = { status: "created", name: "Atlas", notices: [] } as const;

  it("is offered only when the section can create a Wisp", async () => {
    install();
    render(<TemplateSettingsSection />);
    await screen.findByRole("button", { name: "Preview Atlas" });
    expect(screen.queryByRole("button", { name: "Use Atlas" })).not.toBeInTheDocument();
  });

  it("creates a built-in template's Wisp at once and closes, without asking anything", async () => {
    const user = userEvent.setup();
    install();
    const onUseTemplate = vi.fn(async () => created);
    const onClose = vi.fn();
    render(<TemplateSettingsSection onUseTemplate={onUseTemplate} onClose={onClose} />);

    await user.click(await screen.findByRole("button", { name: "Use Atlas" }));

    expect(onUseTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: "builtin-research" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("creates only one Wisp while the first is being made", async () => {
    const user = userEvent.setup();
    install();
    let finish = (_result: typeof created) => undefined as void;
    const onUseTemplate = vi.fn(() => new Promise<typeof created>((resolve) => (finish = resolve)));
    render(<TemplateSettingsSection onUseTemplate={onUseTemplate} onClose={vi.fn()} />);

    const use = await screen.findByRole("button", { name: "Use Atlas" });
    await user.click(use);
    expect(use).toBeDisabled();
    expect(use).toHaveTextContent("Creating…");
    expect(screen.getByRole("button", { name: "Use Pip" })).toBeDisabled();
    await act(async () => finish(created));

    expect(onUseTemplate).toHaveBeenCalledOnce();
  });

  it("opens a saved template with skills before using it, so its content is approved", async () => {
    const user = userEvent.setup();
    install();
    const onUseTemplate = vi.fn(async () => ({ ...created, name: "Release Manager" }));
    render(<TemplateSettingsSection onUseTemplate={onUseTemplate} onClose={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Use Release Manager" }));
    expect(onUseTemplate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Release Manager" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use template" }));
    expect(onUseTemplate).toHaveBeenCalledWith(expect.objectContaining({ id: saved.id }));
  });

  it("stays open to say what still needs the person", async () => {
    const user = userEvent.setup();
    install();
    const notice = "Atlas asks for more access. Turn on what you want in its Access tab.";
    const onClose = vi.fn();
    render(
      <TemplateSettingsSection
        onUseTemplate={vi.fn(async () => ({ ...created, notices: [notice] }))}
        onClose={onClose}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Use Atlas" }));

    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open Atlas" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("leads to AI Model when no model can answer", async () => {
    const user = userEvent.setup();
    install();
    const onOpenModelSettings = vi.fn();
    render(
      <TemplateSettingsSection
        onUseTemplate={vi.fn(async () => ({ status: "needs_model" as const }))}
        onOpenModelSettings={onOpenModelSettings}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Use Atlas" }));
    await user.click(await screen.findByRole("button", { name: "Open AI Model" }));

    expect(onOpenModelSettings).toHaveBeenCalledOnce();
  });
});

it("explains that an older server has no templates", async () => {
  install({
    listWispTemplates: vi.fn(async () => ({
      ok: false as const,
      error: { code: "unsupported" as const, message: "x", retryable: false },
    })),
  });
  render(<TemplateSettingsSection />);
  expect(await screen.findByRole("alert")).toHaveTextContent("This server is older than this app and has no templates");
});
